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
  getNextWorkflowNumber,
  hasWorkflowChecklistSection,
  insertWorkflowChecklistEntries,
  parseExperimenterFromReadme,
} from '@labnoteo/core/lib/workflowStructure';
import { t } from '../../i18n/t';
import { coreLocale } from '../i18n';
import { NoteBusyError, NoteSaveError } from '../noteErrors';
import { processNote } from '../openNotes';
import { README, VAULT_ROOT } from '../paths';
import {
  catalogDescription,
  catalogKoFields,
  readChecklistLabels,
  workflowAliasHint,
  workflowAliasValidator,
  workflowConcept,
} from '../port/aliasHints';
import { ensureVaultCatalogs } from '../port/catalogUpdate';
import { resolveLabnoteDir, warnIfWindowsPathTooLong } from '../port/experiments';
import type { CommandContext } from './context';
import type { Command } from './registry';
import { readmeStamp } from './stamp';

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
export async function pickWorkflow(ctx: CommandContext): Promise<WorkflowItem | undefined> {
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
    { title: host.t('Select workflow'), placeholder: host.t('Search workflows') },
  );
}

/** "만들었다" 알림, 그리고 README 체크리스트에 넣지 못했으면 그 경고. */
function notifyWorkflowCreated(ctx: CommandContext, created: CreatedWorkflow): void {
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
 * 별칭을 묻고, 워크플로 노트를 쓰고, README 체크리스트에 등록한다. 노트를 열지는 않는다. 별칭을 닫으면 undefined.
 */
export async function createWorkflowFile(
  ctx: CommandContext,
  labnoteDir: string,
  chosen: WorkflowItem,
): Promise<CreatedWorkflow | undefined> {
  const { host } = ctx;
  // 같은 별칭 경고를 위해 묻기 전에 읽는다
  const existingFiles = await host.fs.list(labnoteDir);
  const existingLabels = await readChecklistLabels(host.fs, labnoteDir);
  const locale = coreLocale();
  const alias = await host.alias({
    id: chosen.id,
    catalogName: chosen.name,
    title: host.t('Workflow name'),
    placeholder: host.t('Enter a name for this workflow'),
    about: workflowConcept(host),
    description: chosen.description ? catalogDescription(chosen.id, chosen.description, locale) : undefined,
    hint: workflowAliasHint(host, chosen.id, chosen.name, existingFiles, existingLabels),
    validate: workflowAliasValidator(host),
  });
  if (alias === undefined) return undefined;
  const cleanAlias = alias.trim();

  const readmePath = posix.join(labnoteDir, README);
  let experimenter = '';
  if (await host.fs.exists(readmePath)) experimenter = parseExperimenterFromReadme(await host.fs.read(readmePath));

  const sequence = getNextWorkflowNumber(await host.fs.list(labnoteDir));
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
    registered = await registerWorkflowInReadme(ctx, readmePath, { title: displayTitle, fileName });
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
      ? stamp(insertWorkflowChecklistEntries(text, [{ done: false, title: entry.title, fileName: entry.fileName }]))
      : text;
  });
  return hasSection ? 'registered' : 'noSection';
}

/** 'create-workflow': 열린 노트의 실험에 카탈로그 워크플로를 만들고 연다. `chosen` 은 Workflows 패널이 이미 고른 것. */
export async function createWorkflow(ctx: CommandContext, chosen?: WorkflowItem): Promise<void> {
  const labnoteDir = resolveLabnoteDir(ctx.host, ctx.activePath());
  if (!labnoteDir) return;
  await createWorkflowIn(ctx, labnoteDir, chosen);
}

/** 그 실험 폴더에 카탈로그 워크플로를 만들고 연다(파일 트리 메뉴: 열린 노트가 아니라 누른 폴더의 실험). */
export async function createWorkflowIn(ctx: CommandContext, labnoteDir: string, chosen?: WorkflowItem): Promise<void> {
  const item = chosen ?? (await pickWorkflow(ctx));
  if (!item) return;
  const created = await createWorkflowFile(ctx, labnoteDir, item);
  if (!created) return;
  await ctx.openFile(created.path);
  notifyWorkflowCreated(ctx, created);
}

/** 그 경로가 실험의 README(labnote 아래 ###_ 폴더 바로 안의 README.labnote.md)인가. 편집기 메뉴가 "워크플로 삽입"을 보일지 정한다. */
export function isExperimentReadme(path: string | undefined): boolean {
  if (!path || posix.basename(path) !== README) return false;
  const found = diagnoseExperimentPath(path);
  return found.kind === 'ok' && posix.join(found.folder, README) === path;
}

/**
 * 편집기 메뉴의 "워크플로 삽입"(열린 노트가 실험 README 일 때만 보인다, 플러그인 main.ts:820-835).
 * 워크플로 노트를 만들고 그 README 체크리스트에 등록한다(그 항목이 곧 링크다). 커서에는 아무것도 넣지 않는다.
 */
export async function insertWorkflowOnReadme(ctx: CommandContext): Promise<void> {
  const labnoteDir = resolveLabnoteDir(ctx.host, ctx.activePath());
  if (!labnoteDir) return;
  const chosen = await pickWorkflow(ctx);
  if (!chosen) return;
  const created = await createWorkflowFile(ctx, labnoteDir, chosen);
  if (!created) return;
  notifyWorkflowCreated(ctx, created);
}

/** registerAll.ts 가 등록하는 워크플로 명령. id 와 이름은 플러그인 그대로. */
export const workflowCommands: Command[] = [
  { id: 'create-workflow', nameKey: 'Create workflow', run: (ctx) => createWorkflow(ctx) },
];
