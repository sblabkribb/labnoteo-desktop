import type { Extension, Range } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import { isFenceMark, revealInline, revealLine, skipRanges, touchedLines } from './reveal';
import { isRealLink, unitOpHeading, type UnitOpKind } from './links';
import { t } from '../../i18n/t';
import type { Lang } from '../../i18n/lang';
import { editorLang, langChanged } from './editorLang';
import { CheckboxWidget, LabelWidget, bulletWidget, toggleTaskAt } from './widgets';
import { isImageTarget, resolveImagePath, splitAltSize } from './imagePath';
import { ImageWidget, imageLoader } from './imageWidget';
import { linkResolution, linkStateOf } from './linkResolution';

/**
 * 라이브 미리보기의 인라인 플러그인(계획 D4). 보이는 범위(visibleRanges)만 훑어 다음을 단다:
 * - 줄 클래스: ATX 제목(lno-h1..lno-h6). Setext 제목은 원문 그대로 둔다.
 * - 숨김(replace): 제목의 `# `, 강조·취소선·인라인 코드·하이라이트의 구분 기호. 줄바꿈을 넘는 숨김은 없다.
 * - 표시(mark): 인라인 코드 내용(lno-code), 하이라이트 내용(lno-hl).
 * - 목록: 항목 줄에 lno-li 와 깊이 클래스(lno-li-d1..lno-li-d8, 8 에서 멈춘다). 글머리 기호(`- ` 등)는 줄이 드러나지
 *   않았을 때 점 위젯(BulletWidget)으로 바꾸고, 번호 목록의 번호는 글자 그대로 두고 lno-ol-mark 로 표시한다.
 * - 링크(links.ts): 진짜 링크(isRealLink)는 `[` 와 `](주소)` 를 숨기고 글을 lno-link 로, 위키링크는 표시와
 *   (별칭이 있으면) 대상을 숨기고 보이는 글을 lno-wikilink 로. 유닛 오퍼레이션·워크플로 제목은 링크로 그리지 않고
 *   대괄호를 숨긴 뒤 코드를 칩(lno-chip lno-uo-code lno-uo-…)으로 단다.
 * - 할 일: 줄이 드러나지 않았으면 `- ` 를 숨기고 `[ ]`·`[x]` 를 체크박스(CheckboxWidget)로 바꾼다. 끝난 항목 줄은
 *   lno-task-done. 누름은 taskHandlers 가 받는다.
 * - 인용: 모든 줄에 lno-quote, 줄이 드러나지 않았으면 `> ` 를 숨긴다. 첫 줄이 `> [!type]` 이면 콜아웃: 모든 줄에
 *   lno-callout lno-callout-<type>(모르는 종류는 note), 드러나지 않은 첫 줄은 `[!type]` 을 숨기고 나머지를 lno-callout-title 로.
 * - 울타리 코드 블록: 모든 줄에 lno-codeblock, 첫·끝 줄에 -first·-last, 울타리 줄에 lno-fence(흐리게, 숨기지 않는다).
 *   블록 안은 장식하지 않는다.
 * - 가로줄: 줄에 lno-hr, 드러나지 않았으면 글을 빈 인라인 바꾸기로 숨긴다.
 * - 스캔 주석(`<!-- labnoteo-scan …`): 그 줄에 lno-scan-meta(흐리고 작게).
 * - 이미지(`![alt](경로)`, `![[x.png|200]]`): 대상이 이미지 파일(isImageTarget)이면 ImageWidget. 커서 줄이 아니면 원문을
 *   위젯으로 바꾸고, 커서 줄이면 원문을 두고 그 뒤(side 1)에 위젯을 단다. 이미지가 아닌 `![[노트]]` 는 위키링크처럼 그린다.
 *
 * - 링크 풀이(linkResolution.ts): 대상이 없는 위키링크·임베드는 lno-wikilink lno-unresolved(누르면 만든다는 제목),
 *   없는 노트로 가는 마크다운 링크는 lno-link lno-unresolved. 풀이가 아직 없으면(색인 준비 전) 아무것도 흐리게 그리지 않는다.
 * - 맨 주소(GFM 의 맨 URL, `<https://…>` 자동 링크)는 lno-link 표시를 단다(D4: 링크와 같은 누름 규칙).
 *
 * - UO Meta 의 `- Experimenter:`: 줄이 드러나지 않았으면 `Experimenter` 를 지역화한 이름(실험자)으로 보인다(파일은 그대로).
 *
 * 무엇을 원문으로 보일지는 reveal.ts 가 정한다. 표 구역과 머리말은 건너뛴다(skipRanges).
 * 한글 조합 중에는 다시 만들지 않고 바뀐 위치로 옮기기만 한다: 조합 중인 줄에 장식을 더하거나 빼면 IME 가 깨진다.
 * 조합이 끝난 뒤 첫 갱신(pending)에서 다시 만든다.
 */

const LABNOTE = '.labnote';

/**
 * Where a wikilink target's path (before the first '#') ends in `.labnote` (any case), or -1. A path that is only
 * `.labnote` keeps it: hiding it would leave nothing to read.
 */
function labnoteSuffixAt(target: string): number {
  const hash = target.indexOf('#');
  const path = hash < 0 ? target : target.slice(0, hash);
  const at = path.length - LABNOTE.length;
  if (at <= 0 || path.slice(at).toLowerCase() !== LABNOTE || path[at - 1] === '/') return -1;
  return at;
}

/** 숨김 표시 하나를 모든 곳에서 같이 쓴다. */
const hide = Decoration.replace({});
const headingLine = [1, 2, 3, 4, 5, 6].map((n) => Decoration.line({ class: `lno-h${n}` }));
const codeMark = Decoration.mark({ class: 'lno-code' });
const highlightMark = Decoration.mark({ class: 'lno-hl' });
const wikiMark = Decoration.mark({ class: 'lno-wikilink' });
/** 링크의 부모가 이것이면 그 URL 은 맨 주소가 아니다(링크 대상, 이미지 경로, 참조 정의). */
const NOT_BARE_URL = new Set(['Link', 'Image', 'LinkReference']);
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

/** 목록 깊이의 끝. 더 깊은 항목도 lno-li-d8 이다. */
const MAX_LIST_DEPTH = 8;
const listLine = Array.from({ length: MAX_LIST_DEPTH }, (_, i) => Decoration.line({ class: `lno-li lno-li-d${i + 1}` }));
const olMark = Decoration.mark({ class: 'lno-ol-mark' });
const bullet = Decoration.replace({ widget: bulletWidget });
/** 언어마다 체크박스 장식 한 벌(이름표가 언어를 따른다). */
const checkboxes = new Map<Lang, Decoration[]>();
const checkboxFor = (lang: Lang): Decoration[] => {
  let set = checkboxes.get(lang);
  if (!set) checkboxes.set(lang, (set = [false, true].map((checked) => Decoration.replace({ widget: new CheckboxWidget(checked, lang) }))));
  return set;
};
const taskDoneLine = Decoration.line({ class: 'lno-task-done' });

const quoteLine = Decoration.line({ class: 'lno-quote' });
/** 콜아웃 첫 줄. 인용 노드의 시작(`>`)부터 읽는다. */
const CALLOUT = /^>\s*\[!(\w+)\][+-]?/;
const CALLOUT_TYPES = ['note', 'info', 'tip', 'warning', 'danger'] as const;
type CalloutType = (typeof CALLOUT_TYPES)[number];
const calloutLine = Object.fromEntries(
  CALLOUT_TYPES.map((k) => [k, Decoration.line({ class: `lno-callout lno-callout-${k}` })]),
) as Record<CalloutType, Decoration>;
/** 모르는 종류는 note 로 그린다. */
const calloutType = (name: string): CalloutType => {
  const k = name.toLowerCase();
  return (CALLOUT_TYPES as readonly string[]).includes(k) ? (k as CalloutType) : 'note';
};
const calloutTitle = Decoration.mark({ class: 'lno-callout-title' });
const codeLine = Decoration.line({ class: 'lno-codeblock' });
const codeFirstLine = Decoration.line({ class: 'lno-codeblock-first' });
const codeLastLine = Decoration.line({ class: 'lno-codeblock-last' });
const fenceLine = Decoration.line({ class: 'lno-fence' });
const hrLine = Decoration.line({ class: 'lno-hr' });
const scanLine = Decoration.line({ class: 'lno-scan-meta' });
const SCAN_COMMENT = /^<!-- labnoteo-scan /;

/** UO Meta 의 실험자 키(`- Experimenter: 이름`, 플러그인 템플릿). */
const META_EXPERIMENTER = 'Experimenter';

const isBlank = (ch: string) => ch === ' ' || ch === '\t';

export function buildDecorations(view: EditorView): { decorations: DecorationSet; hidden: DecorationSet } {
  const { state } = view;
  const decos: Range<Decoration>[] = [];
  const hides: Range<Decoration>[] = [];
  const conceal = (from: number, to: number, deco: Decoration = hide) => {
    // 플러그인의 바꾸기 장식은 줄바꿈을 넘으면 CodeMirror 가 던진다: 줄 끝을 지나는 범위는 아예 숨기지 않는다
    if (from >= to || to > state.doc.lineAt(from).to) return;
    const r = deco.range(from, to);
    decos.push(r);
    hides.push(r);
  };
  const skips = skipRanges(state);
  const lines = touchedLines(state);
  const tree = syntaxTree(state);
  // 글(링크 제목, 체크박스 이름표, 실험자)은 만들 때 읽는다: 언어가 바뀌면(langChanged) 장식을 다시 만든다
  const checkbox = checkboxFor(state.facet(editorLang));
  const linkMark = Decoration.mark({ class: 'lno-link', attributes: { title: t('live.link.title') } });
  const unresolvedLinkMark = Decoration.mark({ class: 'lno-link lno-unresolved', attributes: { title: t('live.link.title') } });
  const unresolvedWikiMark = Decoration.mark({ class: 'lno-wikilink lno-unresolved', attributes: { title: t('links.create.title') } });
  /** 링크 풀이(색인 준비 전에는 null: 흐리게 그리는 것이 없다). */
  const resolution = state.facet(linkResolution);
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
    const url = node.getChild('URL');
    const missing = !!url && linkStateOf(resolution, 'md', state.sliceDoc(url.from, url.to), notePath) === 'unresolved';
    if (open.to < close.from) decos.push((missing ? unresolvedLinkMark : linkMark).range(open.to, close.from));
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
    const missing = linkStateOf(resolution, 'wiki', state.sliceDoc(target.from, target.to), notePath) === 'unresolved';
    const mark = missing ? unresolvedWikiMark : wikiMark;
    if (revealInline(state, node.from, node.to)) {
      const first = node.firstChild!;
      const last = node.lastChild!;
      if (first.to < last.from) decos.push(mark.range(first.to, last.from));
      return;
    }
    decos.push(mark.range(shown.from, shown.to));
    conceal(node.from, shown.from);
    conceal(shown.to, node.to);
    // Without an alias, `[[x.labnote]]` reads `x` and `[[x.labnote#H]]` reads `x#H`: the app's notes are all
    // `.labnote.md`, so the suffix says nothing. Only the drawing changes; the revealed link shows its source.
    if (shown === target) {
      const at = labnoteSuffixAt(state.sliceDoc(target.from, target.to));
      if (at >= 0) conceal(target.from + at, target.from + at + LABNOTE.length);
    }
  };

  /** 노트 경로(이미지 경로를 노트 기준으로 푼다). 이미지 로더가 없으면 보관함 맨 위의 노트로 친다. */
  const notePath = state.facet(imageLoader)?.notePath ?? '';
  /**
   * `![alt](경로)`(md) 또는 `![[x.png|200]]`(wiki): 대상이 이미지면 위젯을 달고 true. 이미지가 아니면 false(호출한 쪽이 다룬다).
   * 거른 경로(보관함 밖, 절대·드라이브·UNC)와 바깥 주소는 후보 없는 위젯이 되어 대체 글(없으면 대상)을 "찾을 수 없음" 으로 보인다.
   */
  const image = (node: SyntaxNode, kind: 'md' | 'wiki'): boolean => {
    let target: string;
    let rawAlt = '';
    if (kind === 'wiki') {
      const tn = node.getChild('WikiTarget');
      if (!tn) return false;
      target = state.sliceDoc(tn.from, tn.to);
      const an = node.getChild('WikiAlias');
      if (an) rawAlt = state.sliceDoc(an.from, an.to);
    } else {
      const url = node.getChild('URL');
      const open = node.firstChild;
      let close: SyntaxNode | null = null;
      for (let c = open?.nextSibling ?? null; c; c = c.nextSibling)
        if (c.name === 'LinkMark' && state.sliceDoc(c.from, c.to) === ']') {
          close = c;
          break;
        }
      if (!url || !open || !close) return false;
      target = state.sliceDoc(url.from, url.to);
      rawAlt = state.sliceDoc(open.to, close.from);
    }
    if (!isImageTarget(target)) return false;
    // 여러 줄에 걸친 이미지는 원문 그대로 둔다(바꾸기 장식은 줄바꿈을 넘지 못한다)
    if (!sameLine(node.from, node.to)) return true;
    const { alt, size } = splitAltSize(rawAlt);
    const ref = resolveImagePath(notePath, target, kind);
    const widget = ref ? new ImageWidget(ref, alt, size) : new ImageWidget({ kind: 'paths', candidates: [] }, alt || target, size);
    if (revealLine(state, state.doc.lineAt(node.from).number, lines)) decos.push(Decoration.widget({ widget, side: 1 }).range(node.to));
    else conceal(node.from, node.to, Decoration.replace({ widget }));
    return true;
  };

  /** 목록 항목: 깊이 줄 클래스, 글머리 점 또는 번호 표시. */
  const listItem = (node: SyntaxNode) => {
    let depth = 0;
    for (let p = node.parent; p; p = p.parent) if (p.name === 'BulletList' || p.name === 'OrderedList') depth++;
    const line = state.doc.lineAt(node.from);
    decos.push(listLine[Math.min(Math.max(depth, 1), MAX_LIST_DEPTH) - 1].range(line.from));
    const mark = node.firstChild;
    if (!mark || mark.name !== 'ListMark' || mark.from >= mark.to) return;
    const task = mark.nextSibling?.name === 'Task' ? mark.nextSibling.firstChild : null;
    const taskMarker = task && task.name === 'TaskMarker' && sameLine(mark.from, task.to) ? task : null;
    const done = !!taskMarker && /^\[[xX]\]$/.test(state.sliceDoc(taskMarker.from, taskMarker.to));
    if (done) decos.push(taskDoneLine.range(line.from));
    if (node.parent?.name === 'OrderedList') {
      decos.push(olMark.range(mark.from, mark.to));
      if (taskMarker && !revealLine(state, line.number, lines)) conceal(taskMarker.from, taskMarker.to, checkbox[done ? 1 : 0]);
      return;
    }
    if (revealLine(state, line.number, lines)) return;
    if (taskMarker) {
      // 할 일 항목은 점 대신 체크박스: `- ` 를 숨기고 `[ ]` 를 체크박스로 바꾼다(그 뒤 공백은 남긴다)
      conceal(mark.from, taskMarker.from);
      conceal(taskMarker.from, taskMarker.to, checkbox[done ? 1 : 0]);
      return;
    }
    // 기호 뒤의 공백 한 칸까지 점이 대신한다
    const end = mark.to < line.to && isBlank(line.text[mark.to - line.from]) ? mark.to + 1 : mark.to;
    conceal(mark.from, end, bullet);
    // UO Meta 의 실험자 줄: 이름만 지역화해 보인다(한 어휘: 실험자 / Experimenter)
    if (line.text.startsWith(`${META_EXPERIMENTER}:`, end - line.from)) {
      const label = t('props.experimenter');
      if (label !== META_EXPERIMENTER)
        conceal(end, end + META_EXPERIMENTER.length, Decoration.replace({ widget: new LabelWidget(label) }));
    }
  };

  /** 인용 줄 클래스를 이미 단 줄: 겹친 인용은 바깥(먼저 들어온) 인용의 클래스만 단다. */
  const quoted = new Set<number>();
  /** 인용·콜아웃: 줄 클래스, 콜아웃이면 드러나지 않은 첫 줄의 `[!type]` 숨김과 제목 표시. `> ` 는 QuoteMark 가 숨긴다. */
  const blockquote = (node: SyntaxNode) => {
    const first = state.doc.lineAt(node.from);
    const last = state.doc.lineAt(node.to).number;
    const m = CALLOUT.exec(state.sliceDoc(node.from, first.to));
    const type = m ? calloutType(m[1]) : null;
    for (let n = first.number; n <= last; n++) {
      if (quoted.has(n)) continue;
      quoted.add(n);
      decos.push((type ? calloutLine[type] : quoteLine).range(state.doc.line(n).from));
    }
    if (!m || revealLine(state, first.number, lines)) return;
    const markFrom = node.from + m[0].indexOf('[');
    let end = node.from + m[0].length;
    const lineEnd = first.text.endsWith('\r') ? first.to - 1 : first.to;
    while (end < lineEnd && isBlank(first.text[end - first.from])) end++;
    conceal(markFrom, end);
    if (end < lineEnd) decos.push(calloutTitle.range(end, lineEnd));
  };

  /** 울타리 코드 블록: 줄 클래스만. 안의 글은 장식하지 않는다. */
  const fencedCode = (node: SyntaxNode) => {
    const first = state.doc.lineAt(node.from).number;
    const last = state.doc.lineAt(node.to).number;
    for (let n = first; n <= last; n++) {
      const from = state.doc.line(n).from;
      decos.push(codeLine.range(from));
      if (n === first) decos.push(codeFirstLine.range(from));
      if (n === last) decos.push(codeLastLine.range(from));
    }
    const fences = new Set<number>();
    for (let c = node.firstChild; c; c = c.nextSibling) if (isFenceMark(c)) fences.add(state.doc.lineAt(c.from).from);
    for (const from of fences) decos.push(fenceLine.range(from));
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
        if (ref.name === 'Blockquote') {
          blockquote(ref.node);
          return;
        }
        if (ref.name === 'QuoteMark') {
          const line = state.doc.lineAt(ref.from);
          if (revealLine(state, line.number, lines)) return;
          // 기호 뒤의 공백 한 칸까지 숨긴다
          const end = ref.to < line.to && isBlank(line.text[ref.to - line.from]) ? ref.to + 1 : ref.to;
          conceal(ref.from, end);
          return;
        }
        if (ref.name === 'FencedCode') {
          fencedCode(ref.node);
          // 안은 장식하지 않는다. 인용 안의 코드 블록이면 줄마다 `> ` 가 있으니 그것만 숨긴다(아래 QuoteMark).
          return;
        }
        if (ref.name === 'HorizontalRule') {
          const line = state.doc.lineAt(ref.from);
          decos.push(hrLine.range(line.from));
          // 줄 끝의 '\r' 까지 숨긴다(섞인 줄바꿈 노트)
          if (!revealLine(state, line.number, lines)) conceal(ref.from, line.to);
          return;
        }
        if (ref.name === 'CommentBlock') {
          const first = state.doc.lineAt(ref.from).number;
          const last = state.doc.lineAt(ref.to).number;
          for (let n = first; n <= last; n++) {
            const line = state.doc.line(n);
            if (SCAN_COMMENT.test(line.text)) decos.push(scanLine.range(line.from));
          }
          return false;
        }
        if (ref.name === 'ListItem') {
          listItem(ref.node);
          return;
        }
        if (ref.name === 'Link') {
          link(ref.node);
          return;
        }
        if (ref.name === 'URL') {
          // 맨 주소: GFM 의 맨 URL(부모가 문단 등)과 `<https://…>` 자동 링크(부모가 Autolink)의 주소
          if (!NOT_BARE_URL.has(ref.node.parent?.name ?? '') && ref.from < ref.to && sameLine(ref.from, ref.to))
            decos.push(linkMark.range(ref.from, ref.to));
          return;
        }
        if (ref.name === 'WikiLink') {
          wikiLink(ref.node);
          return false;
        }
        if (ref.name === 'Embed') {
          // 이미지가 아닌 임베드(`![[노트]]`)는 위키링크처럼 그린다(노트 끼워 넣기는 아직 없다)
          if (!image(ref.node, 'wiki')) wikiLink(ref.node);
          return false;
        }
        if (ref.name === 'Image') {
          if (image(ref.node, 'md')) return false;
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
    if (
      this.pending ||
      u.docChanged ||
      u.selectionSet ||
      u.viewportChanged ||
      syntaxTree(u.startState) !== syntaxTree(u.state) ||
      u.startState.facet(linkResolution) !== u.state.facet(linkResolution) ||
      langChanged(u)
    ) {
      ({ decorations: this.decorations, hidden: this.hidden } = buildDecorations(u.view));
      this.pending = false;
    }
  }
}

export type { LivePlugin };

export const livePlugin = ViewPlugin.fromClass(LivePlugin, { decorations: (p) => p.decorations });

/** 누른 대상이 할 일 체크박스면 그 요소. */
const taskBox = (e: Event): HTMLInputElement | null =>
  e.target instanceof HTMLInputElement && e.target.classList.contains('lno-task') ? e.target : null;

/**
 * 할 일 체크박스의 누름(CodeMirror checkbox 예제의 방식). 플러그인 처리기는 CodeMirror 자신의 mousedown 보다 먼저
 * 돌므로, 여기서 기본 동작을 막으면 선택이 그 줄로 옮겨 가지 않고(줄이 드러나 위젯이 사라지지 않고) 한 번만 바뀐다.
 * click 도 막는다: 체크 상태는 문서가 정하므로(eq) 브라우저가 스스로 체크를 바꾸면 안 된다.
 */
export const taskHandlers: Extension = EditorView.domEventHandlers({
  mousedown(e, view) {
    const box = taskBox(e);
    if (!box || e.button !== 0) return false;
    e.preventDefault();
    toggleTaskAt(view, view.posAtDOM(box));
    return true;
  },
  click(e) {
    if (!taskBox(e)) return false;
    e.preventDefault();
    return true;
  },
});
