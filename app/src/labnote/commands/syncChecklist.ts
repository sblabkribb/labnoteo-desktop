/**
 * 'sync-workflow-checklist' 의 더하기만 하는 판. 플러그인 commands.ts 의 syncWorkflowChecklistCommand(2029-2110 과 그 뒤의
 * 보고)를 본떴다: 폴더에 있는데 README "Related Workflows" 체크리스트에 없는 워크플로 노트(옮겨 오거나 복사한 것)를 더한다.
 * 앱에서 달라진 것:
 * - 빼기, 이름표 고치기, 중복 지우기, 하위 폴더에서 되돌리기, 노트 제목과 실험자 맞추기는 하지 않는다. 그런 항목이 있으면
 *   앱 문장 syncChecklist.partial 로 알린다(이름 바꾸기 하위 프로젝트의 전체 명령이 고친다).
 * - README 쓰기는 processNote 변환이다: 계획은 쓰는 순간의 README(열려 있으면 그 버퍼)로 다시 세운다.
 * - 더했으면 last_updated_date 를 찍는다(readmeStamp).
 */
import * as posix from '@labnoteo/core/posix';
import { parseWorkflowFileName, planWorkflowChecklistSync, workflowLabelFor } from '@labnoteo/core/lib/workflowStructure';
import { t } from '../../i18n/t';
import { processNote } from '../openNotes';
import { README } from '../paths';
import { resolveLabnoteDir } from '../port/experiments';
import type { CommandContext } from './context';
import type { Command } from './registry';
import { readmeStamp } from './stamp';

/** 폴더의 이름들과 워크플로 노트마다의 체크리스트 이름표(노트의 front matter 제목, 없으면 파일 이름에서). */
async function readWorkflowFolder(ctx: CommandContext, labnoteDir: string): Promise<{ names: string[]; titles: Map<string, string> }> {
  const { fs } = ctx.host;
  const names = await fs.list(labnoteDir);
  const titles = new Map<string, string>();
  for (const name of names) {
    if (!parseWorkflowFileName(name)) continue;
    let content: string | undefined;
    try {
      content = await fs.read(posix.join(labnoteDir, name));
    } catch {
      content = undefined; // 읽지 못한 노트는 파일 이름에서 이름표를 만든다
    }
    titles.set(name, workflowLabelFor(name, content));
  }
  return { names, titles };
}

/** 'sync-workflow-checklist': 열린 노트의 실험 README 체크리스트에 빠진 워크플로 노트를 더한다. */
export async function syncWorkflowChecklist(ctx: CommandContext): Promise<void> {
  const { host } = ctx;
  const labnoteDir = resolveLabnoteDir(host, ctx.activePath());
  if (!labnoteDir) return;
  const readmePath = posix.join(labnoteDir, README);
  if (!(await host.fs.exists(readmePath))) {
    host.notify('warn', host.t('This experiment has no README.labnote.md.'));
    return;
  }

  const { names, titles } = await readWorkflowFolder(ctx, labnoteDir);
  const stamp = readmeStamp(ctx.settings);
  let plan = planWorkflowChecklistSync(await host.fs.read(readmePath), names, titles, undefined, labnoteDir);
  if (plan.hasSection && plan.added.length > 0) {
    await processNote(host.fs, readmePath, (text) => {
      plan = planWorkflowChecklistSync(text, names, titles, undefined, labnoteDir);
      return plan.hasSection && plan.added.length > 0 ? stamp(plan.content) : text;
    });
  }
  if (!plan.hasSection) {
    host.notify('warn', host.t('README.labnote.md has no "Related Workflows" section.'));
    return;
  }

  const unfixed = plan.stale.length > 0 || plan.relabel.length > 0 || plan.duplicates.length > 0;
  let message =
    plan.added.length > 0
      ? host.t('Workflow checklist updated: {0} added, {1} removed.', String(plan.added.length), '0')
      : unfixed
        ? host.t('No changes made.')
        : host.t('The workflow checklist already matches the folder.');
  if (unfixed) message += ` ${t('syncChecklist.partial')}`;
  host.notify('info', message);
}

/** registerAll.ts 가 등록한다. 이름은 플러그인 그대로(README 템플릿과 noSection 경고가 이 이름을 말한다). */
export const syncChecklistCommands: Command[] = [
  { id: 'sync-workflow-checklist', nameKey: 'Sync workflow checklist with folder', run: (ctx) => syncWorkflowChecklist(ctx) },
];
