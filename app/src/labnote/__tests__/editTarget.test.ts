// @vitest-environment jsdom
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { history, undo } from '@codemirror/commands';
import { editTargetFor, NoteChangedError } from '../editTarget';
import { NoteBusyError } from '../openNotes';
import { parseRaw, toRaw, lineSeparatorOf } from '../../editor/documentIo';

const emptyRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
Range.prototype.getClientRects ??= emptyRects;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();

const views: EditorView[] = [];
afterEach(() => views.splice(0).forEach((v) => v.destroy()));

/** 편집기와 같은 방식으로 원문을 읽어 뷰를 만든다. */
function viewOf(raw: string, opts: { sep?: '\n' | '\r\n'; anchor?: number; head?: number } = {}) {
  const doc = parseRaw('n.md', raw);
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc: doc.text,
      selection: opts.anchor === undefined ? undefined : { anchor: opts.anchor, head: opts.head ?? opts.anchor },
      extensions: [EditorState.lineSeparator.of(opts.sep ?? lineSeparatorOf(doc)), history()],
    }),
  });
  views.push(view);
  return { view, doc, saved: () => toRaw(doc, view.state.sliceDoc()) };
}

let busy = false;
beforeEach(() => (busy = false));
const target = (view: EditorView) => editTargetFor(view, 'n.md', () => busy);

describe('editTargetFor (direct)', () => {
  it("in a CRLF document (lineSeparator '\\r\\n'), replaceRange with a LF break makes two lines", async () => {
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({ doc: 'x\r\ny', extensions: [EditorState.lineSeparator.of('\r\n'), history()] }),
    });
    views.push(view);
    await target(view).replaceRange(1, 1, 'a\nb');
    expect(view.state.doc.lines).toBe(3);
    expect(view.state.sliceDoc()).toBe('xa\r\nb\r\ny');
  });

  it('a CRLF note loaded like the editor does saves CRLF after replaceRange', async () => {
    const { view, saved } = viewOf('x\r\ny\r\n');
    await target(view).replaceRange(1, 1, 'a\nb');
    expect(view.state.doc.lines).toBe(4);
    expect(saved()).toBe('xa\r\nb\r\ny\r\n');
  });

  it('in a mixed-EOL document, getText offsets round-trip into CodeMirror positions', async () => {
    const raw = 'a\r\nb\n### [x]\r\nc\n';
    const { view, doc, saved } = viewOf(raw);
    expect(doc.mixed).toBe(true);
    const t = target(view);
    const text = await t.getText();
    const i = text.indexOf('### [');
    await t.replaceRange(i, i, 'NEW ');
    expect(view.state.doc.toString().slice(i)).toMatch(/^NEW ### \[x]/);
    expect(saved()).toBe('a\r\nb\nNEW ### [x]\r\nc\n');
  });

  it('a whole-document replaceRange changes only the changed line and keeps the selection', async () => {
    const { view } = viewOf('one\ntwo\nthree\nfour\n', { anchor: 2 });
    const t = target(view);
    const before = await t.getText();
    await t.replaceRange(0, before.length, before.replace('three', 'THREE!'));
    expect(view.state.doc.toString()).toBe('one\ntwo\nTHREE!\nfour\n');
    expect(view.state.selection.main.head).toBe(2);
    undo(view);
    expect(view.state.doc.toString()).toBe(before); // one undo step
  });

  it('insertAtCursor replaces the selection; getCursorOffset is the selection start', async () => {
    const { view } = viewOf('hello world', { anchor: 11, head: 6 });
    const t = target(view);
    expect(await t.getCursorOffset!()).toBe(6);
    expect(await t.getSelectionRange!()).toEqual({ start: 6, end: 11 });
    await t.insertAtCursor('there');
    expect(view.state.doc.toString()).toBe('hello there');
    expect(view.state.selection.main.head).toBe(11);
    expect(await t.getSelectionRange!()).toBeUndefined();
  });

  it('one replaceRange is one undo step', async () => {
    const { view } = viewOf('abc\n');
    const t = target(view);
    await t.replaceRange(1, 2, 'X\nY');
    expect(view.state.doc.toString()).toBe('aX\nYc\n');
    undo(view);
    expect(view.state.doc.toString()).toBe('abc\n');
  });

  it('revealOffset moves the cursor', async () => {
    const { view } = viewOf('abc\ndef\n');
    await target(view).revealOffset!(5);
    expect(view.state.selection.main.head).toBe(5);
  });

  it('every method throws NoteBusyError while busy', async () => {
    const { view } = viewOf('abc');
    const t = target(view);
    busy = true;
    await expect(t.getText()).rejects.toBeInstanceOf(NoteBusyError);
    await expect(t.replaceRange(0, 0, 'x')).rejects.toBeInstanceOf(NoteBusyError);
    await expect(t.insertAtCursor('x')).rejects.toBeInstanceOf(NoteBusyError);
    await expect(t.getCursorOffset!()).rejects.toBeInstanceOf(NoteBusyError);
    await expect(t.getSelectionRange!()).rejects.toBeInstanceOf(NoteBusyError);
    await expect(t.revealOffset!(0)).rejects.toBeInstanceOf(NoteBusyError);
    await expect(t.batch(async () => 1)).rejects.toBeInstanceOf(NoteBusyError);
    expect(view.state.doc.toString()).toBe('abc');
  });
});

describe('editTargetFor().batch', () => {
  it('an insert and then a whole-document rewrite dispatch once; one undo restores; reveal lands in the final text', async () => {
    const original = '# W\n- [a]\n\n### [a]\nbody\n';
    const { view } = viewOf(original, { anchor: original.length });
    const t = target(view);
    let dispatches = 0;
    const orig = view.dispatch.bind(view);
    view.dispatch = ((...a: Parameters<EditorView['dispatch']>) => {
      dispatches++;
      return orig(...a);
    }) as EditorView['dispatch'];
    const result = await t.batch(async (b) => {
      const at = await b.getCursorOffset!();
      await b.insertAtCursor('\n### [b]\nnew\n');
      expect(view.state.doc.toString()).toBe(original); // nothing applied yet
      const text = await b.getText();
      expect(text.slice(at)).toBe('\n### [b]\nnew\n');
      await b.replaceRange(0, text.length, text.replace('- [a]\n', '- [a]\n- [b]\n'));
      const final = await b.getText();
      await b.revealOffset!(final.indexOf('### [b]'));
      return 'done';
    });
    expect(result).toBe('done');
    expect(dispatches).toBe(1);
    const final = '# W\n- [a]\n- [b]\n\n### [a]\nbody\n\n### [b]\nnew\n';
    expect(view.state.doc.toString()).toBe(final);
    expect(view.state.selection.main.head).toBe(final.indexOf('### [b]'));
    undo(view);
    expect(view.state.doc.toString()).toBe(original);
  });

  it('insertAtCursor inside a batch uses the captured selection mapped through earlier edits', async () => {
    const { view } = viewOf('abc\ndef\n', { anchor: 5 });
    await target(view).batch(async (b) => {
      await b.replaceRange(0, 0, 'XX\n');
      expect(await b.getCursorOffset!()).toBe(8);
      await b.insertAtCursor('!');
    });
    expect(view.state.doc.toString()).toBe('XX\nabc\nd!ef\n');
    expect(view.state.selection.main.head).toBe(9);
  });

  it('throws NoteChangedError and applies nothing when the note changed while fn awaited', async () => {
    const { view } = viewOf('abc');
    const t = target(view);
    await expect(
      t.batch(async (b) => {
        await b.replaceRange(0, 0, 'X');
        view.dispatch({ changes: { from: 3, insert: '!' } }); // the user typed meanwhile
      }),
    ).rejects.toBeInstanceOf(NoteChangedError);
    expect(view.state.doc.toString()).toBe('abc!');
  });

  it('applies nothing when fn throws, and refuses when the note became busy', async () => {
    const { view } = viewOf('abc');
    const t = target(view);
    await expect(
      t.batch(async (b) => {
        await b.replaceRange(0, 0, 'X');
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(
      t.batch(async (b) => {
        await b.replaceRange(0, 0, 'X');
        busy = true;
      }),
    ).rejects.toBeInstanceOf(NoteBusyError);
    expect(view.state.doc.toString()).toBe('abc');
  });
});
