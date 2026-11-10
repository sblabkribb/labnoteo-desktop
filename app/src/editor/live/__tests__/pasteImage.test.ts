// @vitest-environment jsdom
import { Compartment, EditorState, Prec, type Extension, type Transaction } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, undo } from '@codemirror/commands';
import { labnoteMarkdown } from '../../markdownSyntax';
import { tableExtension } from '../../table/field';
import { activeCellView, focusCell as openCell } from '../../table/cellEditor';
import { LIST_KEYS } from '../listKeys';
import { livePreview } from '../index';
import { imageLoader } from '../imageWidget';
import type { VaultImages } from '../vaultImages';
import { createImageCache } from '../imageCache';
import {
  MAX_IMAGES_PER_GESTURE,
  PASTE_MIME,
  dropName,
  embedText,
  imageFilesOf,
  pasteImages,
  pastedImageName,
  pendingPaste,
  dropHint,
  DROP_HINT_MS,
  type PasteImageDeps,
} from '../pasteImage';
import { attachmentDir, attachmentName, imageDir, isBlockedName, linkFor, BLOCKED_EXTS } from '../attachments';
import type { NotifyOpts } from '../../../labnote/host/toastStore';
import { readFileSync } from 'node:fs';
import { installFileDropGuard } from '../../../ui/fileDropGuard';
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
let notice = vi.fn();

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
  opts: { notePath?: string; write: Write; readOnly?: boolean; extra?: Extension[]; deps?: Partial<PasteImageDeps> },
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
        // 옛 테스트는 그림 폴더 images(노트 폴더)를 본다. 기본(resources)은 아래 Task 17 묶음이 본다.
        pasteImages({ write: opts.write, toast, notice, imageFolder: () => 'images', ...opts.deps }),
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
    getData: (type: string) => (type === 'text/plain' || type === 'Text' ? text : ''),
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
function dropEvent(files: File[], text = ''): Event {
  const ev = new MouseEvent('drop', { bubbles: true, cancelable: true, clientX: 0, clientY: 0 });
  Object.defineProperty(ev, 'dataTransfer', { value: dataTransfer(files, text) });
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
  notice = vi.fn();
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

  it('one gesture writes at most MAX_IMAGES_PER_GESTURE files and names how many were left out', async () => {
    const write = vi.fn<Write>(async (dir, name) => `${dir}/${name}`);
    const v = view('', 0, { write });
    const files = Array.from({ length: MAX_IMAGES_PER_GESTURE + 3 }, (_, i) => png(`p${i}.png`));
    v.contentDOM.dispatchEvent(dropEvent(files));
    await vi.waitFor(() => expect(v.state.field(pendingPaste)).toEqual([]), { timeout: 5000 });
    expect(write).toHaveBeenCalledTimes(MAX_IMAGES_PER_GESTURE);
    expect(notice).toHaveBeenCalledWith(t('live.image.tooMany', MAX_IMAGES_PER_GESTURE, 3));
    expect(v.state.doc.toString().split('\n')).toHaveLength(MAX_IMAGES_PER_GESTURE);
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
    expect(notice).toHaveBeenCalledWith(t('live.image.rawText'));
  });

  it('the embed is its own undo step: typing before or right after it is undone separately', async () => {
    const write = vi.fn<Write>(async (dir, name) => `${dir}/${name}`);
    const v = view('a', 1, { write });
    const type = (ch: string) => {
      const at = v.state.selection.main.head;
      v.dispatch({ changes: { from: at, insert: ch }, selection: { anchor: at + 1 }, userEvent: 'input.type' });
    };
    type('x');
    v.contentDOM.dispatchEvent(pasteEvent([png()]));
    await flush();
    expect(v.state.doc.toString()).toBe(`ax![[${NAME}]]`);
    // 바로 뒤에 친 글은 임베드와 한 단계로 묶이지 않는다(isolateHistory 'full')
    type('y');
    undo(v);
    expect(v.state.doc.toString()).toBe(`ax![[${NAME}]]`);
    undo(v);
    expect(v.state.doc.toString()).toBe('ax');
  });

  it('the insert is a user paste event', async () => {
    const write = vi.fn<Write>(async (dir, name) => `${dir}/${name}`);
    const seen: Transaction[] = [];
    const v = view('a', 1, { write, extra: [EditorView.updateListener.of((u) => seen.push(...u.transactions))] });
    v.contentDOM.dispatchEvent(pasteEvent([png()]));
    await flush();
    const inserts = seen.filter((tr) => tr.docChanged);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].isUserEvent('input.paste')).toBe(true);
  });

  it('a write that finishes while the editor is locked inserts nothing and names the saved file', async () => {
    let resolve!: (p: string) => void;
    const write = vi.fn<Write>(() => new Promise<string>((r) => (resolve = r)));
    const lock = new Compartment();
    const v = view('a', 1, { write, extra: [lock.of([])] });
    v.contentDOM.dispatchEvent(pasteEvent([png()]));
    await flush();
    // 대화 상자가 열리면 Editor.tsx 가 LOCKED(readOnly + editable false)를 건다
    v.dispatch({ effects: lock.reconfigure([EditorState.readOnly.of(true), EditorView.editable.of(false)]) });
    resolve(`exp/images/${NAME}`);
    await flush();
    expect(v.state.doc.toString()).toBe('a');
    expect(v.state.field(pendingPaste)).toEqual([]);
    expect(notice).toHaveBeenCalledWith(t('live.image.savedNotInserted', `exp/images/${NAME}`));
  });

  it('a write whose note was replaced names the orphaned file', async () => {
    let resolve!: (p: string) => void;
    const write = vi.fn<Write>(() => new Promise<string>((r) => (resolve = r)));
    const v = view('noteA', 0, { notePath: 'exp/a.labnote.md', write });
    v.contentDOM.dispatchEvent(pasteEvent([png()]));
    await flush();
    v.setState(EditorState.create({ doc: 'noteB', extensions: [imageLoader.of({ notePath: 'exp/b.labnote.md', images: fakeImages() }), pasteImages({ write, toast, notice })] }));
    resolve('exp/images/fromA.png');
    await flush();
    expect(v.state.doc.toString()).toBe('noteB');
    expect(notice).toHaveBeenCalledWith(t('live.image.savedNotInserted', 'exp/images/fromA.png'));
  });

  it('an image over 20 MiB is refused before its bytes are read', async () => {
    const write = vi.fn<Write>(async (dir, name) => `${dir}/${name}`);
    const big = png();
    Object.defineProperty(big, 'size', { value: 20 * 1024 * 1024 + 1 });
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
    Object.defineProperty(big, 'arrayBuffer', { value: arrayBuffer });
    const v = view('a', 1, { write });
    v.contentDOM.dispatchEvent(pasteEvent([big]));
    await flush();
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(t('live.image.saveFailed', t('live.image.err.tooLarge')));
    expect(v.state.doc.toString()).toBe('a');
    expect(v.state.field(pendingPaste)).toEqual([]);
  });

  it('a dropped non-image file is swallowed: its text is never inserted', async () => {
    const write = vi.fn<Write>(async (dir, name) => `${dir}/${name}`);
    const v = view('a', 1, { write });
    for (const f of [
      new File(['hello'], 'notes.txt', { type: 'text/plain' }),
      new File(['<svg/>'], 'x.svg', { type: 'image/svg+xml' }),
      new File(['a,b'], 'd.csv', { type: 'text/csv' }),
    ]) {
      const ev = dropEvent([f]);
      v.contentDOM.dispatchEvent(ev);
      expect(ev.defaultPrevented, f.name).toBe(true);
    }
    await flush();
    expect(write).not.toHaveBeenCalled();
    expect(v.state.doc.toString()).toBe('a');
    expect(notice).toHaveBeenCalledWith(t('live.image.dropOnlyImages'));
  });

  it('a dropped file into a read-only or composing editor is swallowed too', async () => {
    const write = vi.fn<Write>(async (dir, name) => `${dir}/${name}`);
    const ro = view('a', 1, { write, readOnly: true });
    const ev = dropEvent([new File(['hello'], 'notes.txt', { type: 'text/plain' })]);
    ro.contentDOM.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    const composing = view('a', 1, { write });
    setComposing(composing, true);
    const ev2 = dropEvent([png()]);
    composing.contentDOM.dispatchEvent(ev2);
    await flush();
    expect(composing.state.doc.toString()).toBe('a');
    expect(write).not.toHaveBeenCalled();
  });

  it('a file dropped into an open table cell editor is swallowed', async () => {
    const write = vi.fn<Write>(async (dir, name) => `${dir}/${name}`);
    const doc = '| a | b |\n| - | - |\n| 1 | 2 |\n';
    const table = view(doc, doc.length, { write });
    expect(openCell(table, 0, 1, 0)).toBe(true);
    await Promise.resolve();
    const cell = activeCellView(table)!;
    const before = cell.state.doc.toString();
    const ev = dropEvent([new File(['hello'], 'notes.txt', { type: 'text/plain' })]);
    cell.contentDOM.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    await flush();
    expect(cell.state.doc.toString()).toBe(before);
    expect(table.state.doc.toString()).toBe(doc);
    expect(write).not.toHaveBeenCalled();
  });

  it('a dropped text selection (no files) is left to CodeMirror', () => {
    const write = vi.fn<Write>(async (dir, name) => `${dir}/${name}`);
    const v = view('a', 1, { write });
    v.posAtCoords = (() => 1) as typeof v.posAtCoords;
    v.contentDOM.dispatchEvent(dropEvent([], 'zz'));
    expect(v.state.doc.toString()).toBe('azz');
    expect(notice).not.toHaveBeenCalled();
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

describe('Task 17: 첨부는 resources/ 로, 그림 폴더 설정, 자세한 알림', () => {
  const EXP = 'labnote/001_pUC19';
  const NOTE = `${EXP}/WB030_assembly.labnote.md`;
  const csv = (name = 'plate-reading.csv') => new File([new Uint8Array([97, 44, 98])], name, { type: 'text/csv' });

  function setup(deps: Partial<PasteImageDeps> = {}, doc = 'a', pos = 1) {
    const write = vi.fn<Write>(async (dir, name) => `${dir}/${name}`);
    const writeAttachment = vi.fn<Write>(async (dir, name) => `${dir}/${name}`);
    const saved = vi.fn<(message: string, opts: NotifyOpts) => void>();
    const reveal = vi.fn<(path: string) => void>();
    const v = view(doc, pos, {
      notePath: NOTE,
      write,
      deps: { imageFolder: undefined, writeAttachment, isUniqueAttachment: async () => true, saved, reveal, ...deps },
    });
    // jsdom 에는 레이아웃이 없다: 놓은 자리를 커서 자리로 정한다
    v.posAtCoords = (() => pos) as typeof v.posAtCoords;
    return { v, write, writeAttachment, saved, reveal };
  }

  it('the folder helpers: attachments go to the experiment resources, pictures follow the setting', () => {
    expect(attachmentDir(NOTE)).toBe(`${EXP}/resources`);
    expect(attachmentDir(`${EXP}/README.labnote.md`)).toBe(`${EXP}/resources`);
    expect(attachmentDir(`${EXP}/sub/deep.labnote.md`)).toBe(`${EXP}/resources`);
    // 실험 밖의 노트: 노트 폴더의 resources, 보관함 루트면 resources
    expect(attachmentDir('notes/meeting.md')).toBe('notes/resources');
    expect(attachmentDir('todo.md')).toBe('resources');
    expect(imageDir(NOTE, 'resources')).toBe(`${EXP}/resources`);
    expect(imageDir(`${EXP}/sub/deep.labnote.md`, 'images')).toBe(`${EXP}/sub/images`);
    expect(imageDir('todo.md', 'images')).toBe('images');
  });

  it('linkFor: plain link for data, embed for pictures and PDFs, the vault path when the name is not unique', () => {
    expect(linkFor(`${EXP}/resources/plate-reading.csv`, true)).toBe('[[plate-reading.csv]]');
    expect(linkFor(`${EXP}/resources/plate-reading.csv`, false)).toBe(`[[${EXP}/resources/plate-reading.csv]]`);
    expect(linkFor(`${EXP}/resources/report.PDF`, true)).toBe('![[report.PDF]]');
    expect(linkFor(`${EXP}/resources/gel.png`, true)).toBe('![[gel.png]]');
    expect(linkFor(`${EXP}/resources/x.svg`, true)).toBe('![[x.svg]]');
  });

  it('attachmentName keeps a safe name and cleans the rest', () => {
    const now = new Date(2026, 10, 10, 9, 30, 0);
    expect(attachmentName('C:\\data\\plate-reading.csv', now)).toBe('plate-reading.csv');
    expect(attachmentName('../../x.csv', now)).toBe('x.csv');
    expect(attachmentName('a:b|c[1].csv', now)).toBe('a_b_c_1_.csv');
    expect(attachmentName('결과 정리.xlsx', now)).toBe('결과 정리.xlsx');
    expect(attachmentName('x.csv. ', now)).toBe('x.csv');
    expect(attachmentName('CON.csv', now)).toBe('Pasted file 20261110093000.csv');
    expect(attachmentName('.env', now)).toBe('Pasted file 20261110093000.env');
    expect(attachmentName('', now)).toBe('Pasted file 20261110093000');
  });

  it('the blocked list matches Rust BLOCKED_EXTS', () => {
    const rs = readFileSync('src-tauri/src/vault/attach.rs', 'utf-8');
    const block = rs.slice(rs.indexOf('pub const BLOCKED_EXTS'), rs.indexOf('];', rs.indexOf('pub const BLOCKED_EXTS')));
    const rust = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect([...BLOCKED_EXTS].sort()).toEqual(rust.sort());
    expect(isBlockedName('Setup.EXE')).toBe(true);
    expect(isBlockedName('page.html')).toBe(true);
    expect(isBlockedName('plate.csv')).toBe(false);
    expect(isBlockedName('exe')).toBe(false);
  });

  it('dropping a CSV and a PNG writes both to the experiment resources/, links them in one undo step and shows the detailed toast (ko)', async () => {
    setLang('ko');
    const { v, write, writeAttachment, saved, reveal } = setup();
    const ev = dropEvent([csv(), png('gel.png')]);
    v.contentDOM.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    await flush();
    expect(writeAttachment).toHaveBeenCalledWith(`${EXP}/resources`, 'plate-reading.csv', expect.any(Uint8Array));
    expect(Array.from(writeAttachment.mock.calls[0][2])).toEqual([97, 44, 98]);
    expect(write).toHaveBeenCalledWith(`${EXP}/resources`, 'gel.png', expect.any(Uint8Array));
    expect(v.state.doc.toString()).toBe('a[[plate-reading.csv]]\n![[gel.png]]');
    undo(v);
    expect(v.state.doc.toString()).toBe('a');
    expect(saved).toHaveBeenCalledTimes(1);
    const [, opts] = saved.mock.calls[0];
    expect(opts.title).toBe('첨부 2개 저장됨');
    expect(opts.detail).toBe('plate-reading.csv → resources/\ngel.png → resources/');
    expect(opts.action?.label).toBe('폴더 열기');
    opts.action!.run();
    expect(reveal).toHaveBeenCalledWith(`${EXP}/resources/plate-reading.csv`);
  });

  it("with imageFolder='images' the picture goes to the note folder's images/ and the toast says so", async () => {
    const { v, write, writeAttachment, saved } = setup({ imageFolder: () => 'images' });
    v.contentDOM.dispatchEvent(dropEvent([csv(), png('gel.png')]));
    await flush();
    expect(writeAttachment).toHaveBeenCalledWith(`${EXP}/resources`, 'plate-reading.csv', expect.any(Uint8Array));
    expect(write).toHaveBeenCalledWith(`${EXP}/images`, 'gel.png', expect.any(Uint8Array));
    expect(saved.mock.calls[0][1].title).toBe('2 attachments saved');
    expect(saved.mock.calls[0][1].detail).toBe('plate-reading.csv → resources/\ngel.png → images/');
  });

  it('the setting is read at each paste, so a change applies at once', async () => {
    let folder: 'images' | 'resources' = 'images';
    const { v, write } = setup({ imageFolder: () => folder });
    v.contentDOM.dispatchEvent(pasteEvent([png()]));
    await flush();
    folder = 'resources';
    v.contentDOM.dispatchEvent(pasteEvent([png()]));
    await flush();
    expect(write.mock.calls.map((c) => c[0])).toEqual([`${EXP}/images`, `${EXP}/resources`]);
  });

  it('a dropped CSV is no longer swallowed: it is written and linked, without the "images only" notice', async () => {
    const { v, writeAttachment } = setup();
    const ev = dropEvent([csv()]);
    v.contentDOM.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    await flush();
    expect(writeAttachment).toHaveBeenCalledTimes(1);
    expect(v.state.doc.toString()).toBe('a[[plate-reading.csv]]');
    expect(notice).not.toHaveBeenCalled();
  });

  it('a pasted file (copied in Explorer) is taken too, under its own name', async () => {
    const { v, writeAttachment } = setup();
    v.contentDOM.dispatchEvent(pasteEvent([new File(['x'], 'report.pdf', { type: 'application/pdf' })]));
    await flush();
    expect(writeAttachment).toHaveBeenCalledWith(`${EXP}/resources`, 'report.pdf', expect.any(Uint8Array));
    expect(v.state.doc.toString()).toBe('a![[report.pdf]]');
  });

  it('an .exe is refused with a warning and the rest of the drop still goes through', async () => {
    const { v, writeAttachment } = setup();
    v.contentDOM.dispatchEvent(dropEvent([new File(['MZ'], 'setup.exe', { type: 'application/x-msdownload' }), csv()]));
    await flush();
    expect(notice).toHaveBeenCalledWith(t('attach.blocked', 'setup.exe'));
    expect(writeAttachment.mock.calls.map((c) => c[1])).toEqual(['plate-reading.csv']);
    expect(v.state.doc.toString()).toBe('a[[plate-reading.csv]]');
    notice.mockClear();
    const only = setup();
    only.v.contentDOM.dispatchEvent(dropEvent([new File(['x'], 'run.ps1', { type: '' })]));
    await flush();
    expect(only.writeAttachment).not.toHaveBeenCalled();
    expect(notice).toHaveBeenCalledWith(t('attach.blocked', 'run.ps1'));
    expect(only.v.state.doc.toString()).toBe('a');
  });

  it('a non-unique attachment name is linked by its vault path', async () => {
    const { v } = setup({ isUniqueAttachment: async () => false });
    v.contentDOM.dispatchEvent(dropEvent([csv()]));
    await flush();
    expect(v.state.doc.toString()).toBe(`a[[${EXP}/resources/plate-reading.csv]]`);
  });

  it('an attachment over 100 MiB is refused before its bytes are read', async () => {
    const { v, writeAttachment } = setup();
    const big = csv('huge.csv');
    Object.defineProperty(big, 'size', { value: 100 * 1024 * 1024 + 1 });
    v.contentDOM.dispatchEvent(dropEvent([big]));
    await flush();
    expect(writeAttachment).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(t('attach.saveFailed', 'huge.csv', t('attach.tooBig')));
    expect(v.state.doc.toString()).toBe('a');
  });

  it('a refused attachment write names the file; nothing is announced when nothing was saved', async () => {
    const { v, saved } = setup({ writeAttachment: async () => Promise.reject({ kind: 'badInput', message: 'not a resources folder' }) });
    v.contentDOM.dispatchEvent(dropEvent([csv()]));
    await flush();
    expect(toast).toHaveBeenCalledWith(t('attach.saveFailed', 'plate-reading.csv', 'not a resources folder'));
    expect(saved).not.toHaveBeenCalled();
  });

  it('the 50-file cap counts pictures and attachments together', async () => {
    const { v, write, writeAttachment } = setup();
    const files = [...Array.from({ length: 30 }, (_, i) => png(`p${i}.png`)), ...Array.from({ length: 25 }, (_, i) => csv(`c${i}.csv`))];
    v.contentDOM.dispatchEvent(dropEvent(files));
    await vi.waitFor(() => expect(v.state.field(pendingPaste)).toEqual([]), { timeout: 5000 });
    expect(write.mock.calls.length + writeAttachment.mock.calls.length).toBe(50);
    expect(notice).toHaveBeenCalledWith(t('live.image.tooMany', 50, 5));
  });

  it('dragging files over the editor says where they will go, and the hint clears on drop', async () => {
    setLang('ko');
    const { v } = setup();
    const over = (files: File[]) => {
      const ev = new MouseEvent('dragover', { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'dataTransfer', { value: dataTransfer(files) });
      v.contentDOM.dispatchEvent(ev);
    };
    over([csv()]);
    expect(v.state.field(dropHint)).toBe('resources/에 첨부');
    expect(v.dom.classList.contains('lno-drop-target')).toBe(true);
    expect(v.dom.getAttribute('data-drop-hint')).toBe('resources/에 첨부');
    v.contentDOM.dispatchEvent(dropEvent([csv()]));
    expect(v.state.field(dropHint)).toBeNull();
    expect(v.dom.classList.contains('lno-drop-target')).toBe(false);
    await flush();
    const images = setup({ imageFolder: () => 'images' });
    const ev = new MouseEvent('dragover', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'dataTransfer', { value: dataTransfer([csv(), png()]) });
    images.v.contentDOM.dispatchEvent(ev);
    expect(images.v.state.field(dropHint)).toBe('resources/ · images/에 첨부');
    // dragover 가 멈추면(편집기 밖으로 나감) 안내가 사라진다
    await new Promise((r) => setTimeout(r, DROP_HINT_MS + 50));
    expect(images.v.state.field(dropHint)).toBeNull();
  });

  it('no hint in a read-only editor', () => {
    const write = vi.fn<Write>();
    const ro = view('a', 1, { write, readOnly: true, deps: { writeAttachment: write } });
    const ev = new MouseEvent('dragover', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'dataTransfer', { value: dataTransfer([csv()]) });
    ro.contentDOM.dispatchEvent(ev);
    expect(ro.state.field(dropHint)).toBeNull();
  });

  it('with the window file-drop guard installed, a dropped CSV still reaches the editor and is written', async () => {
    const dispose = installFileDropGuard(window);
    try {
      const { v, writeAttachment } = setup();
      const ev = dropEvent([csv()]);
      Object.defineProperty(ev, 'composed', { value: true });
      v.contentDOM.dispatchEvent(ev);
      await flush();
      expect(writeAttachment).toHaveBeenCalledTimes(1);
      expect(v.state.doc.toString()).toBe('a[[plate-reading.csv]]');
    } finally {
      dispose();
    }
  });

  it('the default image folder is resources', async () => {
    const write = vi.fn<Write>(async (dir, name) => `${dir}/${name}`);
    const v = view('', 0, { notePath: NOTE, write, deps: { imageFolder: undefined } });
    v.contentDOM.dispatchEvent(pasteEvent([png()]));
    await flush();
    expect(write).toHaveBeenCalledWith(`${EXP}/resources`, NAME, expect.any(Uint8Array));
  });
});
