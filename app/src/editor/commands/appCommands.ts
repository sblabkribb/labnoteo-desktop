import type { CommandContext } from '../../labnote/commands/context';
import { commands } from '../../labnote/commands/registry';
import { TOGGLE_MODE_KEY, toggleMode } from '../live/mode';
import { FORMAT_KEYS, runFormatCommand } from './formatCommands';

/**
 * 앱 자체의 명령(플러그인에 없는 편집기 명령). 플러그인과 같은 명령은 labnote/commands/registry 에 있고, 이것들은 따로 둔다:
 * 이름은 coreT 키가 아니라 앱 번역 키(ko·en)이고, key 는 단축키를 보여 주기만 한다. 팔레트는 두 목록을 함께 보인다.
 */
export interface AppCommand {
  id: string;
  /** 앱 번역 키(i18n/t.ts). ko 와 en 에 모두 있어야 한다(appCommands.test.ts). */
  nameKey: string;
  /** CodeMirror 키 표기(예: 'Mod-e'). 보여 주기만 한다: 실제 바인딩은 편집기의 keymap 이 한다. */
  key?: string;
  run(ctx: CommandContext): Promise<unknown> | unknown;
  /** false 면 팔레트에서 숨긴다. */
  available?(ctx: CommandContext): boolean;
}

/** 등록 순서를 지키는 목록. */
const registry = new Map<string, AppCommand>();

/** 하나를 등록한다. 같은 id 가 이미 있으면(앱 명령이든 플러그인 명령이든) 던진다. */
export function registerAppCommand(c: AppCommand): void {
  if (registry.has(c.id)) throw new Error(`duplicate app command id: ${c.id}`);
  if (commands().some((v) => v.id === c.id)) throw new Error(`app command id collides with a vendor command: ${c.id}`);
  registry.set(c.id, c);
}

export function appCommands(): readonly AppCommand[] {
  return [...registry.values()];
}

export function clearAppCommandsForTest(): void {
  registry.clear();
}

const toggleSource: AppCommand = {
  id: 'editor-toggle-source',
  nameKey: 'cmd.toggleSource',
  key: TOGGLE_MODE_KEY,
  run: () => toggleMode(),
};

/** 서식 명령(formatCommands.ts 의 D10 행). 팔레트에서 돌리면 열린 노트의 뷰(표 칸이면 그 칸)에 쓴다. */
const formatCommands: AppCommand[] = FORMAT_KEYS.map((f) => ({
  id: f.id,
  nameKey: f.nameKey,
  key: f.key,
  run: (ctx) => runFormatCommand(ctx, f),
}));

function allAppCommands(): AppCommand[] {
  return [toggleSource, ...formatCommands];
}

/** 모든 앱 명령을 등록한다. 여러 번 불러도 된다: 이미 같은 명령이 등록돼 있으면 건너뛴다. App.tsx 가 registerAllCommands() 옆에서 부른다. */
export function registerAllAppCommands(): void {
  for (const c of allAppCommands()) {
    if (registry.get(c.id) === c) continue;
    registerAppCommand(c);
  }
}

/** CodeMirror 키를 보여 줄 꼴로: 'Mod-Shift-.' → 'Ctrl+Shift+.', 'Mod-e' → 'Ctrl+E'. */
export function displayKey(cmKey: string): string {
  const parts = cmKey.split(/-(?!$)/);
  const last = parts.pop() ?? '';
  const mods = parts.map((m) => (m === 'Mod' || m === 'Ctrl' ? 'Ctrl' : m === 'Shift' ? 'Shift' : m === 'Alt' ? 'Alt' : m));
  const keyLabel = /^[a-z]$/.test(last) ? last.toUpperCase() : last;
  return [...mods, keyLabel].join('+');
}
