/**
 * 트리 줄의 깊이 표시. styles/tree.css 는 data-depth 1..MAX_DEPTH 마다 들여쓰기 규칙을 하나씩 두고,
 * 사이드바 안에서는 INDENT_CAP 보다 깊은 줄(.deep)을 INDENT_CAP 단계 들여쓰기로 고정한다.
 * 인라인 style 은 CSP 가 막으므로 들여쓰기는 속성과 클래스로만 정한다.
 */

/** styles/tree.css 가 들여쓰기를 정해 둔 가장 깊은 단계. 더 깊은 줄은 이 값으로 고정한다. */
export const MAX_DEPTH = 24;
/** 사이드바에서 들여쓰기를 멈추는 단계. 이보다 깊은 줄은 class 'deep' 을 받는다. */
export const INDENT_CAP = 8;

export function depthAttrs(depth: number): { 'data-depth': number; className?: 'deep' } {
  const d = Math.min(Math.max(0, depth), MAX_DEPTH);
  return d > INDENT_CAP ? { 'data-depth': d, className: 'deep' } : { 'data-depth': d };
}
