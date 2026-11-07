import type { CommandContext } from '../../labnote/commands/context';
import { commands } from '../../labnote/commands/registry';
import type { EditorView } from '@codemirror/view';
import { t } from '../../i18n/t';
import { openNote } from '../../labnote/openNotes';
import { linkJournal } from '../../links/journal';
import { undoLastRename } from '../../links/undoRename';
import { TOGGLE_MODE_KEY, toggleMode } from '../live/mode';
import { addPropertyCommand, editYamlCommand, PROPS_ADD_KEY } from '../live/properties';
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

/** 사이드바를 개요 탭으로 바꾼다. */
const outlineShow: AppCommand = {
  id: 'outline-show',
  nameKey: 'cmd.outlineShow',
  run: (ctx) => ctx.showPanel('outline'),
};

/** 사이드바를 링크 탭으로 바꾼다(SP4 Task 17). */
const linksShow: AppCommand = {
  id: 'links-show',
  nameKey: 'cmd.linksShow',
  run: (ctx) => ctx.showPanel('links'),
};

/** 뒤로·앞으로 가기(SP4 Task 28). 키는 보여 주기만 한다: App 의 window keydown 이 Alt+←/→ 를 듣는다. */
const navBack: AppCommand = {
  id: 'nav-back',
  nameKey: 'cmd.navBack',
  key: 'Alt-ArrowLeft',
  run: (ctx) => ctx.navigate?.('back'),
};

const navForward: AppCommand = {
  id: 'nav-forward',
  nameKey: 'cmd.navForward',
  key: 'Alt-ArrowRight',
  run: (ctx) => ctx.navigate?.('forward'),
};

/** 마지막 이름 바꾸기 되돌리기(SP4 Task 25, D16). 기록이 끝났고(done) 되돌릴 수 있을 때만 팔레트에 보인다. */
const undoRename: AppCommand = {
  id: 'links-undo-rename',
  nameKey: 'cmd.undoRename',
  run: (ctx) => undoLastRename(ctx, ctx.links?.journal ?? linkJournal),
  available: () => linkJournal.current()?.header.status === 'done' && linkJournal.current()!.header.undoable,
};

/** 서식 명령(formatCommands.ts 의 D10 행). 팔레트에서 돌리면 열린 노트의 뷰(표 칸이면 그 칸)에 쓴다. */
const formatCommands: AppCommand[] = FORMAT_KEYS.map((f) => ({
  id: f.id,
  nameKey: f.nameKey,
  key: f.key,
  run: (ctx) => runFormatCommand(ctx, f),
}));

/**
 * 열린 노트의 뷰에 run. 노트가 없으면 noNote 알림, 노트가 열려 있는데 뷰가 없으면(읽는 중, 풀리지 않은 바깥 변경) noteBusy
 * 알림(runFormatCommand 와 같다). 돌렸는지를 돌려준다.
 */
function runOnNote(ctx: CommandContext, run: (view: EditorView) => boolean): boolean {
  const path = ctx.activePath();
  const view = path ? ctx.activeView() : undefined;
  if (!view) {
    if (path && openNote(path)) ctx.host.notify('warn', t('command.noteBusy'));
    else ctx.host.notify('info', t('cmd.props.noNote'));
    return false;
  }
  return run(view);
}

/** 속성 추가(Ctrl+;). 머리말이 없으면 빈 블록을 넣고 격자의 새 속성 칸으로 간다. */
const propsAdd: AppCommand = {
  id: 'props-add',
  nameKey: 'cmd.props.add',
  key: PROPS_ADD_KEY,
  run: (ctx) => runOnNote(ctx, addPropertyCommand),
};

/** 속성을 YAML로 편집: 머리말을 원문으로 보인다. */
const propsEditYaml: AppCommand = {
  id: 'props-edit-yaml',
  nameKey: 'cmd.props.editYaml',
  run: (ctx) => runOnNote(ctx, editYamlCommand),
};

function allAppCommands(): AppCommand[] {
  return [toggleSource, outlineShow, linksShow, navBack, navForward, undoRename, ...formatCommands, propsAdd, propsEditYaml];
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
