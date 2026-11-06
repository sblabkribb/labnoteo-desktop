// @vitest-environment jsdom
import { EditorState, Transaction, type RangeSet, type RangeValue } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { isolateHistory } from '@codemirror/commands';
import { labnoteMarkdown } from '../../markdownSyntax';
import { tableExtension } from '../../table/field';
import { livePlugin, livePreview } from '../index';

// jsdom 에는 레이아웃이 없다. CodeMirror 가 측정에 쓰는 API 만 빈 값으로 채운다.
const emptyRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
Range.prototype.getClientRects ??= emptyRects;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();

const views: EditorView[] = [];

/** 라이브 미리보기와 표 확장을 실은 편집기. 줄 구분자는 '\n' 이라 섞인 줄바꿈의 '\r' 이 줄 글자에 남는다(앱의 섞인 EOL 과 같다). */
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
        tableExtension({ save: () => {}, root: document }),
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

function rangesOf(sets: readonly RangeSet<RangeValue>[]): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  for (const s of sets) for (let it = s.iter(); it.value; it.next()) out.push({ from: it.from, to: it.to });
  return out.sort((a, b) => a.from - b.from || a.to - b.to);
}
const decoCount = (v: EditorView) => rangesOf([v.plugin(livePlugin)!.decorations]).length;
/** 한글 조합 중인 것처럼 꾸민다: view.composing / compositionStarted 는 inputState.composing 을 읽는다. */
const setComposing = (v: EditorView, on: boolean) => {
  (v as unknown as { inputState: { composing: number } }).inputState.composing = on ? 1 : -1;
};

describe('라이브 미리보기: 인라인 플러그인', () => {
  it('off-line heading hides "# " and gets lno-h2; the cursor line shows source', () => {
    const v = view('## Title\nbody', 12);
    expect(lineClasses(v, 1)).toContain('lno-h2');
    expect(visibleText(v, 1)).toBe('Title');
    move(v, 3);
    expect(visibleText(v, 1)).toBe('## Title');
  });

  it('bold marks hide off-node and reveal when the cursor touches the node', () => {
    const v = view('a **b** c\n', 10);
    expect(visibleText(v, 1)).toBe('a b c');
    move(v, 7);
    expect(visibleText(v, 1)).toBe('a **b** c');
  });

  it('inline code and highlight hide their marks and carry lno-code / lno-hl', () => {
    const v = view('`c` ==h== *i* ~~s~~\n', 21);
    expect(visibleText(v, 1)).toBe('c h i s');
    expect(lineEl(v, 1).querySelector('.lno-code')?.textContent).toBe('c');
    expect(lineEl(v, 1).querySelector('.lno-hl')?.textContent).toBe('h');
  });

  it('the plugin exposes its hidden ranges as atomic ranges', () => {
    const v = view('a **b** c\n', 10);
    expect(rangesOf(v.state.facet(EditorView.atomicRanges).map((f) => f(v)))).toEqual([
      { from: 2, to: 4 },
      { from: 5, to: 7 },
    ]);
  });

  it('maps decorations while composing and rebuilds after compositionend', () => {
    const v = view('# 제목\n', 0);
    const before = decoCount(v);
    setComposing(v, true);
    v.dispatch({ changes: { from: 4, insert: 'ㄱ' }, userEvent: 'input.type.compose' });
    expect(decoCount(v)).toBe(before);
    expect(v.plugin(livePlugin)!.pending).toBe(true);
    setComposing(v, false);
    v.dispatch({});
    expect(v.plugin(livePlugin)!.pending).toBe(false);
  });

  it('does not rebuild while composing even when the selection leaves a rendered element', () => {
    const v = view('a **b** c\n', 10);
    setComposing(v, true);
    move(v, 6);
    expect(visibleText(v, 1)).toBe('a b c'); // 조합 중에는 다시 만들지 않는다
    setComposing(v, false);
    v.dispatch({});
    expect(visibleText(v, 1)).toBe('a **b** c');
  });

  it('mixed-EOL heading line with trailing \r renders without a stray glyph', () =>
    expect(visibleText(view('# a\r\nb\n', 7), 1)).toBe('a'));

  it('a setext heading stays source', () => {
    const v = view('Title\n===\n\nx', 12);
    expect(visibleText(v, 1)).toBe('Title');
    expect(visibleText(v, 2)).toBe('===');
  });

  it('a table keeps its widget and gets no inline decorations inside its span', () => {
    const v = view('| a |\n| - |\n| **b** |\n\nx', 25);
    expect(v.contentDOM.querySelector('.lno-table-wrap')).not.toBeNull();
    expect(rangesOf([v.plugin(livePlugin)!.hidden])).toEqual([]);
  });

  it('front matter gets no inline decorations', () => {
    const v = view('---\ntitle: **a**\n---\nx', 22);
    expect(rangesOf([v.plugin(livePlugin)!.decorations])).toEqual([]);
  });

  it('a command batch replacing a rendered heading keeps the selection where the batch put it', () => {
    const v = view('## Title\nbody', 4);
    // what editTarget.batch dispatches
    v.dispatch({
      changes: { from: 3, to: 8, insert: 'New' },
      selection: { anchor: 6 },
      annotations: [isolateHistory.of('full'), Transaction.userEvent.of('input.labnote')],
    });
    expect(v.state.selection.main.head).toBe(6);
    expect(visibleText(v, 1)).toBe('## New');
  });
});
