import type { CommandContext } from '../labnote/commands/context';
import type { PartbankFeature } from '../labnote/port/partbankFeature';

/**
 * 열린 보관함의 PartbankFeature 하나. 앱 배선(Task 26)이 보관함을 열 때 `setPartbankFeature` 로 넣고, 닫거나 바꿀 때
 * undefined 로 비운다. 명령과 패널은 `partbank(ctx)` 로 읽는다: 아직 없으면 partbank 기능이 꺼진 것이다.
 */
let current: PartbankFeature | undefined;

/** 열린 보관함의 기능. `ctx` 는 부르는 쪽의 표시일 뿐, 기능은 보관함마다 하나라서 지금 것을 돌려준다. */
export function partbank(_ctx?: CommandContext): PartbankFeature | undefined {
  return current;
}

export function setPartbankFeature(f: PartbankFeature | undefined): void {
  current = f;
}
