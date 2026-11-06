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
 * CodeMirror 의 기본 테마는 캐럿·선택 영역·특수 문자 색을 `&light` 규칙으로 박아 둔다(이 테마는 dark 로 표시하지 않으므로
 * 라이트 쪽이 켜진다). 아래 규칙은 그것과 선택자 길이가 같고 뒤에 오므로 이긴다 — 그래서 `&` 로 같은 모양을 다시 쓴다.
 */
const selection = { background: 'var(--bg-selection)' };

export const editorThemeSpec = {
  '&': {
    color: 'var(--text)',
    backgroundColor: 'var(--bg)',
    minHeight: '50vh',
    fontFamily: 'var(--font-ui)',
    fontSize: 'var(--font-size)',
  },
  '&.cm-focused': { outline: 'none' }, // 바깥 포커스 링은 아래에서 직접 그린다
  '.cm-scroller': { fontFamily: 'inherit', lineHeight: '1.7' },
  '.cm-content': { padding: 'var(--space-3) 0', caretColor: 'var(--text)' },
  '.cm-line': { padding: '0 var(--space-3)' },
  '.cm-selectionBackground': selection,
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': selection,
  '.cm-content ::selection': selection,
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--text)' },
  '.cm-specialChar': { color: 'var(--text-muted)' },
};

/** 구문 강조도 같은 토큰에서 끌어온다. 글꼴 굵기와 모양은 색 없이도 구분을 돕는다. */
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
  { tag: tags.list, color: 'var(--accent)' },
];

export function editorTheme(): Extension[] {
  return [EditorView.theme(editorThemeSpec), syntaxHighlighting(HighlightStyle.define(highlightSpec))];
}
