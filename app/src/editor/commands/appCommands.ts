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
import { runSampleSettings } from '../../samples/SampleSettingsDialog';
import { convertLegacyNotesCommand } from '../../labnote/commands/legacyConvert';
import { runIntegrationSettings } from '../../integrations/IntegrationSettingsDialog';
import { bfwReady } from '../../bfworkflow/bfwApp';
import { runBfwSyncCatalogs } from '../../bfworkflow/syncCatalogs';
import { runNotesFromDesign } from '../../bfworkflow/notesFromDesign';
import { runDesignUsage, runOpenDesign } from '../../bfworkflow/openDesign';

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

/** 샘플 설정(SP5 Task 28, D17): 앱에는 설정 화면이 없어 이 명령이 플러그인 설정 탭의 샘플 칸을 대신한다. */
const sampleSettings: AppCommand = {
  id: 'app.sample-settings',
  nameKey: 'cmd.sampleSettings',
  run: (ctx) => runSampleSettings(ctx),
};

/** 예전 형식(.md) 실험 노트를 .labnote.md 로 바꾸기: 보관함을 열 때의 제안과 같은 대화상자("다시 묻지 않기"와 상관없이). */
const convertLegacyNotes: AppCommand = {
  id: 'app.convert-legacy-notes',
  nameKey: 'cmd.convertLegacyNotes',
  run: (ctx) => convertLegacyNotesCommand(ctx),
};

/** 연동 설정(SP6 D17): partbank, AI 제공자, bfworkflow 의 주소와 키. 키는 Windows 자격 증명 관리자에만 저장한다. */
const integrationSettings: AppCommand = {
  id: 'app.integration-settings',
  nameKey: 'cmd.integrationSettings',
  run: (ctx) => runIntegrationSettings(ctx),
};

/**
 * bfworkflow 카탈로그 동기화(SP6 D16): 서버 카탈로그가 같은 id 의 보관함 항목을 이기고, 보관함에만 있는 항목은 남긴다.
 * 지금 연결(서버 또는 데스크톱 앱)의 키가 설정됐을 때만 보인다.
 */
const bfwSyncCatalogs: AppCommand = {
  id: 'app.bfw-sync-catalogs',
  nameKey: 'cmd.bfwSyncCatalogs',
  run: (ctx) => runBfwSyncCatalogs(ctx),
  available: (ctx) => bfwReady(ctx),
};

/**
 * bfworkflow 설계에서 노트 만들기(SP6 Task 40): 서버에 저장된 노트를 쓰거나 SSE 로 새로 만들어 실험 폴더에 쓴다.
 * 있는 노트는 묻지 않고 덮어쓰지 않는다. 지금 연결의 키가 설정됐을 때만 보인다.
 */
const bfwNotesFromDesign: AppCommand = {
  id: 'app.bfw-notes-from-design',
  nameKey: 'cmd.bfwNotesFromDesign',
  run: (ctx) => runNotesFromDesign(ctx),
  available: (ctx) => bfwReady(ctx),
};

/**
 * bfworkflow 설계를 기본 브라우저에서 열기(SP6 Task 41): 워크플로 노트에서는 그 워크플로를 쓰는 설계 중에서,
 * 아니면 모든 설계 중에서 고른다. 지금 연결의 키가 설정됐을 때만 보인다.
 */
const bfwOpenDesign: AppCommand = {
  id: 'app.bfw-open-design',
  nameKey: 'cmd.bfwOpenDesign',
  run: (ctx) => runOpenDesign(ctx),
  available: (ctx) => bfwReady(ctx),
};

/**
 * 이 워크플로를 쓰는 bfworkflow 설계(SP6 Task 41, 읽기 전용): 설계마다 코드와 노트의 UO 사용 횟수를 보이고,
 * 고르면 설계 페이지를 연다. 사용처를 bfworkflow 로 보내는 것은 서버 엔드포인트가 생길 때까지 미룬다(D3).
 */
const bfwDesignUsage: AppCommand = {
  id: 'app.bfw-design-usage',
  nameKey: 'cmd.bfwDesignUsage',
  run: (ctx) => runDesignUsage(ctx),
  available: (ctx) => bfwReady(ctx),
};

function allAppCommands(): AppCommand[] {
  return [toggleSource, outlineShow, linksShow, navBack, navForward, undoRename, ...formatCommands, propsAdd, propsEditYaml, sampleSettings, convertLegacyNotes, integrationSettings, bfwSyncCatalogs, bfwNotesFromDesign, bfwOpenDesign, bfwDesignUsage];
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
