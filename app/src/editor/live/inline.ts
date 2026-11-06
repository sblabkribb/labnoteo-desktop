import type { Range } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import { revealInline, revealLine, skipRanges, touchedLines } from './reveal';

/**
 * 라이브 미리보기의 인라인 플러그인(계획 D4). 보이는 범위(visibleRanges)만 훑어 다음을 단다:
 * - 줄 클래스: ATX 제목(lno-h1..lno-h6). Setext 제목은 원문 그대로 둔다.
 * - 숨김(replace): 제목의 `# `, 강조·취소선·인라인 코드·하이라이트의 구분 기호. 줄바꿈을 넘는 숨김은 없다.
 * - 표시(mark): 인라인 코드 내용(lno-code), 하이라이트 내용(lno-hl).
 *
 * 무엇을 원문으로 보일지는 reveal.ts 가 정한다. 표 구역과 머리말은 건너뛴다(skipRanges).
 * 한글 조합 중에는 다시 만들지 않고 바뀐 위치로 옮기기만 한다: 조합 중인 줄에 장식을 더하거나 빼면 IME 가 깨진다.
 * 조합이 끝난 뒤 첫 갱신(pending)에서 다시 만든다.
 */

/** 숨김 표시 하나를 모든 곳에서 같이 쓴다. */
const hide = Decoration.replace({});
const headingLine = [1, 2, 3, 4, 5, 6].map((n) => Decoration.line({ class: `lno-h${n}` }));
const codeMark = Decoration.mark({ class: 'lno-code' });
const highlightMark = Decoration.mark({ class: 'lno-hl' });

/** 인라인 노드 이름 → 숨길 구분 기호 노드 이름과 내용에 붙일 표시. */
const INLINE: Record<string, { mark: string; content?: Decoration }> = {
  Emphasis: { mark: 'EmphasisMark' },
  StrongEmphasis: { mark: 'EmphasisMark' },
  Strikethrough: { mark: 'StrikethroughMark' },
  InlineCode: { mark: 'CodeMark', content: codeMark },
  Highlight: { mark: 'HighlightMark', content: highlightMark },
};

const isBlank = (ch: string) => ch === ' ' || ch === '\t';

export function buildDecorations(view: EditorView): { decorations: DecorationSet; hidden: DecorationSet } {
  const { state } = view;
  const decos: Range<Decoration>[] = [];
  const hides: Range<Decoration>[] = [];
  const conceal = (from: number, to: number) => {
    if (from >= to) return;
    const r = hide.range(from, to);
    decos.push(r);
    hides.push(r);
  };
  const skips = skipRanges(state);
  const lines = touchedLines(state);
  const tree = syntaxTree(state);

  const heading = (node: SyntaxNode, level: number) => {
    const line = state.doc.lineAt(node.from);
    decos.push(headingLine[level - 1].range(line.from));
    if (revealLine(state, line.number, lines)) return;
    const text = line.text;
    let first = true;
    for (let m = node.firstChild; m; m = m.nextSibling) {
      if (m.name !== 'HeaderMark') continue;
      if (first) {
        // 여는 `#` 와 그 뒤 공백. 줄 끝의 '\r' 은 공백으로 치지 않는다(아래에서 따로 숨긴다).
        let end = m.to;
        while (end < line.to && isBlank(text[end - line.from])) end++;
        conceal(m.from, end);
        first = false;
      } else {
        // 닫는 `##` 와 그 앞 공백
        let start = m.from;
        while (start > line.from && isBlank(text[start - 1 - line.from])) start--;
        conceal(start, m.to);
      }
    }
    // 섞인 줄바꿈 노트의 줄 끝 '\r': 그대로 두면 특수 문자 표시가 제목 끝에 남는다
    if (text.endsWith('\r')) conceal(line.to - 1, line.to);
  };

  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (ref) => {
        if (skips.some((s) => ref.from < s.to && ref.to > s.from)) return false;
        const m = /^ATXHeading([1-6])$/.exec(ref.name);
        if (m) {
          heading(ref.node, Number(m[1]));
          return;
        }
        const spec = INLINE[ref.name];
        if (!spec) return;
        const node = ref.node;
        const marks: SyntaxNode[] = [];
        for (let c = node.firstChild; c; c = c.nextSibling) if (c.name === spec.mark) marks.push(c);
        if (spec.content && marks.length >= 2 && marks[0].to < marks[marks.length - 1].from)
          decos.push(spec.content.range(marks[0].to, marks[marks.length - 1].from));
        if (revealInline(state, node.from, node.to)) return;
        for (const mk of marks) conceal(mk.from, mk.to);
      },
    });
  }
  return { decorations: Decoration.set(decos, true), hidden: Decoration.set(hides, true) };
}

class LivePlugin {
  decorations: DecorationSet;
  /** 실제로 단 숨김만. 원자 범위(atomicRanges)로 내보낸다. */
  hidden: DecorationSet;
  /** 조합 중에 옮기기만 하고 다시 만들지 않았다: 조합이 끝난 뒤 첫 갱신에서 다시 만든다. */
  pending = false;

  constructor(view: EditorView) {
    ({ decorations: this.decorations, hidden: this.hidden } = buildDecorations(view));
  }

  update(u: ViewUpdate) {
    if (u.view.composing || u.view.compositionStarted) {
      if (u.docChanged) {
        this.decorations = this.decorations.map(u.changes);
        this.hidden = this.hidden.map(u.changes);
      }
      this.pending = true;
      return;
    }
    if (this.pending || u.docChanged || u.selectionSet || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) {
      ({ decorations: this.decorations, hidden: this.hidden } = buildDecorations(u.view));
      this.pending = false;
    }
  }
}

export type { LivePlugin };

export const livePlugin = ViewPlugin.fromClass(LivePlugin, { decorations: (p) => p.decorations });
