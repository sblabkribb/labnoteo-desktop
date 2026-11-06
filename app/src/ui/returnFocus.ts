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
  return () => {
    if (el?.isConnected) el.focus();
  };
}
