/**
 * Tab 으로 갈 수 있는 요소(대화상자의 Tab 가두기가 도는 차례). 문서 순서다.
 * `root` 까지의 조상(자신 포함) 중에 [hidden], [inert], [aria-hidden="true"] 가 있으면 빠진다: 설정 창의 숨은 페이지처럼
 * 그려져 있어도 보이지 않는 쪽으로 초점이 가지 않게 한다. 꺼진(disabled) 요소도 빠진다.
 * tabindex 가 음수인 요소(로빙 tabindex 의 나머지 항목 등)도 빠진다. 크기(client rect)는 보지 않는다: jsdom 에는 배치가 없다.
 */
const TABBABLE = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'a[href]',
  'summary',
  '[contenteditable="true"]',
  '[tabindex]',
].join(', ');

function hiddenUpTo(el: HTMLElement, root: HTMLElement): boolean {
  for (let node: HTMLElement | null = el; node && node !== root; node = node.parentElement) {
    if (node.hidden || node.hasAttribute('inert') || node.getAttribute('aria-hidden') === 'true') return true;
  }
  return false;
}

export function focusableIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(TABBABLE)].filter((el) => {
    const tabindex = el.getAttribute('tabindex');
    if (tabindex !== null && Number.parseInt(tabindex, 10) < 0) return false;
    if ((el as HTMLButtonElement).disabled) return false;
    return !hiddenUpTo(el, root);
  });
}
