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
 * - 지금 덮어 둔 것은 @codemirror/view 의 라이트·범위 없는 규칙 중 이것들이다: 네이티브 캐럿과 선택(`.cm-content` 의
 *   caret-color, `::selection`), 포커스 윤곽선, 특수 문자, 활성 줄, 거터, 패널, 단추, 입력 칸, 일반 툴팁(테두리·화살표).
 *   (거터·패널·툴팁은 아직 그것을 그리는 확장이 없지만 미리 덮어 두었다.)
 *   같은 선택자 길이로 다시 쓰고, 이 테마가 뒤에 오므로 이긴다(`&light` 는 EditorView.theme 에서 쓸 수 없다).
 * - 확장은 설치되는 순간 자기 `&light` 나 범위 없는 박힌 색을 가져온다. 설치할 때 그 색을 여기서 토큰으로 덮어야 한다 —
 *   저절로 토큰 색이 되지 않는다. 예: drawSelection 은 `.cm-cursor` 의 `1.2px solid black` 과 `.cm-selectionBackground` 의
 *   `#d9d9d9`·`#d7d4f0`(포커스 때는 선택자가 더 길다) 를 살리고, 네이티브 캐럿과 `::selection` 을 `!important` 로 투명하게 만들며,
 *   시스템 색 `Highlight` 를 쓴다. dropCursor 는 같은 검은 테두리, @codemirror/language 의 접기는 `.cm-foldPlaceholder` 의
 *   `#eee`/`#ddd`/`#888`, @codemirror/autocomplete 는 `&light … li[aria-selected]` 의 `#17c`/white 와 `&light .cm-snippetField`,
 *   @codemirror/search 는 자기 `&light` 일치 색, @codemirror/lint 는 범위 없는 진단 색을 가져온다. `.cm-cursor`·`.cm-selectionBackground`
 *   와 placeholder·공백 강조·끝 공백 규칙은 기본 테마에 이미 들어 있지만 그 요소를 그리는 확장이 없어서 지금은 아무 데도 걸리지 않는다.
 * - theme-guard.test.tsx 가 이것을 지킨다: 그림자 루트에 들어간 박힌 색마다 이 테마의 토큰 규칙이 같은 대상·같은 속성을 같거나 높은
 *   특이도로 덮었는지 보고, 아직 그려지지 않는 규칙은 확장 이름과 함께 목록에 둔다. 박힌 색을 가져오는 확장을 덮지 않고 설치하면 그 테스트가 빨개진다.
 * - 다크 플래그를 Compartment 로 바꿀지(그러면 `&dark` 규칙이 살아나고 대신 그것을 덮어야 한다)는 편집기 하위 프로젝트가 정한다.
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
 * 모듈에서 한 번만 만든다: 만들 때마다 새 스타일 모듈이 생겨 편집기의 입양 스타일시트에 쌓이는데,
 * 노트를 열 때와 조용히 다시 읽을 때마다 상태를 새로 만들기 때문이다. 같은 확장은 같은 모듈을 쓴다.
 */
export const editorTheme: Extension = [EditorView.theme(editorThemeSpec), syntaxHighlighting(HighlightStyle.define(highlightSpec))];
