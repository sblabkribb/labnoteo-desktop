// @vitest-environment jsdom
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { history, undo, undoDepth } from '@codemirror/commands';
import { labnoteMarkdown } from '../../markdownSyntax';
import { tableExtension } from '../field';
import { activeCell, activeCellView, focusCell } from '../cellEditor';

// jsdom 에는 레이아웃이 없다. CodeMirror 가 측정에 쓰는 API 만 빈 값으로 채운다.
const emptyRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
Range.prototype.getClientRects ??= emptyRects;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();
document.execCommand ??= () => false;

const views: EditorView[] = [];

function mount(doc: string, extra: Extension[] = []): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [history(), labnoteMarkdown(), tableExtension({ save: () => {}, root: document }), ...extra],
    }),
  });
  views.push(view);
  return view;
}

afterEach(() => {
  while (views.length) views.pop()!.destroy();
  document.body.innerHTML = '';
});

/** 클립보드의 text/plain 을 가진 붙여 넣기 사건. jsdom 에는 ClipboardEvent 의 clipboardData 가 없다. */
function paste(target: Element, text: string): boolean {
  const ev = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'clipboardData', {
    value: { getData: (type: string) => (type === 'text/plain' ? text : ''), types: ['text/plain'] },
  });
  return target.dispatchEvent(ev);
}

const isMac = /Mac/.test(navigator.platform);
/** Ctrl+Shift+V(맥은 Cmd+Shift+V): 브라우저는 이 키 다음에 서식 없는 붙여 넣기 사건을 보낸다. */
function plainPasteKey(target: Element): void {
  target.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'V', shiftKey: true, ctrlKey: !isMac, metaKey: isMac, bubbles: true, cancelable: true }),
  );
}

describe('바깥 편집기에 붙여 넣기', () => {
  it('Excel 의 TSV(따옴표 안 줄바꿈 포함)는 첫 행이 머리 행인 새 표가 된다 (되돌리기 한 번)', () => {
    const v = mount('앞');
    v.dispatch({ selection: { anchor: 1 } });
    paste(v.contentDOM, 'a\tb\r\n"x\r\ny"\t2\r\n');
    expect(v.state.doc.toString()).toBe('앞\n\n| a | b |\n| --- | --- |\n| x<br>y | 2 |');
    expect(v.dom.querySelectorAll('.lno-table-wrap')).toHaveLength(1);
    expect(undoDepth(v.state)).toBe(1);
    undo(v);
    expect(v.state.doc.toString()).toBe('앞');
  });

  it('값은 바꾸지 않고(007, 1/2, 2E4), 파이프는 escape 하고, 짧은 행은 빈 칸으로 채운다', () => {
    const v = mount('');
    paste(v.contentDOM, '007\t1/2\r\n2E4\r\na|b\tc');
    expect(v.state.doc.toString()).toBe('| 007 | 1/2 |\n| --- | --- |\n| 2E4 |  |\n| a\\|b | c |');
  });

  it('줄 가운데에 붙이면 앞뒤에 빈 줄을 두어 표가 따로 선다', () => {
    const v = mount('앞뒤');
    v.dispatch({ selection: { anchor: 1 } });
    paste(v.contentDOM, 'a\tb');
    expect(v.state.doc.toString()).toBe('앞\n\n| a | b |\n| --- | --- |\n\n뒤');
  });

  it('표가 아닌 글은 그대로 붙는다', () => {
    const v = mount('');
    paste(v.contentDOM, 'hello');
    expect(v.state.doc.toString()).toBe('hello');
  });

  it('Ctrl+Shift+V 는 서식 없이 원문 그대로 붙인다', () => {
    const v = mount('');
    plainPasteKey(v.contentDOM);
    paste(v.contentDOM, 'a\tb\nc\td');
    expect(v.state.doc.toString()).toBe('a\tb\nc\td');
    // 한 번뿐이다: 다음 붙여 넣기는 다시 표가 된다
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: '' } });
    paste(v.contentDOM, 'a\tb');
    expect(v.state.doc.toString()).toBe('| a | b |\n| --- | --- |');
  });

  it('CRLF 문서에서는 CRLF 로 넣는다', () => {
    const v = mount('앞\r\n', [EditorState.lineSeparator.of('\r\n')]);
    v.dispatch({ selection: { anchor: v.state.doc.length } });
    paste(v.contentDOM, 'a\tb\r\n1\t2');
    expect(v.state.sliceDoc()).toBe('앞\r\n\r\n| a | b |\r\n| --- | --- |\r\n| 1 | 2 |');
  });
});

describe('칸 안에 붙여 넣기', () => {
  const T = '| a | b |\n| --- | --- |\n| 1 | 2 |\n';

  it('2×3 TSV 는 그 칸부터 사각형을 채우고 표를 늘린다 (되돌리기 한 번)', () => {
    const v = mount(T);
    focusCell(v, 0, 1, 1);
    paste(activeCellView(v)!.contentDOM, 'p\tq\tr\r\ns\tt\tu\r\n');
    expect(v.state.doc.toString()).toBe('| a | b |  |  |\n| --- | --- | --- | --- |\n| 1 | p | q | r |\n|  | s | t | u |\n');
    expect(v.state.field(activeCell)).toEqual({ tableFrom: 0, r: 1, c: 1 });
    expect(activeCellView(v)!.state.doc.toString()).toBe('p');
    expect(undoDepth(v.state)).toBe(1);
    undo(v);
    expect(v.state.doc.toString()).toBe(T);
  });

  it('값 하나는 보통 글자처럼 붙고 파이프는 escape 된다', () => {
    const v = mount(T);
    focusCell(v, 0, 1, 1, 'end');
    paste(activeCellView(v)!.contentDOM, 'a|b');
    expect(v.state.doc.toString()).toBe('| a | b |\n| --- | --- |\n| 1 | 2a\\|b |\n');
  });

  it('Ctrl+Shift+V 는 칸 안에서도 원문 그대로 붙인다', () => {
    const v = mount(T);
    focusCell(v, 0, 1, 0, 'end');
    const nv = activeCellView(v)!;
    plainPasteKey(nv.contentDOM);
    paste(nv.contentDOM, 'x\ty');
    expect(v.state.doc.toString()).toBe('| a | b |\n| --- | --- |\n| 1x\ty | 2 |\n');
  });
});
