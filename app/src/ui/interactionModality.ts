/**
 * 지금 사람이 키보드로 일하는지 포인터(마우스·펜·터치)로 일하는지 기억한다. 대화상자를 닫고 초점을 돌려줄 때
 * 키보드로 일하던 사람에게만 고리(data-focus-ring)를 보이려고 쓴다(returnFocus.ts).
 * 새로 쓴 코드다(Astryx 의 상호작용 방식 생각만 참고, 코드는 옮기지 않았다).
 *
 * 처음에는 'pointer' 다. 키를 누르면 'keyboard', 포인터를 누르면 'pointer' 가 된다. Shift·Ctrl·Alt·Meta 만 누른 것은
 * 세지 않는다(마우스로 고르며 Shift 를 누르는 일이 흔하다). 듣기는 문서의 캡처 단계에서 한다: 다른 처리기가 전파를 막아도 센다.
 */

export type InteractionModality = 'keyboard' | 'pointer';

const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'OS']);

let modality: InteractionModality = 'pointer';
let starts = 0;

const onKey = (e: KeyboardEvent) => {
  if (!MODIFIERS.has(e.key)) modality = 'keyboard';
};
const onPointer = () => {
  modality = 'pointer';
};

export function getInteractionModality(): InteractionModality {
  return modality;
}

/**
 * 추적을 시작한다(main.tsx 가 한 번). 돌려준 함수가 멈춘다. 여러 번 시작하면 모두 멈출 때까지 듣는다.
 * 마지막으로 멈추면 'pointer' 로 돌아간다.
 */
export function startModalityTracking(): () => void {
  if (typeof document === 'undefined') return () => {};
  if (starts++ === 0) {
    modality = 'pointer';
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('mousedown', onPointer, true);
  }
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    if (--starts === 0) {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('mousedown', onPointer, true);
      modality = 'pointer';
    }
  };
}
