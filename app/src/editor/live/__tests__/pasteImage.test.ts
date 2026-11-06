// @vitest-environment jsdom
import { EditorState, Prec, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, undo } from '@codemirror/commands';
import { labnoteMarkdown } from '../../markdownSyntax';
import { tableExtension } from '../../table/field';
import { focusCell as openCell } from '../../table/cellEditor';
import { LIST_KEYS } from '../listKeys';
import { livePreview } from '../index';
import { imageLoader } from '../imageWidget';
import type { VaultImages } from '../vaultImages';
import { createImageCache } from '../imageCache';
import {
  PASTE_MIME,
  dropName,
  embedText,
  imageFilesOf,
  pasteImages,
  pastedImageName,
  pendingPaste,
} from '../pasteImage';
import { setLang } from '../../../i18n/lang';
import { t } from '../../../i18n/t';

// jsdom 에는 레이아웃이 없다. CodeMirror 가 측정에 쓰는 API 만 빈 값으로 채운다.
const emptyRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
Range.prototype.getClientRects ??= emptyRects;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();
document.execCommand ??= () => false;

type Write = (dir: string, name: string, bytes: Uint8Array) => Promise<string>;

const views: EditorView[] = [];
let unique = true;
let invalidate = vi.fn();
let isUnique = vi.fn(async () => unique);
let toast = vi.fn();

function fakeImages(): VaultImages {
  return {
    cache: createImageCache(async () => new ArrayBuffer(0)),
    index: { find: async () => null, isUnique, invalidate },
    onChanged: () => {},
    clear: () => {},
  };
}

/** 편집기(Editor.tsx)와 같은 순서로 싣고, 붙여 넣기 확장과 이미지 설정을 더한다. */
function view(
  doc: string,
  pos: number,
  opts: { notePath?: string; write: Write; readOnly?: boolean; extra?: Extension[] },
): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const v = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor: Math.min(pos, doc.length) },
      extensions: [
        EditorState.lineSeparator.of('\n'),
        history(),
        Prec.high(keymap.of(LIST_KEYS)),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        labnoteMarkdown(),
        livePreview(),
        tableExtension({ save: () => {}, root: document }),
        imageLoader.of({ notePath: opts.notePath ?? 'exp/n.labnote.md', images: fakeImages() }),
        pasteImages({ write: opts.write, toast }),
        opts.readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : [],
        ...(opts.extra ?? []),
      ],
    }),
  });
  views.push(v);
  return v;
}

/** jsdom 에는 ClipboardEvent·DataTransfer 가 없다: 같은 모양의 사건을 꾸민다. */
function dataTransfer(files: File[], text = ''): DataTransfer {
  return {
    files: Object.assign([...files], { item: (i: number) => files[i] ?? null }),
    items: files.map((f) => ({ kind: 'file', type: f.type, getAsFile: () => f })),
    types: [...(files.length ? ['Files'] : []), ...(text ? ['text/plain'] : [])],
    getData: (type: string) => (type === 'text/plain' ? text : ''),
  } as unknown as DataTransfer;
}
function pasteEvent(files: File[], text = '', html = ''): Event {
  const ev = new Event('paste', { bubbles: true, cancelable: true });
  const dt = dataTransfer(files, text);
  if (html) {
    (dt as unknown as { types: string[] }).types.push('text/html');
    (dt as unknown as { getData: (type: string) => string }).getData = (type) =>
      type === 'text/plain' ? text : type === 'text/html' ? html : '';
  }
  Object.defineProperty(ev, 'clipboardData', { value: dt });
  return ev;
}
const textPasteEvent = (text: string) => pasteEvent([], text);
function dropEvent(files: File[]): Event {
  const ev = new MouseEvent('drop', { bubbles: true, cancelable: true, clientX: 0, clientY: 0 });
  Object.defineProperty(ev, 'dataTransfer', { value: dataTransfer(files) });
  return ev;
}
const png = (name = 'image.png') => new File([new Uint8Array([1])], name, { type: 'image/png' });
const setComposing = (v: EditorView, on: boolean) => {
  (v as unknown as { inputState: { composing: number } }).inputState.composing = on ? 1 : -1;
};
/**
 * 파일 읽기(jsdom 의 FileReader 는 타이머로 끝난다), 쓰기 약속, 그 뒤의 색인 확인이 끝나기를 기다린다.
 * 한 번의 setTimeout(0) 으로는 FileReader 와 경주한다: 여러 번 돈다.
 */
const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise<void>((r) => setTimeout(r, 0));
};

const NAME = 'Pasted image 20261107153012.png';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 10, 7, 15, 30, 12));
  unique = true;
  invalidate = vi.fn();
  isUnique = vi.fn(async () => unique);
  toast = vi.fn();
  setLang('en');
});
afterEach(() => {
  vi.useRealTimers();
  while (views.length) views.pop()!.destroy();
  document.body.innerHTML = '';
});

describe('라이브 미리보기: 이미지 붙여 넣기와 끌어 놓기', () => {
  it('pasting a PNG writes under the note folder and inserts one embed as one undo step', async () => {
    const write = vi.fn<Write>(async (dir, name) => `${dir}/${name}`);
    const v = view('a', 1, { notePath: 'exp/n.labnote.md', write });
    const ev = pasteEvent([png()]);
    v.contentDOM.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    await flush();
    expect(write).toHaveBeenCalledWith('exp/images', NAME, expect.any(Uint8Array));
    expect(Array.from(write.mock.calls[0][2])).toEqual([1]);
    expect(invalidate).toHaveBeenCalled();
    expect(isUnique).toHaveBeenCalledWith(NAME);
    expect(v.state.doc.toString()).toBe(`a![[${NAME}]]`);
    expect(v.state.field(pendingPaste)).toEqual([]);
    undo(v);
    expect(v.state.doc.toString()).toBe('a');
  });

  it('a note at the vault root writes to images/', async () => {
    const write = vi.fn<Write>(async (dir, name) => `${dir}/${name}`);
    const v = view('', 0, { notePath: 'n.labnote.md', write });
    v.contentDOM.dispatchEvent(pasteEvent([png()]));
    await flush();
    expect(write).toHaveBeenCalledWith('images', NAME, expect.any(Uint8Array));
  });

  it('text typed while the write is pending stays before the embed', async () => {
    let resolve!: (p: string) => void;
    const write = vi.fn<Write>(() => new Promise<string>((r) => (resolve = r)));
    const v = view('a', 1, { write });
    v.contentDOM.dispatchEvent(pasteEvent([png()]));
    await flush();
    expect(v.state.field(pendingPaste).map((p) => p.pos)).toEqual([1]);
    v.dispatch({ changes: { from: 0, insert: 'b' } });
    expect(v.state.field(pendingPaste).map((p) => p.pos)).toEqual([2]);
    resolve(`exp/images/${NAME}`);
    await flush();
    expect(v.state.doc.toString()).toBe(`ba![[${NAME}]]`);
  });

  it('several images are joined by the line break in one transaction', async () => {
    const write = vi.fn<Write>(async (dir, name) => `${dir}/${name}`);
    const v = view('', 0, { write });
    v.contentDOM.dispatchEvent(pasteEvent([png('x.png'), new File([new Uint8Array([2])], 'y.jpg', { type: 'image/jpeg' })]));
    await flush();
    expect(write.mock.calls.map((c) => c[1])).toEqual([NAME, 'Pasted image 20261107153012.jpg']);
    expect(v.state.doc.toString()).toBe(`![[${NAME}]]\n![[Pasted image 20261107153012.jpg]]`);
    undo(v);
    expect(v.state.doc.toString()).toBe('');
  });

  it('a text paste is not handled', () => {
    const write = vi.fn<Write>();
    const v = view('', 0, { write });
    v.contentDOM.dispatchEvent(textPasteEvent('https://x'));
    expect(write).not.toHaveBeenCalled();
    // CodeMirror 의 붙여 넣기(그리고 pasteURLAsLink)가 그대로 처리한다
    expect(v.state.doc.toString()).toBe('https://x');
    expect(v.state.field(pendingPaste)).toEqual([]);
  });

  it('a hostile dropped name is sanitized before IPC', async () => {
    expect(dropName(new File([], '../../evil.png', { type: 'image/png' }))).toBe('evil.png');
    expect(dropName(new File([], 'C:\\x\\gel.png', { type: 'image/png' }))).toBe('gel.png');
    for (const bad of ['CON.png', 'a:b.png', 'x.png.', 'a]]b.png', 'a|b.png', 'x.html', 'x.svg', 'a\u0001.png', '.png']) {
      expect(dropName(new File([], bad, { type: 'image/png' })), bad).toMatch(/^Pasted image \d{14}\.png$/);
    }
    const write = vi.fn<Write>(async (dir, name) => `${dir}/${name}`);
    const v = view('a', 1, { write });
    const ev = dropEvent([png('../../evil.png')]);
    v.contentDOM.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    await flush();
    expect(write).toHaveBeenCalledWith('exp/images', 'evil.png', expect.any(Uint8Array));
    expect(v.state.doc.toString()).toContain('![[evil.png]]');
  });

  it('read-only, composing and table-cell states are no-ops', async () => {
    const write = vi.fn<Write>(async (dir, name) => `${dir}/${name}`);
    const ro = view('a', 1, { write, readOnly: true });
    ro.contentDOM.dispatchEvent(pasteEvent([png()]));
    const composing = view('a', 1, { write });
    setComposing(composing, true);
    composing.contentDOM.dispatchEvent(pasteEvent([png()]));
    const doc = '| a | b |\n| - | - |\n| 1 | 2 |\n';
    const table = view(doc, doc.length, { write });
    expect(openCell(table, 0, 1, 0)).toBe(true);
    await Promise.resolve();
    table.contentDOM.dispatchEvent(pasteEvent([png()]));
    await flush();
    expect(write).not.toHaveBeenCalled();
    expect(ro.state.doc.toString()).toBe('a');
    expect(composing.state.doc.toString()).toBe('a');
    expect(table.state.doc.toString()).toBe(doc);
    for (const v of [ro, composing, table]) expect(v.state.field(pendingPaste)).toEqual([]);
  });

  it('a failed write shows the saveFailed toast and inserts nothing', async () => {
    const write = vi.fn<Write>(async () => Promise.reject({ kind: 'tooLarge', message: 'too large' }));
    const v = view('a', 1, { write });
    v.contentDOM.dispatchEvent(pasteEvent([png()]));
    await flush();
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('Could not save the image'));
    expect(v.state.doc.toString()).toBe('a');
    expect(v.state.field(pendingPaste)).toEqual([]);
  });

  it('a non-unique name inserts the vault path', async () => {
    expect(embedText('exp/images/gel.png', false)).toBe('![[exp/images/gel.png]]');
    expect(embedText('exp/images/gel.png', true)).toBe('![[gel.png]]');
    unique = false;
    const write = vi.fn<Write>(async (dir) => `${dir}/${NAME.replace('.png', ' 1.png')}`);
    const v = view('', 0, { write });
    v.contentDOM.dispatchEvent(pasteEvent([png()]));
    await flush();
    expect(v.state.doc.toString()).toBe('![[exp/images/Pasted image 20261107153012 1.png]]');
  });

  it('only image files with a known MIME type are taken', () => {
    expect(PASTE_MIME['image/jpeg']).toBe('jpg');
    expect(PASTE_MIME['image/svg+xml']).toBeUndefined();
    const files = [png(), new File(['<svg/>'], 'x.svg', { type: 'image/svg+xml' }), new File(['x'], 'a.txt', { type: 'text/plain' })];
    expect(imageFilesOf(dataTransfer(files)).map((f) => f.name)).toEqual(['image.png']);
    expect(imageFilesOf(null)).toEqual([]);
    expect(pastedImageName(new Date(2026, 0, 2, 3, 4, 5), 'gif')).toBe('Pasted image 20260102030405.gif');
  });
  it('a pending paste from a replaced state never lands in the new note, and the new paste keeps its own slot', async () => {
    const resolvers: Array<(p: string) => void> = [];
    const write = vi.fn<Write>(() => new Promise<string>((r) => resolvers.push(r)));
    const v = view('noteA', 0, { notePath: 'exp/a.labnote.md', write });
    v.contentDOM.dispatchEvent(pasteEvent([png()]));
    await flush();
    expect(write).toHaveBeenCalledTimes(1);
    // 편집기는 노트를 바꿀 때 setState 로 상태를 통째로 갈아 끼운다(같은 확장, 다른 노트)
    v.setState(
      EditorState.create({
        doc: 'noteB',
        selection: { anchor: 5 },
        extensions: [
          EditorState.lineSeparator.of('\n'),
          history(),
          labnoteMarkdown(),
          livePreview(),
          tableExtension({ save: () => {}, root: document }),
          imageLoader.of({ notePath: 'exp/b.labnote.md', images: fakeImages() }),
          pasteImages({ write, toast }),
        ],
      }),
    );
    v.contentDOM.dispatchEvent(pasteEvent([png()]));
    await flush();
    expect(write).toHaveBeenCalledTimes(2);
    resolvers[0]('exp/images/fromA.png');
    await flush();
    expect(v.state.doc.toString()).toBe('noteB');
    resolvers[1]('exp/images/fromB.png');
    await flush();
    expect(v.state.doc.toString()).toBe('noteB![[fromB.png]]');
    expect(v.state.field(pendingPaste)).toEqual([]);
  });

  it('a clipboard with TSV text and a bitmap (Excel) makes a table and writes nothing', async () => {
    const write = vi.fn<Write>(async (dir, name) => `${dir}/${name}`);
    const v = view('', 0, { write });
    const ev = pasteEvent([png()], 'a\tb\r\n1\t2', '<table><tr><td>a</td><td>b</td></tr></table>');
    v.contentDOM.dispatchEvent(ev);
    await flush();
    expect(write).not.toHaveBeenCalled();
    expect(v.state.doc.toString()).toContain('| a | b |');
    expect(v.state.doc.toString()).not.toContain('![[');
  });

  it('a clipboard whose HTML is a single <img> (copy image) is still taken as an image', async () => {
    const write = vi.fn<Write>(async (dir, name) => `${dir}/${name}`);
    const v = view('', 0, { write });
    v.contentDOM.dispatchEvent(
      pasteEvent([png()], '', '<html><body><!--StartFragment--><meta charset="utf-8"><img src="https://x/y.png"/><!--EndFragment--></body></html>'),
    );
    await flush();
    expect(write).toHaveBeenCalledTimes(1);
    expect(v.state.doc.toString()).toBe(`![[${NAME}]]`);
  });

  it('a paste or drop inside front matter or a fenced code block inserts no embed', async () => {
    const write = vi.fn<Write>(async (dir, name) => `${dir}/${name}`);
    const fm = '---\ntitle: x\n---\nbody';
    const inFm = view(fm, 8, { write });
    inFm.contentDOM.dispatchEvent(pasteEvent([png()]));
    const code = '```\ncode\n```\n';
    const inCode = view(code, 6, { write });
    inCode.contentDOM.dispatchEvent(pasteEvent([png()]));
    const dropCode = view(code, 6, { write });
    // jsdom 에는 레이아웃이 없다: 놓은 자리를 코드 줄 안으로 정한다
    dropCode.posAtCoords = (() => 6) as typeof dropCode.posAtCoords;
    const drop = dropEvent([png()]);
    dropCode.contentDOM.dispatchEvent(drop);
    // 파일을 글로 읽어 넣는 CodeMirror 의 기본 끌어 놓기도 막는다
    expect(drop.defaultPrevented).toBe(true);
    await flush();
    expect(write).not.toHaveBeenCalled();
    expect(inFm.state.doc.toString()).toBe(fm);
    expect(inCode.state.doc.toString()).toBe(code);
    expect(dropCode.state.doc.toString()).toBe(code);
  });

  it('a known FsError kind is shown as a translated reason, an unknown one as its message', async () => {
    setLang('ko');
    const write = vi.fn<Write>(async () => Promise.reject({ kind: 'tooLarge', message: 'image too large' }));
    const v = view('a', 1, { write });
    v.contentDOM.dispatchEvent(pasteEvent([png()]));
    await flush();
    expect(toast).toHaveBeenCalledWith(t('live.image.saveFailed', t('live.image.err.tooLarge')));
    expect(toast.mock.calls[0][0]).not.toMatch(/tooLarge|too large/);
    toast.mockClear();
    const io = vi.fn<Write>(async () => Promise.reject({ kind: 'io', message: 'disk full' }));
    const w = view('a', 1, { write: io });
    w.contentDOM.dispatchEvent(pasteEvent([png()]));
    await flush();
    expect(toast).toHaveBeenCalledWith(t('live.image.saveFailed', 'disk full'));
  });
});
