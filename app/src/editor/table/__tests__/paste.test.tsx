// @vitest-environment jsdom
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { history, undo, undoDepth } from '@codemirror/commands';
import { ensureSyntaxTree } from '@codemirror/language';
import { labnoteMarkdown } from '../../markdownSyntax';
import { tableExtension } from '../field';
import { activeCell, activeCellView, focusCell } from '../cellEditor';
import { isTabular } from '../tsv';

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
    expect(v.state.doc.toString()).toBe('앞\n\n| a | b |\n| --- | --- |\n| x<br>y | 2 |\n\n');
    expect(v.dom.querySelectorAll('.lno-table-wrap')).toHaveLength(1);
    expect(undoDepth(v.state)).toBe(1);
    undo(v);
    expect(v.state.doc.toString()).toBe('앞');
  });

  it('값은 바꾸지 않고(007, 1/2, 2E4), 파이프는 escape 하고, 짧은 행은 빈 칸으로 채운다', () => {
    const v = mount('');
    paste(v.contentDOM, '007\t1/2\r\n2E4\r\na|b\tc');
    expect(v.state.doc.toString()).toBe('| 007 | 1/2 |\n| --- | --- |\n| 2E4 |  |\n| a\\|b | c |\n\n');
  });

  it('줄 가운데에 붙이면 앞뒤에 빈 줄을 두어 표가 따로 선다', () => {
    const v = mount('앞뒤');
    v.dispatch({ selection: { anchor: 1 } });
    paste(v.contentDOM, 'a\tb');
    // 커서는 위아래에 빈 줄을 둔 빈 문단 줄: 거기 친 글이 뒤 글과 이어지지 않는다
    expect(v.state.doc.toString()).toBe('앞\n\n| a | b |\n| --- | --- |\n\n\n\n뒤');
    expect(v.state.selection.main.head).toBe(v.state.doc.length - 3);
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
    expect(v.state.doc.toString()).toBe('| a | b |\n| --- | --- |\n\n');
  });

  it('문서 끝에 붙인 표 뒤에는 빈 줄과 빈 문단 줄이 오고 커서는 그 줄에: Enter 와 이어 친 글이 표의 행이 되지 않는다', () => {
    const v = mount('앞');
    v.dispatch({ selection: { anchor: 1 } });
    paste(v.contentDOM, 'a\tb\n1\t2');
    const table = '| a | b |\n| --- | --- |\n| 1 | 2 |';
    expect(v.state.doc.toString()).toBe(`앞\n\n${table}\n\n`);
    expect(v.state.selection.main.head).toBe(v.state.doc.length);
    expect(undoDepth(v.state)).toBe(1);
    // 바로 친 글
    const typeAt = (s: string) => {
      const head = v.state.selection.main.head;
      v.dispatch({ changes: { from: head, insert: s }, selection: { anchor: head + s.length }, userEvent: 'input.type' });
    };
    typeAt('글');
    expect(v.state.doc.toString()).toBe(`앞\n\n${table}\n\n글`);
    // Enter 다음에 친 글
    typeAt('\n둘');
    expect(v.state.doc.toString()).toBe(`앞\n\n${table}\n\n글\n둘`);
    expect(v.dom.querySelectorAll('.lno-table-wrap tr')).toHaveLength(2);
    // 문서 가운데에서도 표 아래에 빈 문단 줄을 둔다
    const w = mount('앞\n뒤');
    w.dispatch({ selection: { anchor: 1 } });
    paste(w.contentDOM, 'a\tb');
    // 커서 줄 위아래에 빈 줄: 거기 친 글이 뒤 문단과 이어지지 않는다
    expect(w.state.doc.toString()).toBe('앞\n\n| a | b |\n| --- | --- |\n\n\n\n뒤');
    expect(w.state.selection.main.head).toBe(w.state.doc.length - 3);  });

  it('한글 입력 상태의 Ctrl+Shift+V(key 가 ㅍ 이나 Process 여도 code 는 KeyV)도 원문으로 붙인다', () => {
    for (const key of ['ㅍ', 'Process']) {
      const v = mount('');
      v.contentDOM.dispatchEvent(
        new KeyboardEvent('keydown', { key, code: 'KeyV', shiftKey: true, ctrlKey: !isMac, metaKey: isMac, bubbles: true, cancelable: true }),
      );
      paste(v.contentDOM, 'a\tb');
      expect(v.state.doc.toString(), key).toBe('a\tb');
    }
  });

  it('Ctrl+Shift+V 뒤에 붙여 넣기 없이 다른 키를 누르면 원문 붙여 넣기는 풀린다', () => {
    const v = mount('');
    plainPasteKey(v.contentDOM);
    // 클립보드가 비어 붙여 넣기 사건이 오지 않았다. 다음 보통 Ctrl+V 는 다시 표가 된다(수정 키만 누른 것은 풀지 않는다)
    v.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', ctrlKey: true, bubbles: true, cancelable: true }));
    v.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', code: 'KeyV', ctrlKey: !isMac, metaKey: isMac, bubbles: true, cancelable: true }));
    paste(v.contentDOM, 'a\tb');
    expect(v.state.doc.toString()).toBe('| a | b |\n| --- | --- |\n\n');
  });

  it('붙인 표 바로 뒤의 타이핑은 붙여 넣기와 다른 되돌리기 단계다', () => {
    const v = mount('');
    paste(v.contentDOM, 'a\tb');
    const pasted = v.state.doc.toString();
    v.dispatch({ changes: { from: pasted.length, insert: 'z' }, userEvent: 'input.type' });
    undo(v);
    expect(v.state.doc.toString()).toBe(pasted);
    undo(v);
    expect(v.state.doc.toString()).toBe('');
  });

  // 코드·머리말 안의 탭은 들여쓰기다: 표로 바꾸면 코드가 망가진다
  const rawCases: Array<{ name: string; doc: string; at: number; text: string; out: string }> = [
    { name: '울타리 코드 블록', doc: '```python\n\n```', at: 10, text: 'def f():\n\treturn 1', out: '```python\ndef f():\n\treturn 1\n```' },
    { name: '들여쓴 코드 블록', doc: '앞\n\n    x\n', at: 8, text: 'a\tb', out: '앞\n\n    xa\tb\n' },
    { name: '인라인 코드', doc: '글 `x` 끝', at: 3, text: 'a\tb', out: '글 `a\tbx` 끝' },
    { name: '머리말', doc: '---\ntitle: x\n---\n본문', at: 12, text: 'a\tb', out: '---\ntitle: xa\tb\n---\n본문' },
  ];
  for (const k of rawCases) {
    it(`${k.name} 안에서는 TSV 도 원문 그대로 붙는다`, () => {
      const v = mount(k.doc);
      ensureSyntaxTree(v.state, v.state.doc.length, 1000);
      v.dispatch({ selection: { anchor: k.at } });
      expect(isTabular(k.text)).toBe(true); // 밖에서였다면 표가 됐을 글이다: 막는 것은 코드·머리말 검사다
      paste(v.contentDOM, k.text);
      expect(v.state.doc.toString()).toBe(k.out);
    });
  }

  it('코드 블록 바로 뒤 줄에서는 다시 표가 된다', () => {
    const v = mount('```\nx\n```\n');
    v.dispatch({ selection: { anchor: v.state.doc.length } });
    paste(v.contentDOM, 'a\tb');
    expect(v.state.doc.toString()).toBe('```\nx\n```\n\n| a | b |\n| --- | --- |\n\n');
  });

  it('CRLF 문서에서는 CRLF 로 넣는다', () => {
    const v = mount('앞\r\n', [EditorState.lineSeparator.of('\r\n')]);
    v.dispatch({ selection: { anchor: v.state.doc.length } });
    paste(v.contentDOM, 'a\tb\r\n1\t2');
    expect(v.state.sliceDoc()).toBe('앞\r\n\r\n| a | b |\r\n| --- | --- |\r\n| 1 | 2 |\r\n\r\n');
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
