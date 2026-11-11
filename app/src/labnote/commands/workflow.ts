/**
 * 워크플로 명령: 카탈로그에서 만들기(create-workflow), README 편집기 메뉴의 "워크플로 삽입", README 체크리스트 등록.
 * 플러그인 commands.ts 의 pickWorkflow(1322-1333), createWorkflowForItem / createWorkflowCommand(1340-1366),
 * createWorkflowFromChoice / notifyWorkflowCreated / createWorkflowFile / registerWorkflowInReadme(1159-1290),
 * insertWorkflowLinkCommand 의 README 갈래(1371-1397)를 본뜬 앱의 오케스트레이터다.
 * 앱에서 달라진 것:
 * - Obsidian 의 App 대신 CommandContext. "이 노트"는 ctx.activePath() 다. 별칭 대화상자는 host.alias.
 * - README 등록은 processNote 변환이다: 구역이 있는지는 변환 안에서(열린 버퍼의 글로) 본다. 따로 디스크를 읽지 않는다.
 * - "워크플로 삽입"은 README 갈래만 옮긴다: 체크리스트 항목이 곧 링크라서 커서에는 아무것도 넣지 않는다.
 *   팔레트 명령은 없고, 커서에 링크를 넣는 일반 경로도 없다.
 * - 만든 뒤 ctx.refresh(). 경로 길이 경고는 ctx.vaultRoot 로 잰다.
 */
import type { WorkflowItem } from '@labnoteo/core';
import * as posix from '@labnoteo/core/posix';
import { diagnoseExperimentPath } from '@labnoteo/core/lib/labnoteStructure';
import { loadWorkflows } from '@labnoteo/core/lib/workflowDataLoader';
import {
  createWorkflowContent,
  createWorkflowFileName,
  hasWorkflowChecklistSection,
  insertWorkflowChecklistEntries,
  parseExperimenterFromReadme,
  workflowAliasBudget,
  workflowAliasLength,
} from '@labnoteo/core/lib/workflowStructure';
import { t } from '../../i18n/t';
import { coreLocale } from '../i18n';
import { NoteBusyError, NoteSaveError } from '../noteErrors';
import { openNote, processNote } from '../openNotes';
import { toggleChecklistTick } from '../checklistTick';
import { workflowTickIn } from '../notePosition';
import { isReadmeName, resolveReadmePath, samePath, VAULT_ROOT } from '../paths';
import {
  catalogDescriptionShown,
  catalogKoFields,
  readChecklistLabels,
  workflowAliasHint,
  workflowAliasValidator,
  workflowConcept,
} from '../port/aliasHints';
import { ALIAS_BACK, pickThen, type AliasBack } from '../host/dialogStore';
import { ensureVaultCatalogs } from '../port/catalogUpdate';
import { resolveLabnoteDir, warnIfWindowsPathTooLong } from '../port/experiments';
import type { CommandContext } from './context';
import type { Command } from './registry';
import { readmeStamp } from './stamp';
import { checklistCounts, offerStatusNudge, type ChecklistCounts } from './statusNudge';
import { insertLegacyChecklistLine, nextWorkflowSeq, pad3 } from './workflowOrderPlan';

/**
 * registerWorkflowInReadme 가 한 일. 'notRegistered': README 가 편집기에 열려 있는데 바쁘거나(NoteBusyError)
 * 저장하지 못해서(NoteSaveError) 체크리스트를 디스크에 넣지 못했다. 노트는 이미 만들어졌으니 만들기는 실패가 아니다.
 */
export type WorkflowRegistration = 'registered' | 'noSection' | 'noReadme' | 'notRegistered';

/** 새로 만든 워크플로 노트. */
export interface CreatedWorkflow {
  /** 보관함 경로. */
  path: string;
  fileName: string;
  /** 체크리스트와 링크에 보이는 `id name [alias]`. */
  displayTitle: string;
  registered: WorkflowRegistration;
}

/** 카탈로그 고르기(먼저 보관함에 카탈로그 파일을 채운다). 루트는 늘 VAULT_ROOT('.')다. */
export async function pickWorkflow(ctx: CommandContext, step?: PickStep): Promise<WorkflowItem | undefined> {
  const { host } = ctx;
  await ensureVaultCatalogs(host);
  const catalog = await loadWorkflows(host.fs, VAULT_ROOT);
  const locale = coreLocale();
  return host.pick(
    catalog.workflows.map((wf) => ({
      label: `${wf.id}: ${wf.name}`,
      ...catalogKoFields(wf.id, wf.category, wf.description, locale),
      value: wf,
    })),
    {
      title: t('header.addWorkflow'),
      placeholder: host.t('Search workflows'),
      // 한 줄 행, Design / Build / Test / Learn 묶음, 최근 고른 것 먼저(UI 재설계 Task 11)
      catalog: true,
      groupOf: (item) => (item.value as WorkflowItem).category || undefined,
      recentKey: 'workflow',
      ...step,
    },
  );
}

/** 고르기 → 별칭 단계에서 고르기가 받는 것: 다시 열 때의 검색어와 그 알림(dialogStore.pickThen). */
export type PickStep = { query: string; onQuery: (query: string) => void };

/** 별칭 안내의 글자 수는 남은 자리가 이만큼 이하일 때만 보인다(같은 별칭 경고와 넘침 경고는 늘 보인다). */
export const ALIAS_COUNTER_NEAR = 10;

/** "만들었다" 알림, 그리고 README 체크리스트에 넣지 못했으면 그 경고. */
export function notifyWorkflowCreated(ctx: CommandContext, created: CreatedWorkflow): void {
  const { host } = ctx;
  host.notify('info', host.t('Workflow created: {0}', created.fileName));
  if (created.registered === 'noReadme') {
    host.notify('warn', host.t('This experiment has no README.labnote.md, so the workflow was not added to a checklist.'));
  } else if (created.registered === 'noSection') {
    host.notify(
      'warn',
      host.t(
        'README.labnote.md has no "Related Workflows" section, so the workflow was not added to its checklist. Add the section back, then run "{0}".',
        host.t('Sync workflow checklist with folder'),
      ),
    );
  } else if (created.registered === 'notRegistered') {
    host.notify('warn', t('workflow.readmeNotUpdated', host.t('Sync workflow checklist with folder')));
  }
}

/**
 * 별칭을 묻는다. 닫으면 undefined, `back` 이면 "다시 고르기"에 ALIAS_BACK.
 * 글자 수 안내는 파일 이름 자리의 끝에서 ALIAS_COUNTER_NEAR 글자 안일 때만 보인다(같은 별칭·넘침 경고는 늘).
 */
async function askWorkflowAlias(ctx: CommandContext, labnoteDir: string, chosen: WorkflowItem, back: boolean): Promise<string | undefined | AliasBack> {
  const { host } = ctx;
  // 같은 별칭 경고를 위해 묻기 전에 읽는다
  const existingFiles = await host.fs.list(labnoteDir);
  const existingLabels = await readChecklistLabels(host.fs, labnoteDir);
  const locale = coreLocale();
  const fullHint = workflowAliasHint(host, chosen.id, chosen.name, existingFiles, existingLabels);
  const budget = workflowAliasBudget(chosen.id, chosen.name);
  return host.alias({
    id: chosen.id,
    catalogName: chosen.name,
    placeholder: host.t('Enter a name for this workflow'),
    about: workflowConcept(host),
    // 보이기만 하는 설명: 한국어 화면의 용어 규칙(koTerms)을 따른다
    description: chosen.description ? catalogDescriptionShown(chosen.id, chosen.description, locale) : undefined,
    hint: (value) => {
      const hint = fullHint(value);
      return hint.warn || workflowAliasLength(value) >= budget - ALIAS_COUNTER_NEAR ? hint : undefined;
    },
    validate: workflowAliasValidator(host),
    ...(back ? { back: true as const } : {}),
  });
}

/**
 * 별칭을 묻고, 워크플로 노트를 쓰고, README 체크리스트에 등록한다. 노트를 열지는 않는다. 별칭을 닫으면 undefined.
 */
export async function createWorkflowFile(
  ctx: CommandContext,
  labnoteDir: string,
  chosen: WorkflowItem,
): Promise<CreatedWorkflow | undefined> {
  const alias = await askWorkflowAlias(ctx, labnoteDir, chosen, false);
  if (alias === undefined || alias === ALIAS_BACK) return undefined;
  return writeWorkflowFile(ctx, labnoteDir, chosen, alias);
}

/**
 * 카탈로그에서 고르고(`chosen` 이 없을 때) 별칭을 물어 만든다. 별칭 단계의 Esc·뒤로 단추는 앞 검색어로 고르기를 다시 연다.
 */
async function pickAndCreateWorkflow(ctx: CommandContext, labnoteDir: string, chosen?: WorkflowItem): Promise<CreatedWorkflow | undefined> {
  if (chosen) return createWorkflowFile(ctx, labnoteDir, chosen);
  const done = await pickWorkflowAndAlias(ctx, labnoteDir);
  if (!done) return undefined;
  return writeWorkflowFile(ctx, labnoteDir, done.chosen, done.alias);
}

/** 카탈로그에서 고르고 별칭을 묻는다(아무것도 쓰지 않는다). 닫으면 undefined. "여기 뒤에 Workflow 추가"가 먼저 묻는다. */
export async function pickWorkflowAndAlias(ctx: CommandContext, labnoteDir: string): Promise<{ chosen: WorkflowItem; alias: string } | undefined> {
  const done = await pickThen(
    (step) => pickWorkflow(ctx, step),
    (item) => askWorkflowAlias(ctx, labnoteDir, item, true),
  );
  if (!done || done.result === undefined) return undefined;
  return { chosen: done.value, alias: done.result };
}

/** writeWorkflowFile 의 덧붙임: 정한 번호, 그리고 체크리스트 등록을 대신하는 함수("여기 뒤에" 넣기). */
export interface WriteWorkflowOpts {
  seq?: number;
  register?: (readmePath: string, entry: { title: string; fileName: string }) => Promise<WorkflowRegistration>;
}

/** 워크플로 노트를 쓰고 README 체크리스트에 등록한다. */
export async function writeWorkflowFile(
  ctx: CommandContext,
  labnoteDir: string,
  chosen: WorkflowItem,
  alias: string,
  opts: WriteWorkflowOpts = {},
): Promise<CreatedWorkflow> {
  const { host } = ctx;
  const locale = coreLocale();
  const cleanAlias = alias.trim();

  // 예전 보관함의 실험은 README.md 다: 있는 것을 고른다
  const readmePath = await resolveReadmePath(host.fs, labnoteDir);
  let experimenter = '';
  if (await host.fs.exists(readmePath)) experimenter = parseExperimenterFromReadme(await host.fs.read(readmePath));

  // 예전 이름(`001_WD090_x.md`)도 센다: 코어 getNextWorkflowNumber 는 `.labnote.md` 만 세어 001 을 다시 준다
  const sequence = pad3(opts.seq ?? nextWorkflowSeq(await host.fs.list(labnoteDir)));
  const info = { id: chosen.id, name: chosen.name, description: chosen.description };
  const fileName = createWorkflowFileName(sequence, info, cleanAlias || undefined);
  const workflowPath = posix.join(labnoteDir, fileName);
  await host.fs.write(workflowPath, createWorkflowContent(info, experimenter, cleanAlias || undefined, { locale }));
  warnIfWindowsPathTooLong(host, ctx.vaultRoot, workflowPath);

  const displayTitle = cleanAlias ? `${chosen.id} ${chosen.name} ${cleanAlias}` : `${chosen.id} ${chosen.name}`;
  // 노트는 이미 디스크에 있다: README 를 못 바꿨다고 명령 전체를 실패로 알리면(command.noteBusy "바꾸지 않았습니다")
  // 사람은 다시 실행해 002_ 쌍둥이를 만든다. 그러니 그 두 오류는 여기서 받아 경고로 바꾸고, 새로고침·열기·알림은 그대로 한다.
  let registered: WorkflowRegistration;
  try {
    registered = opts.register
      ? await opts.register(readmePath, { title: displayTitle, fileName })
      : await registerWorkflowInReadme(ctx, readmePath, { title: displayTitle, fileName });
  } catch (err) {
    if (!(err instanceof NoteBusyError || err instanceof NoteSaveError)) {
      ctx.refresh();
      throw err;
    }
    registered = 'notRegistered';
  }
  ctx.refresh();
  return { path: workflowPath, fileName, displayTitle, registered };
}

/**
 * README 의 "Related Workflows" 체크리스트에 새 워크플로를 더하고(지우지 않는다) last_updated_date 를 찍는다.
 * 쓰는 순간의 README(열려 있으면 그 버퍼)에 적용하는 변환이라 열린 README 의 저장 안 된 입력이 남는다.
 * 구역이 있는지도 그 변환 안에서 본다. README 가 없거나 구역이 없으면 아무것도 쓰지 않고 그렇다고 돌려준다.
 */
export async function registerWorkflowInReadme(
  ctx: CommandContext,
  readmePath: string,
  entry: { title: string; fileName: string },
): Promise<WorkflowRegistration> {
  const { host } = ctx;
  if (!(await host.fs.exists(readmePath))) return 'noReadme';
  const stamp = readmeStamp(ctx.settings);
  let hasSection = false;
  await processNote(host.fs, readmePath, (text) => {
    hasSection = hasWorkflowChecklistSection(text);
    return hasSection
      ? stamp(
          // 예전 줄뿐인 README 는 코어가 맨 위에 넣는다: 번호 차례의 자리에, 그 줄들의 꼴로 넣는다
          insertLegacyChecklistLine(text, entry) ?? insertWorkflowChecklistEntries(text, [{ done: false, title: entry.title, fileName: entry.fileName }]),
          readmePath,
        )
      : text;
  });
  return hasSection ? 'registered' : 'noSection';
}

/** 워크플로를 더할 실험(실험 탭의 줄): 없으면 열린 노트의 실험이다. */
export interface WorkflowTarget {
  experimentDir: string;
}

/**
 * 'create-workflow': 카탈로그 워크플로를 만들고 연다. `chosen` 은 이미 고른 것. `target` 을 주면(실험 탭의 추가 줄과 `+`)
 * 열린 노트가 아니라 그 실험에 만든다. 없으면 열린 노트의 실험이다.
 */
export async function createWorkflow(ctx: CommandContext, chosen?: WorkflowItem, target?: WorkflowTarget): Promise<void> {
  const labnoteDir = target ? target.experimentDir : resolveLabnoteDir(ctx.host, ctx.activePath());
  if (!labnoteDir) return;
  await createWorkflowIn(ctx, labnoteDir, chosen);
}

/**
 * README "Related Workflows" 체크리스트에서 그 워크플로 노트(`fileName`, 대소문자 무시)의 항목을 체크하거나 푼다
 * (실험 탭의 상태 아이콘). 열린 README 면 그 버퍼에 적용하고 last_updated_date 를 찍는다. 항목이 없으면 알리고 아무것도 쓰지 않는다.
 * 돌려주는 값은 바뀐 뒤의 체크 상태(항목이 없으면 undefined).
 */
export async function toggleWorkflowTick(ctx: CommandContext, experimentDir: string, fileName: string): Promise<boolean | undefined> {
  const { host } = ctx;
  const readmePath = await resolveReadmePath(host.fs, experimentDir);
  if (!(await host.fs.exists(readmePath))) {
    host.notify('warn', host.t('This experiment has no README.labnote.md, so the workflow was not added to a checklist.'));
    return undefined;
  }
  const stamp = readmeStamp(ctx.settings);
  let after: boolean | undefined;
  let counts: { prev: ChecklistCounts; next: ChecklistCounts } | undefined;
  await processNote(host.fs, readmePath, (text) => {
    counts = undefined;
    after = undefined;
    // 예전 보관함의 줄(`.md` 링크, 앞의 "- " 없음)도 찾는다. 상자 글자만 바꾼다
    const toggled = toggleChecklistTick(text, fileName);
    if (!toggled) return text;
    after = toggled.ticked;
    const written = stamp(toggled.text, readmePath);
    counts = { prev: checklistCounts(text), next: checklistCounts(written) };
    return written;
  });
  if (after === undefined) host.notify('warn', t('experiments.notInChecklist', fileName, host.t('Sync workflow checklist with folder')));
  // 상태 권유(Task 19): 계획 실험의 첫 체크 → 진행 중, 마지막 체크 → 완료를 알림 단추로 묻는다
  else if (counts) offerStatusNudge(ctx, readmePath, counts.prev, counts.next);
  return after;
}

/**
 * README 의 지금 글: 편집기에 열려 있으면 그 버퍼(저장하지 않은 체크도 본다), 아니면 디스크. 없으면 undefined.
 */
export async function readReadmeText(ctx: CommandContext, readmePath: string): Promise<string | undefined> {
  const view = openNote(readmePath)?.view();
  if (view) return view.state.doc.toString();
  if (!(await ctx.host.fs.exists(readmePath))) return undefined;
  return ctx.host.fs.read(readmePath);
}

/** 그 Workflow 노트의 README 체크 상태(항목이 없거나 README 가 없으면 undefined). README 는 실험마다 고른다(README.labnote.md, 없으면 README.md). */
export async function readWorkflowTick(ctx: CommandContext, workflowPath: string): Promise<boolean | undefined> {
  const text = await readReadmeText(ctx, await resolveReadmePath(ctx.host.fs, posix.dirname(workflowPath)));
  return text === undefined ? undefined : workflowTickIn(text, workflowPath);
}

/** 열린 Workflow 노트의 완료 표시를 바꾼다(팔레트 명령, 보기 머리의 칩). 바뀐 뒤의 체크 상태, 못 했으면 undefined. */
export function toggleWorkflowDone(ctx: CommandContext, workflowPath: string): Promise<boolean | undefined> {
  return toggleWorkflowTick(ctx, posix.dirname(workflowPath), posix.basename(workflowPath));
}

/**
 * 모든 Unit Operation 이 끝났을 때(편집기의 uoAllDoneWatch) README 에서 아직 체크하지 않은 Workflow 면 알림의 단추 하나로
 * 완료 표시를 권한다. 누르지 않으면 아무것도 바뀌지 않는다. 이미 체크했거나 체크리스트에 없으면 묻지 않는다. 물었으면 true.
 */
export async function offerWorkflowDoneNudge(ctx: CommandContext, workflowPath: string): Promise<boolean> {
  let ticked: boolean | undefined;
  try {
    ticked = await readWorkflowTick(ctx, workflowPath);
  } catch {
    return false;
  }
  if (ticked !== false) return false;
  ctx.host.notify('info', t('nudge.wfDone'), {
    ms: 10000,
    action: {
      label: t('nudge.wfDone.mark'),
      // 그 사이 다른 곳에서 체크했으면 풀지 않는다
      run: () =>
        void readWorkflowTick(ctx, workflowPath)
          .then((now) => (now === false ? toggleWorkflowDone(ctx, workflowPath) : undefined))
          .catch(() => {}),
    },
  });
  return true;
}

/** 그 실험 폴더에 카탈로그 워크플로를 만들고 연다(파일 트리 메뉴: 열린 노트가 아니라 누른 폴더의 실험). */
export async function createWorkflowIn(ctx: CommandContext, labnoteDir: string, chosen?: WorkflowItem): Promise<void> {
  const created = await pickAndCreateWorkflow(ctx, labnoteDir, chosen);
  if (!created) return;
  await ctx.openFile(created.path);
  notifyWorkflowCreated(ctx, created);
}

/**
 * 그 경로가 실험의 README(labnote 아래 ###_ 폴더 바로 안의 README.labnote.md, 예전 보관함이면 README.md)인가.
 * 편집기 메뉴가 "워크플로 삽입"을 보일지, 보기 머리가 체크리스트 칩을 그릴지 정한다. 경로만 본다(두 이름이 다 있는 폴더의
 * README.md 도 참이다: 드문 일이고, 명령은 쓸 때 resolveReadmePath 로 README.labnote.md 를 고른다).
 */
export function isExperimentReadme(path: string | undefined): boolean {
  if (!path || !isReadmeName(posix.basename(path))) return false;
  const found = diagnoseExperimentPath(path);
  return found.kind === 'ok' && samePath(posix.join(found.folder, posix.basename(path)), path);
}

/**
 * 편집기 메뉴의 "워크플로 삽입"(열린 노트가 실험 README 일 때만 보인다, 플러그인 main.ts:820-835).
 * 워크플로 노트를 만들고 그 README 체크리스트에 등록한다(그 항목이 곧 링크다). 커서에는 아무것도 넣지 않는다.
 */
export async function insertWorkflowOnReadme(ctx: CommandContext): Promise<void> {
  const labnoteDir = resolveLabnoteDir(ctx.host, ctx.activePath());
  if (!labnoteDir) return;
  const created = await pickAndCreateWorkflow(ctx, labnoteDir);
  if (!created) return;
  notifyWorkflowCreated(ctx, created);
}

/** registerAll.ts 가 등록하는 워크플로 명령. id 와 이름은 플러그인 그대로. */
export const workflowCommands: Command[] = [
  { id: 'create-workflow', nameKey: 'Create workflow', icon: 'workflow', run: (ctx) => createWorkflow(ctx) },
];
