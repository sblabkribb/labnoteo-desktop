import type { Range } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import { revealInline, revealLine, skipRanges, touchedLines } from './reveal';
import { isRealLink, unitOpHeading, type UnitOpKind } from './links';
import { t } from '../../i18n/t';

/**
 * 라이브 미리보기의 인라인 플러그인(계획 D4). 보이는 범위(visibleRanges)만 훑어 다음을 단다:
 * - 줄 클래스: ATX 제목(lno-h1..lno-h6). Setext 제목은 원문 그대로 둔다.
 * - 숨김(replace): 제목의 `# `, 강조·취소선·인라인 코드·하이라이트의 구분 기호. 줄바꿈을 넘는 숨김은 없다.
 * - 표시(mark): 인라인 코드 내용(lno-code), 하이라이트 내용(lno-hl).
 * - 링크(links.ts): 진짜 링크(isRealLink)는 `[` 와 `](주소)` 를 숨기고 글을 lno-link 로, 위키링크는 표시와
 *   (별칭이 있으면) 대상을 숨기고 보이는 글을 lno-wikilink 로. 유닛 오퍼레이션·워크플로 제목은 링크로 그리지 않고
 *   대괄호를 숨긴 뒤 코드를 칩(lno-chip lno-uo-code lno-uo-…)으로 단다.
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
const wikiMark = Decoration.mark({ class: 'lno-wikilink' });
const chipMark: Record<UnitOpKind, Decoration> = {
  UHW: Decoration.mark({ class: 'lno-chip lno-uo-code lno-uo-uhw' }),
  USW: Decoration.mark({ class: 'lno-chip lno-uo-code lno-uo-usw' }),
  WB: Decoration.mark({ class: 'lno-chip lno-uo-code lno-uo-wb' }),
  other: Decoration.mark({ class: 'lno-chip lno-uo-code lno-uo-other' }),
};

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
    // 플러그인의 바꾸기 장식은 줄바꿈을 넘으면 CodeMirror 가 던진다: 줄 끝을 지나는 범위는 아예 숨기지 않는다
    if (from >= to || to > state.doc.lineAt(from).to) return;
    const r = hide.range(from, to);
    decos.push(r);
    hides.push(r);
  };
  const skips = skipRanges(state);
  const lines = touchedLines(state);
  const tree = syntaxTree(state);
  // 링크의 제목 글(title)은 그릴 때 읽는다: 언어를 바꾸면 다음 다시 그리기부터 새 언어다
  const linkMark = Decoration.mark({ class: 'lno-link', attributes: { title: t('live.link.title') } });
  /** 유닛 오퍼레이션·워크플로 제목 줄: 그 줄의 Link 는 링크로 그리지 않는다. */
  const unitOpLines = new Set<number>();
  const sameLine = (from: number, to: number) => state.doc.lineAt(from).number === state.doc.lineAt(to).number;

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

  /** `## [WB010 …]`, `### [UHW010 …]`: 코드 칩은 늘 달고, 대괄호는 줄이 드러나지 않았을 때만 숨긴다. */
  const unitOp = (node: SyntaxNode, level: number) => {
    if (level !== 2 && level !== 3) return;
    const line = state.doc.lineAt(node.from);
    const uo = unitOpHeading(line.text);
    if (!uo) return;
    unitOpLines.add(line.number);
    decos.push(chipMark[uo.kind].range(line.from + uo.codeFrom, line.from + uo.codeTo));
    if (revealLine(state, line.number, lines)) return;
    conceal(line.from + uo.open, line.from + uo.open + 1);
    conceal(line.from + uo.close, line.from + uo.close + 1);
  };

  /** 진짜 링크: 글은 lno-link(드러나도 Ctrl+클릭이 되게), 드러나지 않았으면 `[` 와 `](주소 "제목")` 을 숨긴다. */
  const link = (node: SyntaxNode) => {
    if (unitOpLines.has(state.doc.lineAt(node.from).number) || !isRealLink(node)) return;
    const open = node.firstChild;
    let close: SyntaxNode | null = null;
    for (let c = open?.nextSibling ?? null; c; c = c.nextSibling)
      if (c.name === 'LinkMark' && state.sliceDoc(c.from, c.to) === ']') {
        close = c;
        break;
      }
    if (!open || open.name !== 'LinkMark' || !close) return;
    if (open.to < close.from) decos.push(linkMark.range(open.to, close.from));
    // 숨김은 줄바꿈을 넘지 않는다: 여러 줄에 걸친 링크는 원문 그대로 둔다
    if (!sameLine(node.from, node.to) || revealInline(state, node.from, node.to)) return;
    conceal(open.from, open.to);
    conceal(close.from, node.to);
  };

  /** 위키링크: 보이는 글(별칭, 없으면 대상)만 남기고 나머지를 숨긴다. 드러나면 대괄호 안을 lno-wikilink 로. */
  const wikiLink = (node: SyntaxNode) => {
    const target = node.getChild('WikiTarget');
    if (!target) return;
    const shown = node.getChild('WikiAlias') ?? target;
    if (revealInline(state, node.from, node.to)) {
      const first = node.firstChild!;
      const last = node.lastChild!;
      if (first.to < last.from) decos.push(wikiMark.range(first.to, last.from));
      return;
    }
    decos.push(wikiMark.range(shown.from, shown.to));
    conceal(node.from, shown.from);
    conceal(shown.to, node.to);
  };

  // 접힌 곳·표 틈으로 나뉜 보이는 범위들에 걸친 노드는 범위마다 다시 들어온다: 한 번만 장식한다
  const seen = new Set<string>();
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (ref) => {
        // 구역 안에 통째로 든 노드만 건너뛴다. 걸치기만 한 부모(Document 등)는 내려가야 본문이 그려진다.
        if (skips.some((s) => ref.from >= s.from && ref.to <= s.to)) return false;
        const key = `${ref.name}:${ref.from}`;
        if (seen.has(key)) return;
        seen.add(key);
        const m = /^ATXHeading([1-6])$/.exec(ref.name);
        if (m) {
          heading(ref.node, Number(m[1]));
          unitOp(ref.node, Number(m[1]));
          return;
        }
        if (ref.name === 'Link') {
          link(ref.node);
          return;
        }
        if (ref.name === 'WikiLink') {
          wikiLink(ref.node);
          return false;
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
