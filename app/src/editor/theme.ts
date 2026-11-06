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
 * 라이트/다크 기본 클래스: 이 테마는 `{ dark: true }` 를 주지 않으므로 편집기는 항상 CodeMirror 의 라이트 기본 클래스를 단다
 * (다크 규칙은 어떤 요소에도 걸리지 않는다). 테마가 바뀌는 것은 색 자체가 토큰이라서다. 그래서 기본 테마가 라이트 규칙으로
 * 박아 두는 색 — 캐럿, 특수 문자, 활성 줄, 거터, 패널, 단추, 입력, 툴팁 — 을 모두 같은 선택자 길이로 다시 쓴다.
 * `&light` 는 EditorView.theme 에서 쓸 수 없고, 선택자 길이가 같으면 나중에 오는 이 테마가 이긴다.
 * (검색·줄 번호·툴팁 같은 기능은 아직 설치돼 있지 않다. 설치되면 이미 토큰 색으로 나온다.)
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
