// @vitest-environment jsdom
import { EditorState, Prec, type Extension, type Transaction } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, undo } from '@codemirror/commands';
import { insertNewlineContinueMarkup } from '@codemirror/lang-markdown';
import { labnoteMarkdown } from '../../markdownSyntax';
import { tableExtension } from '../../table/field';
import { activeCell, activeCellView, focusCell as openCell } from '../../table/cellEditor';
import { livePreview } from '../index';
import { LIST_KEYS, indentListItem } from '../listKeys';

// jsdom 에는 레이아웃이 없다. CodeMirror 가 측정에 쓰는 API 만 빈 값으로 채운다.
const emptyRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
Range.prototype.getClientRects ??= emptyRects;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();
// 셀 편집기에 포커스를 줄 때 CodeMirror 가 execCommand 를 부른다(jsdom 에는 없다).
document.execCommand ??= () => false;

const views: EditorView[] = [];

/** 편집기(Editor.tsx)와 같은 순서: 목록 키(Prec.high), 기본 keymap, 마크다운(자체 keymap 끔), 라이브 미리보기, 표. */
function view(doc: string, pos: number, extra: Extension[] = []): EditorView {
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
        ...extra,
      ],
    }),
  });
  views.push(v);
  return v;
}

afterEach(() => {
  while (views.length) views.pop()!.destroy();
  document.body.innerHTML = '';
});

const lineEl = (v: EditorView, n: number) => v.contentDOM.querySelectorAll<HTMLElement>('.cm-line')[n - 1];
const lineClasses = (v: EditorView, n: number) => Array.from(lineEl(v, n).classList);
const visibleText = (v: EditorView, n: number) => lineEl(v, n).textContent;
const move = (v: EditorView, pos: number) => v.dispatch({ selection: { anchor: pos } });
/** 한글 조합 중인 것처럼 꾸민다: view.composing 은 inputState.composing 을 읽는다. */
const setComposing = (v: EditorView, on: boolean) => {
  (v as unknown as { inputState: { composing: number } }).inputState.composing = on ? 1 : -1;
};
function press(v: EditorView, key: string, opts: KeyboardEventInit = {}): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts });
  v.contentDOM.dispatchEvent(ev);
  return ev;
}
async function focusCell(doc: string, r: number, c: number): Promise<{ outer: EditorView; cell: EditorView }> {
  const outer = view(doc, doc.length);
  expect(openCell(outer, 0, r, c)).toBe(true);
  await Promise.resolve();
  return { outer, cell: activeCellView(outer)! };
}
const activeCellPos = (outer: EditorView) => {
  const ac = outer.state.field(activeCell);
  return ac && { row: ac.r, col: ac.c };
};

describe('라이브 미리보기: 목록', () => {
  it('off-line "- a" shows a bullet widget; the cursor line shows "- "', () => {
    const v = view('- a\nx', 5);
    expect(v.contentDOM.querySelectorAll('.lno-bullet')).toHaveLength(1);
    expect(v.contentDOM.querySelector('.lno-bullet')!.getAttribute('aria-hidden')).toBe('true');
    move(v, 1);
    expect(v.contentDOM.querySelector('.lno-bullet')).toBeNull();
    expect(visibleText(v, 1)).toBe('- a');
  });

  it('nested list depth classes', () => {
    const v = view('- a\n  - b\n    - c\nx', 19);
    expect(lineClasses(v, 1)).toEqual(expect.arrayContaining(['lno-li', 'lno-li-d1']));
    expect(lineClasses(v, 3)).toContain('lno-li-d3');
  });

  it('ordered-list numbers stay text, marked lno-ol-mark', () => {
    const v = view('1. a\n2. b\nx', 10);
    expect(visibleText(v, 1)).toBe('1. a');
    expect(lineEl(v, 2).querySelector('.lno-ol-mark')?.textContent).toBe('2.');
  });

  it('Enter on "- a" continues with "- "; Enter on the empty item ends the list', () => {
    const v = view('- a', 3);
    press(v, 'Enter');
    expect(v.state.doc.toString()).toBe('- a\n- ');
    expect(v.state.selection.main.head).toBe(6);
    press(v, 'Enter');
    expect(v.state.doc.toString()).not.toMatch(/^- $/m);
    expect(v.state.doc.line(v.state.doc.lines).text).toBe('');
  });

  it('exactly one Enter handler, inert during composition', () => {
    const v = view('- a', 3);
    const enter = v.state.facet(keymap).flat().filter((b) => b.key === 'Enter');
    expect(enter.some((b) => b.run === insertNewlineContinueMarkup)).toBe(false); // the built-in keymap is off
    press(v, 'Enter');
    expect(v.state.doc.toString()).toBe('- a\n- ');
    undo(v);
    setComposing(v, true);
    press(v, 'Enter', { keyCode: 229, isComposing: true });
    expect(v.state.doc.toString()).toBe('- a');
  });

  it('Tab nests a bullet item, Shift+Tab reverses it, one undo restores', () => {
    const v = view('- a\n- b', 7);
    expect(press(v, 'Tab').defaultPrevented).toBe(true);
    expect(v.state.doc.toString()).toBe('- a\n  - b');
    press(v, 'Tab', { shiftKey: true });
    expect(v.state.doc.toString()).toBe('- a\n- b');
    press(v, 'Tab');
    undo(v);
    expect(v.state.doc.toString()).toBe('- a\n- b');
  });

  it('Tab on an ordered item uses the content column and renumbers siblings', () => {
    const v = view('1. a\n2. b\n3. c', 9);
    press(v, 'Tab');
    expect(v.state.doc.toString()).toBe('1. a\n   1. b\n2. c');
  });

  it('Shift+Tab on a nested ordered item renumbers both lists', () => {
    const v = view('1. a\n   1. b\n   2. c\n2. d', 12);
    press(v, 'Tab', { shiftKey: true });
    expect(v.state.doc.toString()).toBe('1. a\n2. b\n   1. c\n3. d');
  });

  it('Tab on a task line nests it', () => {
    const v = view('- [ ] a\n- [ ] b', 15);
    press(v, 'Tab');
    expect(v.state.doc.toString()).toBe('- [ ] a\n  - [ ] b');
  });

  it('Tab carries the item children along', () => {
    const v = view('- a\n- b\n  - c', 7);
    press(v, 'Tab');
    expect(v.state.doc.toString()).toBe('- a\n  - b\n    - c');
  });

  it('Tab is one input.indent transaction; inert while composing or read-only', () => {
    const seen: Transaction[] = [];
    const v = view('- a\n- b', 7, [EditorView.updateListener.of((u) => seen.push(...u.transactions))]);
    setComposing(v, true);
    expect(indentListItem(v)).toBe(false);
    setComposing(v, false);
    press(v, 'Tab');
    const changed = seen.filter((tr) => tr.docChanged);
    expect(changed).toHaveLength(1);
    expect(changed[0].isUserEvent('input.indent')).toBe(true);
    const ro = view('- a\n- b', 7, [EditorState.readOnly.of(true)]);
    expect(indentListItem(ro)).toBe(false);
    expect(ro.state.doc.toString()).toBe('- a\n- b');
  });

  it('Tab on a non-list line is not consumed', () => {
    const v = view('x', 1);
    expect(press(v, 'Tab').defaultPrevented).toBe(false);
    expect(v.state.doc.toString()).toBe('x');
  });

  it('Tab inside a table cell still moves to the next cell', async () => {
    const { outer, cell } = await focusCell('| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |\n', 2, 0);
    press(cell, 'Tab');
    expect(activeCellPos(outer)).toEqual({ row: 2, col: 1 });
  });
});
