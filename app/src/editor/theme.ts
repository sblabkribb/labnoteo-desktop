import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import type { Extension } from '@codemirror/state';

/**
 * 편집기의 모양. 색은 한 곳에도 직접 쓰지 않고 전부 app.css 의 토큰을 `var(--…)` 로 읽는다.
 * 편집기는 그림자 루트 안에 있지만 CSS 사용자 지정 속성은 그 경계를 넘어 상속되므로,
 * 테마 토글(data-theme)이나 시스템 설정이 바뀌면 사이드바와 같은 순간에 본문도 바뀐다.
 * 색을 박으면 본문만 테마를 안 따라간다 — 그래서 Editor.test.tsx 가 이 값들을 검사한다.
 *
 * 라이트/다크 기본 클래스 — 다음 사람이 꼭 알아야 할 것:
 * - 이 테마는 `{ dark: true }` 를 주지 않는다. 그래서 편집기는 다크 모드에서도 늘 CodeMirror 의 라이트 기본 클래스를 단다.
 *   `EditorView.darkTheme` 는 어느 테마에서나 false 이고, 기본 테마와 모든 확장의 `&dark` 규칙은 한 번도 걸리지 않는다.
 *   반대로 `&light` 규칙과 범위 없는 규칙의 박힌 색은 다크 모드에서도 그대로 걸린다. 테마가 바뀌는 것은 아래 색이 토큰이라서다.
 * - 오늘 그려지는 요소에서 덮는 것: @codemirror/view 기본 테마의 라이트 캐럿 색(`&light .cm-content` 의 caret-color: black),
 *   포커스 윤곽선(`&.cm-focused` 의 1px dotted #212121 → none), 특수 문자(`&light .cm-specialChar` 의 red, highlightSpecialChars 가
 *   설치돼 있다). 선택 영역(`.cm-content ::selection`)은 기본 테마의 규칙이 아니라 브라우저 기본 선택 색을 바꾼다
 *   (문서의 app.css `::selection` 은 그림자 루트 안까지 오지 않는다).
 * - 그 요소를 그리는 확장이 아직 없어서 미리 덮어 둔 것: 활성 줄과 거터의 활성 줄(highlightActiveLine·highlightActiveLineGutter),
 *   거터(lineNumbers 등), 패널·단추·입력 칸(검색 패널 등), 일반 툴팁과 화살표(툴팁을 쓰는 확장). 지금은 아무 요소에도 걸리지 않는다.
 * - 덮는 방법: 같은 특이도의 선택자로 다시 쓰고, 이 테마 모듈이 기본 테마보다 뒤에 붙으므로 이긴다(`&light` 는 EditorView.theme 에서
 *   쓸 수 없다).
 * - 기본 테마에 이미 들어 있지만 그 요소가 없어서 지금은 걸리지 않는 박힌 색: `.cm-cursor`·`.cm-dropCursor` 의 1.2px solid black,
 *   `.cm-selectionBackground` 의 #d9d9d9 와 포커스 때의 #d7d4f0(선택자가 더 길어 특이도가 높다), `.cm-placeholder` 의 #888,
 *   공백 강조의 #aaa·%23888, 끝 공백의 #ff332255. drawSelection·dropCursor·placeholder·highlightWhitespace·
 *   highlightTrailingWhitespace 를 설치하면 살아난다.
 * - 확장 자신의 테마 모듈이 가져오는 박힌 색(설치할 때 여기서 토큰으로 덮어야 한다 — 저절로 토큰 색이 되지 않는다):
 *   drawSelection 은 네이티브 캐럿과 `::selection` 을 `!important` 로 투명하게 하고 시스템 색 `Highlight !important` 를 쓴다.
 *   @codemirror/language 의 접기는 `.cm-foldPlaceholder` 의 #eee/#ddd/#888, @codemirror/autocomplete 는
 *   `&light … li[aria-selected]` 의 #17c/white 와 `&light .cm-snippetField`, @codemirror/lint 는 범위 없는 진단 색.
 *   @codemirror/search 의 `&light` 일치 색은 리뷰가 확인한 것이다(이 저장소에는 설치돼 있지 않아 여기서 보지 못했다).
 * - theme-guard.test.tsx 가 이것을 지킨다: 편집기가 처음 뜰 때 그림자 루트에 들어간 박힌 색마다, 같은 선택자·같은 속성을 같거나
 *   높은 특이도로 덮는 토큰 규칙이 있는지 보고, 위의 "요소가 없는" 규칙은 확장 이름과 함께 목록에 둔다. 처음 뜰 때 실리는 확장이
 *   덮이지 않은 박힌 색을 가져오거나 목록의 확장을 가져오면 그 테스트가 빨개진다(나중에 Compartment 로 넣는 확장은 보지 못한다).
 * - 결정(D1, SP3): 늘 라이트로 둔다. Always-light: `EditorView.darkTheme` stays false; colours come from tokens;
 *   revisit only for an extension that styles via `&dark`. 다크 플래그를 Compartment 로 바꾸면 `&dark` 규칙이 살아나고 그것을
 *   덮어야 하므로, `&dark` 로 모양을 내는 확장(자동 완성, 검색, lint, drawSelection 등)을 들일 때만 다시 본다.
 * - 위젯 기본 클래스: 편집기 안의 위젯은 `.lno-widget`(틀), `.lno-btn`(단추: hover·disabled·focus-visible),
 *   `.lno-popover`(뜨는 메뉴·창, z-index 는 --z-popover), `.lno-chip`(작은 꼬리표)을 달고, 위젯 고유의 규칙은 그 뒤에 덧쓴다.
 */
const panel = { backgroundColor: 'var(--bg-elevated)', color: 'var(--text)' };
const arrow = (side: 'Top' | 'Bottom', fill: 'var(--border-strong)' | 'var(--bg-elevated)') => ({ [`border${side}`]: `7px solid ${fill}` });

export const editorThemeSpec = {
  '&': {
    color: 'var(--text)',
    backgroundColor: 'var(--bg)',
    minHeight: '50vh',
    fontFamily: 'var(--font-ui)',
    fontSize: 'var(--font-size)',
  },
  '&.cm-focused': { outline: 'none' }, // 바깥 포커스 링은 app.css 의 틀이 그린다
  '.cm-scroller': { fontFamily: 'inherit', lineHeight: '1.7' },
  '.cm-content': { padding: 'var(--space-3) 0', caretColor: 'var(--text)' },
  '.cm-line': { padding: '0 var(--space-3)' },
  // 네이티브 선택(drawSelection 을 쓰지 않는다). 글자색도 정해, 강조색·흐린 글자가 선택 배경 위에서 대비를 잃지 않게 한다.
  '.cm-content ::selection': { background: 'var(--bg-selection)', color: 'var(--text)' },
  '.cm-specialChar': { color: 'var(--text-muted)' },
  '.cm-activeLine': { backgroundColor: 'var(--bg-hover)' },
  '.cm-gutters': { backgroundColor: 'var(--bg-elevated)', color: 'var(--text-muted)', border: '0px solid var(--border)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--bg-hover)' },
  '.cm-panels': panel,
  '.cm-panels-top': { borderBottom: '1px solid var(--border)' },
  '.cm-panels-bottom': { borderTop: '1px solid var(--border)' },
  '.cm-button': {
    backgroundImage: 'none',
    backgroundColor: 'var(--bg-elevated)',
    border: '1px solid var(--border-strong)',
    '&:active': { backgroundImage: 'none', backgroundColor: 'var(--bg-hover)' },
  },
  '.cm-textfield': { backgroundColor: 'var(--bg)', color: 'var(--text)', border: '1px solid var(--border-strong)' },
  '.cm-tooltip': { border: '1px solid var(--border-strong)', backgroundColor: 'var(--bg-elevated)', color: 'var(--text)' },
  '.cm-tooltip-section:not(:first-child)': { borderTop: '1px solid var(--border-strong)' },
  '.cm-tooltip-arrow': {
    '.cm-tooltip-above &': {
      '&:before': arrow('Top', 'var(--border-strong)'),
      '&:after': arrow('Top', 'var(--bg-elevated)'),
    },
    '.cm-tooltip-below &': {
      '&:before': arrow('Bottom', 'var(--border-strong)'),
      '&:after': arrow('Bottom', 'var(--bg-elevated)'),
    },
  },
  // 위젯 기본 클래스. 위젯 고유의 규칙(.lno-table-tool 등)은 같은 특이도로 이 뒤에 오므로 여기 값을 덧쓴다.
  '.lno-widget': { fontFamily: 'var(--font-ui)', color: 'var(--text)' },
  '.lno-btn': {
    font: 'inherit',
    color: 'var(--text)',
    backgroundColor: 'var(--bg-elevated)',
    border: '1px solid var(--border-strong)',
    borderRadius: 'var(--radius)',
    padding: '0 var(--space-2)',
    cursor: 'pointer',
    '&:hover:not(:disabled)': { backgroundColor: 'var(--bg-hover)' },
    '&:disabled': { color: 'var(--text-muted)', cursor: 'default' },
    '&:focus-visible': { outline: '2px solid var(--accent)', outlineOffset: '1px' },
  },
  '.lno-popover': {
    position: 'absolute',
    zIndex: 'var(--z-popover)',
    padding: 'var(--space-1)',
    backgroundColor: 'var(--bg-elevated)',
    border: '1px solid var(--border-strong)',
    borderRadius: 'var(--radius)',
  },
  '.lno-chip': {
    display: 'inline-block',
    padding: '0 var(--space-1)',
    fontSize: '0.85em',
    lineHeight: '1.4',
    color: 'var(--text-muted)',
    backgroundColor: 'var(--bg-hover)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
  },
  // 라이브 미리보기(live/inline.ts): 제목 줄 크기, 인라인 코드와 하이라이트. 굵기·기울임·취소선은 구문 강조가 이미 그린다.
  '.lno-h1': { fontSize: '1.6em', fontWeight: '700' },
  '.lno-h2': { fontSize: '1.4em', fontWeight: '700' },
  '.lno-h3': { fontSize: '1.25em', fontWeight: '700' },
  '.lno-h4': { fontSize: '1.15em', fontWeight: '700' },
  '.lno-h5': { fontSize: '1.05em', fontWeight: '700' },
  '.lno-h6': { fontSize: '1em', fontWeight: '700' },
  '.lno-code': {
    background: 'var(--bg-elevated)',
    fontFamily: 'var(--font-mono)',
    fontSize: '0.93em',
    borderRadius: 'var(--radius)',
    padding: '0 2px',
  },
  '.lno-hl': { backgroundColor: 'var(--bg-selected)' },
  // 링크(live/links.ts): Markdown 링크는 강조색 밑줄, 위키링크(아직 이동하지 않는다, SP4)는 강조색만.
  '.lno-link': { color: 'var(--accent)', textDecorationLine: 'underline', textUnderlineOffset: '2px' },
  '.lno-wikilink': { color: 'var(--accent)' },
  // 보관함 이미지(live/imageWidget.ts): 줄 너비를 넘지 않고 비율을 지킨다. 크기 문법(|200)은 위젯이 CSSOM 으로 건다.
  // 찾지 못한 이미지는 흐린 기울임 글에 옅은 테두리.
  '.lno-image': { maxWidth: '100%', height: 'auto', verticalAlign: 'bottom' },
  '.lno-image-missing': {
    color: 'var(--text-muted)',
    fontStyle: 'italic',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
    padding: '0 var(--space-1)',
  },
  // 목록: 글머리 점(BulletWidget)과 번호. 깊이마다 왼쪽 여백을 늘리고 같은 만큼 첫 줄을 당겨(textIndent) 걸친 줄이
  // 항목의 글 첫 칸에 맞는다(내어쓰기). 줄 앞의 들임 공백은 글자 그대로 남아 첫 줄을 그 깊이로 민다.
  '.lno-bullet': { display: 'inline-block', minWidth: '2ch', textIndent: '0', color: 'var(--text-muted)' },
  '.lno-ol-mark': { color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' },
  '.lno-li-d1': { paddingLeft: 'calc(var(--space-3) + 2ch)', textIndent: '-2ch' },
  '.lno-li-d2': { paddingLeft: 'calc(var(--space-3) + 4ch)', textIndent: '-4ch' },
  '.lno-li-d3': { paddingLeft: 'calc(var(--space-3) + 6ch)', textIndent: '-6ch' },
  '.lno-li-d4': { paddingLeft: 'calc(var(--space-3) + 8ch)', textIndent: '-8ch' },
  '.lno-li-d5': { paddingLeft: 'calc(var(--space-3) + 10ch)', textIndent: '-10ch' },
  '.lno-li-d6': { paddingLeft: 'calc(var(--space-3) + 12ch)', textIndent: '-12ch' },
  '.lno-li-d7': { paddingLeft: 'calc(var(--space-3) + 14ch)', textIndent: '-14ch' },
  '.lno-li-d8': { paddingLeft: 'calc(var(--space-3) + 16ch)', textIndent: '-16ch' },
  // 할 일 체크박스: 숨긴 `- [ ]` 자리에 선다. 체크 색은 강조색.
  '.lno-task': {
    width: '1em',
    height: '1em',
    margin: '0',
    textIndent: '0',
    verticalAlign: 'middle',
    accentColor: 'var(--accent)',
    cursor: 'pointer',
  },
  '.lno-task-done': { color: 'var(--text-muted)', textDecorationLine: 'line-through' },
  // 인용(live/inline.ts): 왼쪽 선과 흐린 글. 콜아웃은 종류별 선 색과 옅은 바탕, 첫 줄의 제목은 굵게.
  '.lno-quote': { borderLeft: '3px solid var(--border-strong)', color: 'var(--text-muted)' },
  '.lno-callout': { borderLeft: '3px solid var(--border)', backgroundColor: 'var(--bg-elevated)' },
  '.lno-callout-note': { borderLeftColor: 'var(--accent)' },
  '.lno-callout-info': { borderLeftColor: 'var(--accent)' },
  '.lno-callout-tip': { borderLeftColor: 'var(--success)' },
  '.lno-callout-warning': { borderLeftColor: 'var(--warning)' },
  '.lno-callout-danger': { borderLeftColor: 'var(--danger)' },
  '.lno-callout-title': { fontWeight: '700' },
  // 울타리 코드 블록: 고정폭 글꼴과 바탕. 첫·끝 줄만 모서리를 둥글린다. 울타리 줄(```)은 숨기지 않고 흐리게.
  '.lno-codeblock': { backgroundColor: 'var(--bg-elevated)', fontFamily: 'var(--font-mono)', fontSize: '0.93em' },
  '.lno-codeblock-first': { borderTopLeftRadius: 'var(--radius)', borderTopRightRadius: 'var(--radius)' },
  '.lno-codeblock-last': { borderBottomLeftRadius: 'var(--radius)', borderBottomRightRadius: 'var(--radius)' },
  '.lno-fence': { color: 'var(--text-muted)' },
  // 가로줄: 숨긴 `---` 자리 가운데에 선 하나. 누름을 가로채지 않는다.
  '.lno-hr': { position: 'relative' },
  '.lno-hr::before': {
    content: '""',
    position: 'absolute',
    left: 'var(--space-3)',
    right: 'var(--space-3)',
    top: '50%',
    borderTop: '1px solid var(--border-strong)',
    pointerEvents: 'none',
  },
  // 스캔 주석(<!-- labnoteo-scan … -->): 흐리고 작게.
  '.lno-scan-meta': { color: 'var(--text-muted)', fontSize: '0.8em' },
  // 유닛 오퍼레이션·워크플로 제목의 코드 칩: .lno-chip 위에 고정폭 글꼴과 종류별 테두리색.
  '.lno-uo-code': { fontFamily: 'var(--font-mono)', fontWeight: '600', color: 'var(--text)', verticalAlign: 'middle' },
  '.lno-uo-uhw': { borderColor: 'var(--accent)' },
  '.lno-uo-usw': { borderColor: 'var(--success)' },
  '.lno-uo-wb': { borderColor: 'var(--warning)' },
  // 표 격자(table/widget.ts). 그림자 루트 안이라 app.css 가 닿지 않는다: 모양은 모두 여기, 색은 토큰만.
  // 바깥 틀은 넘침을 자르지 않는다: overflow-x 를 auto 로 두면 overflow-y 도 auto 가 되어 오른쪽 클릭 메뉴가 표 틀에 잘린다.
  // 넓은 표의 가로 스크롤은 표만 감싼 안쪽 틀(.lno-table-scroll)이 맡고, 메뉴는 바깥 틀의 자식으로 뜬다.
  // 틀은 표 폭만큼만 차지해 도구 줄이 표 오른쪽 끝에 붙는다. 넓은 표는 100% 에서 멈추고 안쪽 틀이 스크롤한다.
  '.lno-table-wrap': { position: 'relative', padding: 'var(--space-2) var(--space-3)', width: 'fit-content', maxWidth: '100%', boxSizing: 'border-box' },
  '.lno-table-scroll': { overflowX: 'auto' },
  // 칸 사이 선이 겹치지 않게: 칸은 오른쪽·아래 선만, 표가 왼쪽·위 선을 긋는다(border-collapse 의 값이 색 이름 검사에 걸린다)
  '.lno-table': {
    borderSpacing: '0',
    borderLeft: '1px solid var(--border)',
    borderTop: '1px solid var(--border)',
    fontSize: 'inherit',
    lineHeight: '1.5',
  },
  '.lno-table th, .lno-table td': {
    borderRight: '1px solid var(--border)',
    borderBottom: '1px solid var(--border)',
    padding: 'var(--space-1) var(--space-2)',
    verticalAlign: 'top',
    textAlign: 'left',
    minWidth: '3em',
  },
  '.lno-table th': { backgroundColor: 'var(--bg-elevated)', fontWeight: '700' },
  // 빈 칸도 글자 한 줄 높이(줄 높이 + 위아래 여백)를 갖게 보이지 않는 글자 하나를 둔다: 새 표의 빈 행이 얇아 누르기 어렵지 않게.
  // 셀 편집기가 든 칸은 비어 있지 않으므로(편집기 DOM) 걸리지 않는다.
  '.lno-table td:empty::before, .lno-table th:empty::before': { content: '"\\200b"' },
  '.lno-table .lno-al-left': { textAlign: 'left' },
  '.lno-table .lno-al-center': { textAlign: 'center' },
  '.lno-table .lno-al-right': { textAlign: 'right' },
  '.lno-table .lno-cell-overflow': { color: 'var(--text-muted)', borderBottom: '1px solid var(--danger)', borderRight: '1px solid var(--danger)' },
  '.lno-table code': { fontFamily: 'var(--font-mono)', fontSize: '0.93em', backgroundColor: 'var(--bg-hover)', borderRadius: 'var(--radius)' },
  '.lno-table-link': { color: 'var(--accent)', textDecoration: 'underline' },
  '.lno-table-image': { color: 'var(--text-muted)', fontStyle: 'italic' },
  // 도구 막대: 작은 단추 넷이 표 위 오른쪽에 겹쳐 뜬다. 자리를 차지하지 않아(position: absolute) 숨었을 때 표 위에 빈 틈이 없다.
  // 아래 끝이 표의 위 선에 닿고, 표 틀의 위 여백과 앞 줄의 오른쪽 끝에 걸친다: 칸의 글자를 가리지 않는다.
  // 가리키거나 포커스가 들어올 때만 보이고(키보드로도 닿는다), 숨었을 때는 앞 줄을 누르는 것을 가로채지 않는다.
  '.lno-table-toolbar': {
    position: 'absolute',
    bottom: 'calc(100% - var(--space-2))',
    right: 'var(--space-3)',
    zIndex: 'var(--z-widget)',
    display: 'flex',
    gap: '2px',
    opacity: '0',
    pointerEvents: 'none',
    transition: 'opacity 120ms',
  },
  '.lno-table-toolbar .lno-table-strip-tool': {
    minWidth: '1.75em',
    lineHeight: '1.4',
    padding: '0 var(--space-1)',
    textAlign: 'center',
  },
  // 셀 편집기(table/cellEditor.ts): 칸 안에 뜨는 작은 CodeMirror. 바깥 편집기의 줄·본문 여백을 걷고, 포커스는 칸의 윤곽선으로 보인다
  '.lno-table .lno-cell-active': { outline: '2px solid var(--accent)', outlineOffset: '-2px' },
  '.lno-table .cm-editor.cm-focused': { outline: 'none' },
  '.lno-table .cm-scroller': { lineHeight: 'inherit', fontFamily: 'inherit' },
  '.lno-table .cm-content': { padding: '0', caretColor: 'var(--text)' },
  '.lno-table .cm-line': { padding: '0' },
  '.lno-table-wrap:hover > .lno-table-toolbar, .lno-table-wrap:focus-within > .lno-table-toolbar': { opacity: '1', pointerEvents: 'auto' },
  // 표 단추는 .lno-btn 을 함께 단다: 색·테두리·상태는 거기서 오고, 여기는 크기만 덧쓴다
  '.lno-table-tool': { fontSize: '0.85em' },
  // 한 번 누른 "표 지우기": 한 번 더 누르면 지운다는 것을 위험색으로 알린다
  '.lno-table-tool[data-armed="true"]': { color: 'var(--danger)', borderColor: 'var(--danger)' },
  // 표 메뉴: 연 자리(누른 점, 단추, 칸)에 뜬다. left/top(과 길 때 max-height)은 열 때 widget.ts 가 CSSOM 으로 적는다
  // (style 속성은 CSP 가 막는다). 편집기보다 길면 메뉴 안에서 스크롤한다.
  // .lno-popover 를 함께 단다(틀의 색·테두리·여백). 표 메뉴는 표 위젯의 층(--z-widget-menu)에 머문다.
  '.lno-table-menu': {
    top: '0',
    left: '0',
    zIndex: 'var(--z-widget-menu)',
    overflowY: 'auto',
    whiteSpace: 'nowrap',
    display: 'flex',
    flexDirection: 'column',
    gap: '1px',
  },
  '.lno-table-menu .lno-table-tool': { textAlign: 'left', border: 'none' },
  // 고대비(forced-colors): 운영체제가 색을 정하는 모드에서도 지금 고치는 칸이 보이게 시스템 색으로 윤곽선을 그린다.
  // 시스템 색은 이 키 안에서만 쓴다(Editor.test.tsx 의 themeColourLeaks 가 그 밖에서는 막는다).
  '@media (forced-colors: active)': {
    '.lno-table .lno-cell-active': { outline: '2px solid Highlight', outlineOffset: '-2px' },
  },
  // 인쇄: 표 도구 막대는 화면 조작용이라 종이에 남기지 않는다(앱 틀은 app.css 의 @media print 가 숨긴다)
  '@media print': {
    '.lno-table-toolbar': { display: 'none' },
  },
};

/**
 * 구문 강조도 같은 토큰에서 끌어온다. 굵기와 모양은 색 없이도 구분을 돕는다.
 * `tags.list` 는 일부러 넣지 않는다: @lezer/markdown 이 목록 전체에 `/...` 로 붙여서 목록 안 모든 본문이 강조색이 된다.
 * 목록 기호(ListMark)는 processingInstruction 으로 흐려진다.
 */
export const highlightSpec = [
  { tag: tags.heading, fontWeight: '700', color: 'var(--text)' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.link, color: 'var(--accent)' },
  { tag: tags.url, color: 'var(--accent)', textDecoration: 'underline' },
  { tag: tags.monospace, fontFamily: 'var(--font-mono)', fontSize: '0.93em' },
  { tag: tags.quote, color: 'var(--text-muted)', fontStyle: 'italic' },
  // 기호(#, *, `, >, 목록 표시)는 한 단계 물러나 있다
  { tag: [tags.processingInstruction, tags.meta, tags.contentSeparator], color: 'var(--text-muted)' },
];

/**
 * 모듈에서 한 번만 만든다(표의 셀 편집기도 같은 강조를 쓴다): 만들 때마다 새 스타일 모듈이 생겨 편집기의 입양 스타일시트에 쌓이는데,
 * 노트를 열 때와 조용히 다시 읽을 때마다 상태를 새로 만들기 때문이다. 같은 확장은 같은 모듈을 쓴다.
 */
export const markdownHighlighting: Extension = syntaxHighlighting(HighlightStyle.define(highlightSpec));
export const editorTheme: Extension = [EditorView.theme(editorThemeSpec), markdownHighlighting];
