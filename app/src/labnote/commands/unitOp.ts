/**
 * 단위 공정 넣기(insert-unit-operation). 플러그인 commands.ts 의 insertUnitOperationCommand / unitOpAliasPrompt
 * (1471-1550)를 본뜬 앱의 오케스트레이터다. 앱에서 달라진 것:
 * - Obsidian 의 App 대신 CommandContext. "이 노트"는 ctx.activePath(), 뷰는 ctx.activeView() 다.
 * - 고르기와 별칭을 먼저 묻는다(대화상자가 떠 있는 동안 .shell 은 inert 라 사람이 칠 수 없다).
 * - 코어는 두 번 고친다(블록 넣기, 그다음 목차를 위한 전체 다시 쓰기). 둘은 멀리 떨어져 있어 CodeMirror 기록이
 *   합치지 않으므로, 묶음 편집 대상(editTargetFor().batch)의 사본에서 돌리고 한 번에(되돌리기 한 번) 적용한다.
 * - 코어의 알림은 묶음이 적용된 뒤에 낸다: 그 사이 노트가 바뀌어(NoteChangedError) 아무것도 넣지 않았는데
 *   "넣었다"고 말하지 않게.
 * - 블록 모드는 없다: 코어가 구역 구조로 넣을 곳을 고르고, 표 안의 커서는 단위 공정 블록 안이라 블록 뒤로 간다.
 */
import type { InsertUnitOperationInput, NotifyKind, PickItem, UnitOperationItem } from '@labnoteo/core';
import { listUnitOpBlocks, workflowPathProblem } from '@labnoteo/core';
import { loadUnitOperations } from '@labnoteo/core/lib/workflowDataLoader';
import { editTargetFor } from '../editTarget';
import { coreLocale } from '../i18n';
import { NoteBusyError } from '../noteErrors';
import { openNote } from '../openNotes';
import { VAULT_ROOT } from '../paths';
import { catalogDescription, catalogKoFields, unitOpAliasHint, workflowAliasValidator } from '../port/aliasHints';
import { ensureVaultCatalogs } from '../port/catalogUpdate';
import { insertUnitOpAndUpdateToc } from '../port/insertUnitOpAndUpdateToc';
import type { CommandContext } from './context';
import type { Command } from './registry';

/** 고른 단위 공정과 그 종류(HW/SW). */
export interface ChosenUnitOp {
  op: UnitOperationItem;
  kind: 'hw' | 'sw';
}

/** 카탈로그에서 단위 공정을 고른다(먼저 보관함에 카탈로그 파일을 채운다). 루트는 늘 VAULT_ROOT('.')다. */
async function pickUnitOp(ctx: CommandContext): Promise<ChosenUnitOp | undefined> {
  const { host } = ctx;
  await ensureVaultCatalogs(host);
  const hw = await loadUnitOperations(host.fs, VAULT_ROOT, 'hw');
  const sw = await loadUnitOperations(host.fs, VAULT_ROOT, 'sw');
  const locale = coreLocale();
  const items: PickItem<ChosenUnitOp>[] = [
    ...hw.unitOperations.map((op) => ({
      label: `${op.id}: ${op.name}`,
      ...catalogKoFields(op.id, 'HW', op.description, locale),
      value: { op, kind: 'hw' as const },
    })),
    ...sw.unitOperations.map((op) => ({
      label: `${op.id}: ${op.name}`,
      ...catalogKoFields(op.id, 'SW', op.description, locale),
      value: { op, kind: 'sw' as const },
    })),
  ];
  return host.pick(items, { title: host.t('Insert unit operation'), placeholder: host.t('Search unit operations') });
}

/**
 * 열린 노트의 뷰. 노트가 열려 있는데 바쁘면(읽는 중, 바깥 변경을 확인해야 함) NoteBusyError, 열려 있지 않으면 undefined.
 */
function viewOf(ctx: CommandContext, path: string) {
  const view = ctx.activeView();
  if (view) return view;
  if (openNote(path)) throw new NoteBusyError(path);
  return undefined;
}

/**
 * 열린 워크플로 노트의 커서가 있는 블록 뒤에 단위 공정 블록을 넣고 목차를 맞춘다. 블록과 목차는 되돌리기 한 번이다.
 * `chosen` 을 주면(Workflows 패널) 고르기를 건너뛴다.
 */
export async function insertUnitOp(ctx: CommandContext, chosen?: ChosenUnitOp): Promise<void> {
  const { host } = ctx;
  const path = ctx.activePath();
  if (!path) {
    host.notify('warn', host.t('Please open a workflow file.'));
    return;
  }
  // 무엇이든 묻기 전에 거절한다
  const problem = workflowPathProblem(host, path);
  if (problem) {
    host.notify('warn', problem);
    return;
  }
  if (!viewOf(ctx, path)) {
    host.notify('warn', host.t('Please open a workflow file.'));
    return;
  }

  const picked = chosen ?? (await pickUnitOp(ctx));
  if (!picked) return;
  const { op, kind } = picked;
  const input: InsertUnitOperationInput = {
    opId: op.id,
    opName: op.name,
    opDescription: op.description,
    opType: kind,
    equipment: op.equipment,
    software: op.software,
  };

  const shown = viewOf(ctx, path);
  if (!shown) return;
  const blocks = listUnitOpBlocks(shown.state.doc.toString());
  const alias = await host.alias({
    id: input.opId,
    catalogName: input.opName,
    title: host.t('Unit operation alias'),
    placeholder: host.t('Run or condition of this step (optional)'),
    about: host.t(
      'A unit operation is a single task within a workflow (one step using a piece of equipment or software). The alias tells repeats of the same task apart by run or condition and appears in its heading and the table of contents. You can leave it empty.',
    ),
    description: input.opDescription ? catalogDescription(input.opId, input.opDescription, coreLocale()) : undefined,
    hint: unitOpAliasHint(host, { id: input.opId, name: input.opName }, blocks),
    validate: workflowAliasValidator(host),
  });
  if (alias === undefined) return;

  const view = viewOf(ctx, path);
  if (!view) return;
  const target = editTargetFor(view, path, () => openNote(path)?.busy() ?? true);
  const pending: Array<[NotifyKind, string]> = [];
  await target.batch((t) =>
    insertUnitOpAndUpdateToc(
      { ...host, editTarget: () => t, notify: (k, m) => void pending.push([k, m]) },
      input,
      async () => alias,
      { sortToc: ctx.settings.autoSyncUnitOpToc },
    ),
  );
  for (const [k, m] of pending) host.notify(k, m);
}

export const unitOpCommands: Command[] = [
  { id: 'insert-unit-operation', nameKey: 'Insert unit operation', run: (ctx) => insertUnitOp(ctx) },
];
