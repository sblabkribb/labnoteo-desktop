/**
 * 실험 탭 카탈로그의 항목 하나를 보여 달라는 요청(어시스턴트의 카탈로그 출처 칩, 2026-11-12 녹화: 칩이 카탈로그 JSON 파일
 * 전체를 "노트가 아닌 파일" 카드로 열었다). 부르는 쪽은 먼저 실험 탭을 보이게 하고(showPanel('workflows')) 이것을 부른다.
 * 패널이 아직 없으면(탭이 숨어 있었다) 요청이 남아 있다가 패널이 뜰 때 한 번 읽힌다.
 */
type Listener = () => void;

let pending: string | undefined;
const listeners = new Set<Listener>();

/** 카탈로그 코드(WB150, UHW100 …)의 항목을 펼쳐 그 작은 창을 띄우라고 한다. */
export function revealCatalogEntry(id: string): void {
  pending = id;
  for (const fn of [...listeners]) fn();
}

/** 남은 요청을 꺼낸다(한 번만). 없으면 undefined. */
export function takeCatalogReveal(): string | undefined {
  const id = pending;
  pending = undefined;
  return id;
}

/** 요청이 올 때마다 부른다. 되돌리는 함수를 준다. */
export function onCatalogReveal(fn: Listener): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}
