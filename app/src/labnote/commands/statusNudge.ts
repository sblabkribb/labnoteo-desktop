/**
 * 상태 권유(UI 재설계 Task 19, 명세 §7.3). 실험 README 의 "Related Workflows" 체크리스트에서 `planned` 실험의 첫 워크플로를
 * 체크하면 "진행 중"으로, 마지막 워크플로를 체크하면 "완료"로 바꿀지 알림의 단추 하나로 묻는다. 누르지 않으면 아무것도 바뀌지 않는다.
 * 체크는 두 곳에서 일어난다: 편집기의 체크박스(Editor 의 onChecklistTick → App)와 실험 탭의 상태 아이콘(toggleWorkflowTick).
 * 저장 값은 플러그인 그대로다(`in-progress`, `completed`). 화면 글만 현지화한다.
 */
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { DISCUSS_FLAG_KEY, isDiscussFlagged, parseFrontMatterYaml, setFrontMatterKeys } from '@labnoteo/core';
import * as posix from '@labnoteo/core/posix';
import { parseWorkflowChecklistFromReadme, unitOpsAllEnded } from '@labnoteo/core/lib/workflowStructure';
import { t } from '../../i18n/t';
import { frontMatterText } from '../frontMatterText';
import { processNote } from '../openNotes';
import { confirmCompleted, readNoteForFrontMatterEdit } from '../port/status';
import { statusKind } from '../statusLabels';
import type { CommandContext } from './context';
import { readmeStamp } from './stamp';

/** 체크리스트의 셈과 README 의 status(적힌 그대로, 없으면 ''). */
export interface ChecklistCounts {
  done: number;
  total: number;
  status: string;
}

export type StatusNudge = 'inProgress' | 'done';

/** README 글에서 체크리스트 셈과 상태를 읽는다. */
export function checklistCounts(readme: string): ChecklistCounts {
  const text = frontMatterText(readme);
  const items = parseWorkflowChecklistFromReadme(text);
  const status = parseFrontMatterYaml(text).frontMatter.status;
  return { done: items.filter((i) => i.done).length, total: items.length, status: typeof status === 'string' ? status.trim() : '' };
}

/**
 * 체크 하나가 권할 상태. 체크가 늘었을 때만: 모두 체크됐고 상태가 계획이나 진행 중이면 'done', 계획 상태에서 처음 체크했으면
 * 'inProgress'. 그 밖(체크 풀기, 중간 체크, 실패·검토 필요 같은 다른 상태, 이미 완료)은 null.
 */
export function statusNudge(prev: ChecklistCounts, next: ChecklistCounts): StatusNudge | null {
  if (next.total === 0 || next.done <= prev.done) return null;
  const kind = statusKind(next.status);
  if (next.done === next.total && (kind === 'planned' || kind === 'inProgress')) return 'done';
  if (kind === 'planned' && prev.done === 0) return 'inProgress';
  return null;
}

const STORED: Record<StatusNudge, string> = { inProgress: 'in-progress', done: 'completed' };

/**
 * 권한 상태를 README 에 쓴다(알림의 "바꾸기"). 완료로 바꿀 때는 상태 명령과 같이 confirmCompleted 가 남은 일(체크 안 한 워크플로,
 * end_date 없는 노트, 논의 표시, @issue)을 먼저 묻는다. 쓰는 순간의 README(열려 있으면 그 버퍼)에 적용하고 last_updated_date 를 찍는다.
 */
export async function applyStatusNudge(ctx: CommandContext, readmePath: string, nudge: StatusNudge): Promise<void> {
  const { host } = ctx;
  if (!(await host.fs.exists(readmePath))) return;
  const parsed = await readNoteForFrontMatterEdit(host, readmePath);
  if (!parsed) return;
  const changes: Record<string, unknown> = { status: STORED[nudge] };
  if (nudge === 'done') {
    const choice = await confirmCompleted(host, posix.dirname(readmePath), parsed.body, isDiscussFlagged(parsed.frontMatter));
    if (!choice) return;
    if (choice === 'clear') changes[DISCUSS_FLAG_KEY] = undefined;
  }
  const stamp = readmeStamp(ctx.settings);
  await processNote(host.fs, readmePath, (text) => stamp(setFrontMatterKeys(text, changes), readmePath));
}

/** 체크 뒤에 권할 것이 있으면 단추 하나가 달린 알림을 띄운다. 띄웠으면 true. */
export function offerStatusNudge(ctx: CommandContext, readmePath: string, prev: ChecklistCounts, next: ChecklistCounts): boolean {
  const nudge = statusNudge(prev, next);
  if (!nudge) return false;
  const message = nudge === 'done' ? t('nudge.done') : t('nudge.inProgress');
  ctx.host.notify('info', message, {
    ms: 10000,
    action: { label: t('nudge.change'), run: () => void applyStatusNudge(ctx, readmePath, nudge).catch(() => {}) },
  });
  return true;
}

/**
 * 편집기에서 사용자가 체크리스트를 바꾼 거래(체크박스 누름 'input.toggle', `x` 입력 등)를 본다. 명령이 쓴 거래
 * ('input.labnote', 실험 탭의 체크는 그쪽에서 권한다)와 되돌리기는 보지 않는다. 셈이 바뀌면 `onTick(prev, next)` 를 부른다.
 * 실험 README 에만 싣는다(부르는 쪽이 정한다).
 */
export function checklistTickWatch(onTick: (prev: ChecklistCounts, next: ChecklistCounts) => void): Extension {
  return EditorView.updateListener.of((u) => {
    if (!u.docChanged) return;
    const user = u.transactions.some((tr) => tr.docChanged && tr.isUserEvent('input') && !tr.isUserEvent('input.labnote'));
    if (!user) return;
    const prev = checklistCounts(u.startState.doc.toString());
    const next = checklistCounts(u.state.doc.toString());
    if (prev.done !== next.done || prev.total !== next.total) onTick(prev, next);
  });
}

/**
 * Workflow 노트 편집기에서 사용자의 입력(명령 거래 'input.labnote' 와 되돌리기는 빼고)이 마지막 Unit Operation 의
 * End_date 를 채워 모든 UO 가 끝났을 때 한 번 `onAllDone` 을 부른다(코어 unitOpsAllEnded: 끝나지 않음 → 모두 끝남).
 * 부르는 쪽(App)이 README 에서 아직 체크하지 않았으면 Workflow 도 완료로 표시할지 묻는다. 저절로 바꾸지는 않는다.
 */
export function uoAllDoneWatch(onAllDone: () => void): Extension {
  return EditorView.updateListener.of((u) => {
    if (!u.docChanged) return;
    const user = u.transactions.some((tr) => tr.docChanged && tr.isUserEvent('input') && !tr.isUserEvent('input.labnote'));
    if (!user) return;
    if (!unitOpsAllEnded(u.startState.doc.toString()) && unitOpsAllEnded(u.state.doc.toString())) onAllDone();
  });
}
