import type { CommandContext } from './context';

/** 명령 하나. 팔레트, 맥락 메뉴, 패널 동작, 머리 단추는 모두 runCommand 로 부른다. */
export interface Command {
  /** 플러그인의 명령 id 그대로(예: 'create-experiment'). */
  id: string;
  /** coreT / paletteName 에 넘기는 영어 키(예: 'Create experiment'). obsidianKo 에 있어야 한다(registry.test.ts). */
  nameKey: string;
  run(ctx: CommandContext): Promise<unknown>;
  /** false 면 팔레트에서 숨긴다. 실험 단위 명령에는 쓰지 않는다: 그 명령들은 숨지 않고 왜 못 하는지 말한다. */
  available?(ctx: CommandContext): boolean;
}

/** 등록 순서를 지키는 목록. 같은 id 를 다시 등록하면 자리는 그대로 두고 바꾼다. */
const registry = new Map<string, Command>();

export function registerCommand(c: Command): void {
  registry.set(c.id, c);
}

export function commands(): readonly Command[] {
  return [...registry.values()];
}

export function commandById(id: string): Command | undefined {
  return registry.get(id);
}

export function clearCommandsForTest(): void {
  registry.clear();
}
