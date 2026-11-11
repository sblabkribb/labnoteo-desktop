import { getInteractionModality } from './interactionModality';

/**
 * 대화상자가 닫힐 때 초점을 돌려주는 도우미. 초점은 그림자 루트(CodeMirror 편집기) 안에 있을 수 있으므로
 * document.activeElement 가 아니라 그 안쪽 끝까지 따라간 요소를 기억한다.
 */

/** 문서의 실제 초점 요소: 그림자 루트(CodeMirror) 안의 요소까지 따라간다. 본문(body)이면 null. */
export function deepActiveElement(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  let el: Element | null = document.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  return el instanceof HTMLElement && el !== document.body ? el : null;
}

/**
 * 지금 초점이 있는 요소를 기억한다. 돌려준 함수를 부르면 그 요소가 아직 문서에 붙어 있을 때만 초점을 돌려준다
 * (그 사이 노트를 닫아 편집기가 사라졌으면 아무것도 하지 않는다).
 */
export function captureFocus(): () => void {
  const el = deepActiveElement();
  return () => restoreFocusTo(el);
}

/**
 * 초점을 el 로 돌려준다(문서에 붙어 있을 때만). 키보드로 일하던 중이면 el 에 data-focus-ring 을 달아 고리를 보이고
 * (CSS `[data-focus-ring]:focus`), 초점이 떠나면 뗀다. 마우스로 닫았으면 고리를 달지 않는다.
 * 스크롤은 건드리지 않는다: 편집기의 contentDOM 은 문서 전체만큼 길어서, 그냥 focus() 하면 브라우저가 그 머리로
 * 끌어올려 본문이 맨 위로 가고 캐럿만 제자리에 남는다. 초점을 가져갈 때 요소는 보이던 자리였다.
 */
export function restoreFocusTo(el: HTMLElement | null | undefined): void {
  if (!el?.isConnected) return;
  if (getInteractionModality() === 'keyboard') {
    el.setAttribute('data-focus-ring', '');
    el.addEventListener('blur', () => el.removeAttribute('data-focus-ring'), { once: true });
  }
  el.focus({ preventScroll: true });
}
