/**
 * 줄인 움직임을 <html data-reduced-motion> 으로 비춘다. 운영체제의 "애니메이션 효과 끄기"(prefers-reduced-motion: reduce)를
 * 따라 속성을 달고 뗀다. tokens.css 의 html[data-reduced-motion] 블록이 모든 --duration-* 와 --motion 을 0s 로 만들고,
 * 미디어 쿼리를 쓸 수 없는 스크립트(끌기 등)는 이 속성을 읽는다. main.tsx 가 한 번 시작한다. 돌려준 함수가 멈추고 속성을 뗀다.
 */
const QUERY = '(prefers-reduced-motion: reduce)';
const ATTR = 'data-reduced-motion';

export function startReducedMotionMirror(win: Window = window, root: HTMLElement = document.documentElement): () => void {
  if (typeof win.matchMedia !== 'function') return () => {};
  const mql = win.matchMedia(QUERY);
  const apply = (on: boolean) => {
    if (on) root.setAttribute(ATTR, '');
    else root.removeAttribute(ATTR);
  };
  const onChange = (e: { matches: boolean }) => apply(e.matches);
  apply(mql.matches);
  mql.addEventListener('change', onChange);
  return () => {
    mql.removeEventListener('change', onChange);
    root.removeAttribute(ATTR);
  };
}
