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
import { t } from '../../i18n/t';
import { editTargetFor } from '../editTarget';
import { coreLocale } from '../i18n';
import { NoteBusyError } from '../noteErrors';
import { openNote } from '../openNotes';
import { VAULT_ROOT, samePath } from '../paths';
import { catalogDescription, catalogKoFields, unitOpAliasHint, workflowAliasValidator } from '../port/aliasHints';
import { ensureVaultCatalogs } from '../port/catalogUpdate';
import { insertUnitOpAndUpdateToc } from '../port/insertUnitOpAndUpdateToc';
import { pickThen, type AliasBack } from '../host/dialogStore';
import type { CommandContext } from './context';
import type { PickStep } from './workflow';
import type { Command } from './registry';

/** 고른 단위 공정과 그 종류(HW/SW). */
export interface ChosenUnitOp {
  op: UnitOperationItem;
  kind: 'hw' | 'sw';
}

/** 카탈로그에서 단위 공정을 고른다(먼저 보관함에 카탈로그 파일을 채운다). 루트는 늘 VAULT_ROOT('.')다. */
async function pickUnitOp(ctx: CommandContext, step?: PickStep): Promise<ChosenUnitOp | undefined> {
  const { host } = ctx;
  await ensureVaultCatalogs(host);
  const hw = await loadUnitOperations(host.fs, VAULT_ROOT, 'hw');
  const sw = await loadUnitOperations(host.fs, VAULT_ROOT, 'sw');
  const locale = coreLocale();
  // 장비·소프트웨어 이름도 찾는다("plate reader" -> UHW380 Microplate Reading)
  const row = (op: UnitOperationItem, kind: 'hw' | 'sw'): PickItem<ChosenUnitOp> => {
    const fields = catalogKoFields(op.id, kind === 'hw' ? 'HW' : 'SW', op.description, locale);
    const tools = [op.equipment, op.software].filter((x): x is string => !!x);
    return {
      label: `${op.id}: ${op.name}`,
      ...fields,
      ...(tools.length > 0 || fields.keywords ? { keywords: [...(fields.keywords ?? []), ...tools] } : {}),
      value: { op, kind },
    };
  };
  const items = [...hw.unitOperations.map((op) => row(op, 'hw')), ...sw.unitOperations.map((op) => row(op, 'sw'))];
  return host.pick(items, {
    title: host.t('Insert unit operation'),
    placeholder: host.t('Search unit operations'),
    catalog: true,
    groupOf: (item) => ((item.value as ChosenUnitOp).kind === 'hw' ? t('catalog.hw') : t('catalog.sw')),
    recentKey: 'unitOp',
    ...step,
  });
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

/** UO 를 넣을 워크플로 노트(실험 탭의 줄): 없으면 열린 노트다. */
export interface UnitOpTarget {
  workflowPath: string;
}

/** 코어의 넣기 입력. */
function toInput({ op, kind }: ChosenUnitOp): InsertUnitOperationInput {
  return { opId: op.id, opName: op.name, opDescription: op.description, opType: kind, equipment: op.equipment, software: op.software };
}

/** 편집기가 그 노트를 다 읽을 때까지 기다리는 가장 긴 시간(ms). */
const OPEN_WAIT_MS = 5000;

/**
 * 실험 탭에서 고른 워크플로 노트를 열고, 커서를 마지막 UO 제목(없으면 노트 끝)에 둔다: 새 UO 가 마지막 UO 뒤에 들어간다.
 * 줄은 편집기가 그 노트를 다 읽은 뒤 **편집기의 본문**에서 센다(저장하지 않은 고침이 있어도 다른 블록 안에 들어가지 않게).
 * 열지 못하면 그 까닭(알림 문구)을, 열었으면 undefined.
 */
async function openAtLastUnitOp(ctx: CommandContext, path: string): Promise<string | undefined> {
  const { host } = ctx;
  if (!(await host.fs.exists(path))) return t('experiments.uo.noNote', path);
  await ctx.openFile(path);
  const ready = () => {
    const handle = openNote(path);
    const view = ctx.activeView();
    return samePath(ctx.activePath(), path) && handle !== undefined && !handle.busy() && view !== undefined && handle.view() === view;
  };
  for (const start = Date.now(); !ready(); ) {
    if (Date.now() - start > OPEN_WAIT_MS) {
      // 다른 노트가 열려 있으면(저장하지 못해 바꾸지 못했다) 그 까닭은 편집기가 이미 알렸다
      return samePath(ctx.activePath(), path)
        ? t('experiments.uo.stillLoading')
        : t('experiments.uo.notOpened');
    }
    await new Promise((r) => setTimeout(r, 30));
  }
  const view = ctx.activeView()!;
  const doc = view.state.doc;
  const blocks = listUnitOpBlocks(doc.toString());
  const line = blocks.length > 0 ? blocks[blocks.length - 1].headingLine : doc.lines - 1;
  const at = doc.line(Math.min(Math.max(1, line + 1), doc.lines)).from;
  view.dispatch({ selection: { anchor: at }, scrollIntoView: true });
  return undefined;
}

/**
 * 열린 워크플로 노트의 커서가 있는 블록 뒤에 단위 공정 블록을 넣고 목차를 맞춘다. 블록과 목차는 되돌리기 한 번이다.
 * `chosen` 을 주면(카탈로그) 고르기를 건너뛴다. `into` 를 주면(실험 탭의 추가 줄과 `+`) 그 워크플로 노트를 열고 마지막 UO 뒤에 넣는다.
 */
export async function insertUnitOp(ctx: CommandContext, chosen?: ChosenUnitOp, into?: UnitOpTarget): Promise<void> {
  const { host } = ctx;
  if (into) {
    const problem = workflowPathProblem(host, into.workflowPath);
    if (problem) {
      host.notify('warn', problem);
      return;
    }
    const failed = await openAtLastUnitOp(ctx, into.workflowPath);
    if (failed) {
      host.notify('warn', failed);
      return;
    }
  }
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

  // 고르기 → 별칭: 별칭 단계의 Esc·뒤로 단추는 앞 검색어로 고르기를 다시 연다(카탈로그에서 이미 고른 것이면 뒤로가 없다)
  const done = await pickThen(
    (step) => (chosen ? Promise.resolve(chosen) : pickUnitOp(ctx, step)),
    async (picked): Promise<string | undefined | AliasBack> => {
      const input = toInput(picked);
      const shown = viewOf(ctx, path);
      if (!shown) return undefined;
      const blocks = listUnitOpBlocks(shown.state.doc.toString());
      const fullHint = unitOpAliasHint(host, { id: input.opId, name: input.opName }, blocks);
      return host.alias({
        id: input.opId,
        catalogName: input.opName,
        placeholder: host.t('Run or condition of this step (optional)'),
        about: host.t(
          'A unit operation is a single task within a workflow (one step using a piece of equipment or software). The alias tells repeats of the same task apart by run or condition and appears in its heading and the table of contents. You can leave it empty.',
        ),
        description: input.opDescription ? catalogDescription(input.opId, input.opDescription, coreLocale()) : undefined,
        // UO 별칭은 파일 이름에 들지 않아 길이 제한이 없다: 글자 수는 보이지 않고 같은 별칭 경고만 보인다
        hint: (value) => {
          const hint = fullHint(value);
          return hint.warn ? hint : undefined;
        },
        validate: workflowAliasValidator(host),
        ...(chosen ? {} : { back: true }),
      });
    },
  );
  if (!done || done.result === undefined) return;
  const alias = done.result;
  const input = toInput(done.value);

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
  { id: 'insert-unit-operation', nameKey: 'Insert unit operation', icon: 'circle-dot', run: (ctx) => insertUnitOp(ctx) },
];
