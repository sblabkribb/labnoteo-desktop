// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { labnoteMarkdown } from '../../markdownSyntax';
import { livePreview } from '../index';
import { IMAGE_EXTS, isImageTarget, parseSize, pickByName, resolveImagePath, splitAltSize } from '../imagePath';
import { createImageCache } from '../imageCache';
import { createImageIndex, createVaultImages, MISS_RELIST_MS, type VaultImages } from '../vaultImages';
import { imageLoader } from '../imageWidget';

// jsdom 에는 레이아웃이 없다. CodeMirror 가 측정에 쓰는 API 만 빈 값으로 채운다.
const emptyRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
Range.prototype.getClientRects ??= emptyRects;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();

type ReadFn = (path: string) => Promise<ArrayBuffer>;
type ListFn = () => Promise<string[]>;

let read: ReturnType<typeof vi.fn<ReadFn>>;
let current: VaultImages | null = null;
let list: ReturnType<typeof vi.fn<ListFn>>;
let urls: { create: ReturnType<typeof vi.fn<(b: Blob) => string>>; revoke: ReturnType<typeof vi.fn<(u: string) => void>> };
const views: EditorView[] = [];

function images(): VaultImages {
  current = createVaultImages(createImageCache(read, urls), createImageIndex(list));
  return current;
}

/** 'exp/wf.labnote.md' 노트를 연 라이브 미리보기 편집기. */
function view(doc: string, pos: number): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const v = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor: Math.min(pos, doc.length) },
      extensions: [
        EditorState.lineSeparator.of('\n'),
        labnoteMarkdown(),
        livePreview(),
        imageLoader.of({ notePath: 'exp/wf.labnote.md', images: images() }),
      ],
    }),
  });
  views.push(v);
  return v;
}

const lineEl = (v: EditorView, n: number) => v.contentDOM.querySelectorAll<HTMLElement>('.cm-line')[n - 1];
const visibleText = (v: EditorView, n: number) => lineEl(v, n).textContent;
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  read = vi.fn<ReadFn>(async () => new ArrayBuffer(1));
  list = vi.fn<ListFn>(async () => ['a.png', 'exp/images/scans/LN-1.jpg']);
  urls = { create: vi.fn((_b: Blob) => 'blob:x'), revoke: vi.fn((_u: string) => {}) };
});
afterEach(() => {
  while (views.length) views.pop()!.destroy();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('image paths', () => {
  it('rejects encoded traversal before IPC', async () => {
    expect(resolveImagePath('e/n.md', '%2e%2e/%2e%2e/x.png', 'md')).toBeNull();
    const v = view('![x](%2e%2e/%2e%2e/x.png)\n\nx', 30);
    await flush();
    expect(v.contentDOM.querySelector('.lno-image-missing')).not.toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it('rejects absolute, drive and UNC targets', () => {
    expect(resolveImagePath('n.md', 'C:/x.png', 'md')).toBeNull();
    expect(resolveImagePath('n.md', '//srv/x.png', 'md')).toBeNull();
    expect(resolveImagePath('n.md', String.raw`\\srv\x.png`, 'md')).toBeNull();
    expect(resolveImagePath('n.md', '/x.png', 'md')).toBeNull();
    expect(resolveImagePath('n.md', 'https://x/a.png', 'md')).toBeNull();
    expect(resolveImagePath('n.md', String.raw`C:\x.png`, 'wiki')).toBeNull();
  });

  it('a relative md path gives note-relative then vault-relative candidates', () => {
    expect(resolveImagePath('exp/n.md', 'images/a%20b.png', 'md')).toEqual({ kind: 'paths', candidates: ['exp/images/a b.png', 'images/a b.png'] });
    expect(resolveImagePath('n.md', 'a.png', 'md')).toEqual({ kind: 'paths', candidates: ['a.png'] });
    expect(resolveImagePath('exp/n.md', 'sub/x.png', 'wiki')).toEqual({ kind: 'paths', candidates: ['exp/sub/x.png', 'sub/x.png'] });
  });

  it('wiki targets try the literal name first, then the decoded one, still refusing decoded traversal', () => {
    expect(resolveImagePath('n.md', 'a%20b.png', 'wiki')).toEqual({ kind: 'name', name: 'a%20b.png', fallback: 'a b.png' });
    expect(resolveImagePath('exp/n.md', 'sub/a%20b.png', 'wiki')).toEqual({
      kind: 'paths',
      candidates: ['exp/sub/a%20b.png', 'sub/a%20b.png', 'exp/sub/a b.png', 'sub/a b.png'],
    });
    expect(resolveImagePath('e/n.md', '%2e%2e/%2e%2e/x.png', 'wiki')).toBeNull();
    expect(resolveImagePath('n.md', '%2Fx.png', 'wiki')).toBeNull();
  });

  it('a wiki name that is literally percent-encoded is found under that name', async () => {
    list = vi.fn<ListFn>(async () => ['a%20b.png', 'a b.png']);
    const v = view('![[a%20b.png]]\n\nx', 17);
    await flush();
    await flush();
    expect(read).toHaveBeenCalledWith('a%20b.png');
    expect(v.contentDOM.querySelector('img.lno-image')).not.toBeNull();
  });

  it('bare-name scan embed resolves under images/scans', () => {
    expect(resolveImagePath('exp/wf.labnote.md', 'LN-7K3M9QX2_u3_p2_20261015.jpg', 'wiki')).toEqual({ kind: 'name', name: 'LN-7K3M9QX2_u3_p2_20261015.jpg' });
    expect(pickByName('exp/wf.labnote.md', 'LN-7K3M9QX2_u3_p2_20261015.jpg', ['exp/images/scans/LN-7K3M9QX2_u3_p2_20261015.jpg', 'a.md'])).toBe(
      'exp/images/scans/LN-7K3M9QX2_u3_p2_20261015.jpg',
    );
  });

  it('a bare name with two matches picks the note folder, then the shortest path', () => {
    expect(pickByName('exp/n.md', 'g.png', ['attachments/deep/g.png', 'exp/g.png'])).toBe('exp/g.png');
    expect(pickByName('other/n.md', 'g.png', ['attachments/deep/g.png', 'b/g.png'])).toBe('b/g.png');
    expect(pickByName('other/n.md', 'G.PNG', ['b/g.png'])).toBe('b/g.png');
    expect(pickByName('other/n.md', 'z.png', ['b/g.png'])).toBeNull();
  });

  it('isImageTarget checks the extension, ignoring case and fragments', () => {
    expect(isImageTarget('a/B.PNG')).toBe(true);
    expect(isImageTarget('x.svg#frag')).toBe(true);
    expect(isImageTarget('Other note')).toBe(false);
    expect(isImageTarget('a.html')).toBe(false);
  });

  it('size syntax: |W, |WxH and alt|W', () => {
    expect(parseSize('200')).toEqual({ width: 200 });
    expect(parseSize('200x100')).toEqual({ width: 200, height: 100 });
    expect(parseSize('wide')).toBeNull();
    expect(splitAltSize('gel|300')).toEqual({ alt: 'gel', size: { width: 300 } });
    expect(splitAltSize('gel')).toEqual({ alt: 'gel', size: null });
    expect(splitAltSize('300')).toEqual({ alt: '', size: { width: 300 } });
  });

  it('IMAGE_EXTS matches fs.rs', () => {
    const rs = readFileSync('src-tauri/src/vault/fs.rs', 'utf-8');
    expect(rs).toContain(`pub const IMAGE_EXTS: &[&str] = &[${IMAGE_EXTS.map((e) => `"${e}"`).join(', ')}];`);
  });
});

describe('image cache', () => {
  it('an .svg path produces a Blob of type image/svg+xml', async () => {
    await createImageCache(async () => new ArrayBuffer(4), urls).url('a/b.svg');
    expect((urls.create.mock.calls[0][0] as Blob).type).toBe('image/svg+xml');
  });

  it('the cache revokes URLs on clear and on LRU eviction, never while still referenced', async () => {
    const c = createImageCache(async () => new ArrayBuffer(1), urls);
    for (let i = 0; i < 65; i++) {
      await c.url(`${i}.png`);
      if (i > 0) c.release(`${i}.png`);
    }
    expect(urls.revoke).toHaveBeenCalledTimes(1); // 1.png evicted; 0.png still referenced
    c.clear();
    expect(urls.revoke).toHaveBeenCalledTimes(65);
  });

  it('reads a path once while cached and again after invalidate', async () => {
    const r = vi.fn<ReadFn>(async () => new ArrayBuffer(1));
    const c = createImageCache(r, urls);
    await c.url('a.png');
    await c.url('a.png');
    expect(r).toHaveBeenCalledTimes(1);
    c.invalidate('a.png');
    expect(urls.revoke).toHaveBeenCalledTimes(1);
    await c.url('a.png');
    expect(r).toHaveBeenCalledTimes(2);
  });

  it('a failed read is not cached', async () => {
    const r = vi.fn<ReadFn>(async () => {
      throw new Error('notImage');
    });
    const c = createImageCache(r, urls);
    await expect(c.url('a.png')).rejects.toThrow();
    await expect(c.url('a.png')).rejects.toThrow();
    expect(r).toHaveBeenCalledTimes(2);
  });

  it('a release owed to an invalidated entry does not free the newly read one', async () => {
    let n = 0;
    urls.create.mockImplementation(() => `blob:${++n}`);
    const c = createImageCache(async () => new ArrayBuffer(1), urls);
    expect(await c.url('a.png')).toBe('blob:1');
    c.invalidate('a.png');
    expect(urls.revoke).toHaveBeenLastCalledWith('blob:1');
    expect(await c.url('a.png')).toBe('blob:2'); // new entry, held once
    c.release('a.png'); // the old holder lets go: consumes the ghost, not the new ref
    for (let i = 0; i < 70; i++) {
      await c.url(`${i}.png`);
      c.release(`${i}.png`);
    }
    expect(urls.revoke).not.toHaveBeenCalledWith('blob:2');
    c.release('a.png');
    for (let i = 70; i < 140; i++) {
      await c.url(`${i}.png`);
      c.release(`${i}.png`);
    }
    expect(urls.revoke).toHaveBeenCalledWith('blob:2');
  });

  it('an index miss re-lists once when the list is older than MISS_RELIST_MS, not when fresh', async () => {
    let clock = 0;
    const l = vi.fn<ListFn>(async () => ['a.png']);
    const ix = createImageIndex(l, () => clock);
    expect(await ix.find('n.md', 'new.png')).toBeNull();
    expect(l).toHaveBeenCalledTimes(1); // fresh list: no re-list
    l.mockImplementation(async () => ['a.png', 'images/new.png']);
    clock = MISS_RELIST_MS;
    expect(await ix.find('n.md', 'new.png')).toBe('images/new.png');
    expect(l).toHaveBeenCalledTimes(2);
    expect(await ix.find('n.md', 'gone.png')).toBeNull();
    expect(l).toHaveBeenCalledTimes(2); // the new list is fresh again
  });

  it('every settled watcher batch drops the name index and notifies; only image paths drop cached bytes', async () => {
    const cache = createImageCache(read, urls);
    const index = createImageIndex(list);
    const vi_ = createVaultImages(cache, index);
    const inv = vi.spyOn(cache, 'invalidate');
    const ixInv = vi.spyOn(index, 'invalidate');
    const heard = vi.fn();
    vi_.subscribe!(heard);
    vi_.onChanged(['exp/new-folder']);
    expect(ixInv).toHaveBeenCalledTimes(1);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(inv).not.toHaveBeenCalled();
    vi_.onChanged(['n.md', 'gone.png']); // removals are the image events the watcher does send
    expect(inv).toHaveBeenCalledWith('gone.png');
    expect(inv).toHaveBeenCalledTimes(1);
    expect(ixInv).toHaveBeenCalledTimes(2);
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it('the index lists once and finds by name until invalidated', async () => {
    const ix = createImageIndex(list);
    expect(await ix.find('exp/n.md', 'ln-1.JPG')).toBe('exp/images/scans/LN-1.jpg');
    expect(await ix.isUnique('a.png')).toBe(true);
    expect(list).toHaveBeenCalledTimes(1);
    ix.invalidate();
    await ix.find('exp/n.md', 'a.png');
    expect(list).toHaveBeenCalledTimes(2);
  });
});

describe('image widgets', () => {
  it('![[note]] is not an image: no .lno-image and no IPC', async () => {
    const v = view('![[Other note]]\nx', 17);
    await flush();
    expect(v.contentDOM.querySelector('.lno-image')).toBeNull();
    expect(v.contentDOM.querySelector('.lno-wikilink')).not.toBeNull();
    expect(read).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it('off the cursor line an embed is replaced by the image, which loads through the cache', async () => {
    const v = view('![[LN-1.jpg]]\n\nx', 16);
    expect(visibleText(v, 1)).toBe('');
    const img = v.contentDOM.querySelector<HTMLImageElement>('img.lno-image')!;
    expect(img).not.toBeNull();
    await flush();
    await flush();
    expect(read).toHaveBeenCalledWith('exp/images/scans/LN-1.jpg');
    expect(img.getAttribute('src')).toBe('blob:x');
  });

  it('a Markdown image off the cursor line is replaced, with its alt text', async () => {
    const v = view('![gel](a.png)\n\nx', 16);
    const img = v.contentDOM.querySelector<HTMLImageElement>('img.lno-image')!;
    expect(img.alt).toBe('gel');
    expect(visibleText(v, 1)).toBe('');
    await flush();
    await flush();
    expect(read).toHaveBeenCalledWith('exp/a.png');
  });

  it('a wiki embed with width sets the width through CSSOM, never setAttribute("style")', () => {
    const setAttributeSpy = vi.spyOn(Element.prototype, 'setAttribute');
    const v = view('![[a.png|200]]\n\nx', 17);
    const img = v.contentDOM.querySelector<HTMLImageElement>('img.lno-image')!;
    expect(img.style.width).toBe('200px');
    expect(setAttributeSpy).not.toHaveBeenCalledWith('style', expect.anything());
  });

  it('remote images are not fetched: the alt text shows as missing', async () => {
    const v = view('![remote](https://example.com/a.png)\n\nx', 40);
    await flush();
    const miss = v.contentDOM.querySelector('.lno-image-missing')!;
    expect(miss.textContent).toBe('remote');
    expect(read).not.toHaveBeenCalled();
  });

  it('a missing image shows the not-found text', async () => {
    list = vi.fn<ListFn>(async () => []);
    const v = view('![[nope.png]]\n\nx', 16);
    await flush();
    await flush();
    expect(v.contentDOM.querySelector('.lno-image-missing')?.textContent).toContain('nope.png');
    expect(v.contentDOM.querySelector('img.lno-image')).toBeNull();
  });

  it('unrelated edits do not rebuild the img (same DOM node)', () => {
    const v = view('![[a.png]]\n\nx', 13);
    const img = v.contentDOM.querySelector('img');
    expect(img).not.toBeNull();
    v.dispatch({ changes: { from: 13, insert: 'y' } });
    expect(v.contentDOM.querySelector('img')).toBe(img);
  });

  it('the cursor on the embed line shows source and the image after it', () => {
    const v = view('![[a.png]]\nx', 3);
    expect(visibleText(v, 1)).toBe('![[a.png]]');
    expect(v.contentDOM.querySelector('img.lno-image')).not.toBeNull();
  });

  it('a change notice re-reads only the invalidated path and swaps its src', async () => {
    let n = 0;
    urls.create.mockImplementation(() => `blob:${++n}`);
    const v = view('![[a.png]]\n![[LN-1.jpg]]\n\nx', 27);
    await flush();
    await flush();
    expect(read).toHaveBeenCalledTimes(2);
    const imgs = () => [...v.contentDOM.querySelectorAll<HTMLImageElement>('img.lno-image')];
    const before = imgs().map((i) => i.getAttribute('src'));
    current!.onChanged(['a.png']);
    await flush();
    await flush();
    expect(read).toHaveBeenCalledTimes(3);
    expect(read).toHaveBeenLastCalledWith('a.png');
    const after = imgs().map((i) => i.getAttribute('src'));
    expect(after[0]).not.toBe(before[0]);
    expect(after[1]).toBe(before[1]);
  });

  it('an image that failed to decode stays not-found when a notice reloads the same cached URL', async () => {
    const v = view('![[a.png]]\n\nx', 13);
    await flush();
    await flush();
    v.contentDOM.querySelector('img.lno-image')!.dispatchEvent(new Event('error'));
    expect(v.contentDOM.querySelector('.lno-image-missing')).not.toBeNull();
    current!.onChanged(['n.md']);
    await flush();
    await flush();
    expect(v.contentDOM.querySelector('img.lno-image')).toBeNull();
    expect(v.contentDOM.querySelector('.lno-image-missing')).not.toBeNull();
  });

  it('without an image loader the widget shows missing and reads nothing', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const v = new EditorView({
      parent,
      state: EditorState.create({ doc: '![[a.png]]\n\nx', selection: { anchor: 13 }, extensions: [labnoteMarkdown(), livePreview()] }),
    });
    views.push(v);
    expect(v.contentDOM.querySelector('.lno-image-missing')).not.toBeNull();
    expect(read).not.toHaveBeenCalled();
  });
});
