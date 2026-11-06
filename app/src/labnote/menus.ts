/**
 * 파일 트리와 편집기의 맥락 메뉴(오른쪽 클릭). 메뉴를 여는 순간 만든다: 앱 글자는 labelKey(그릴 때 번역),
 * 플러그인 명령 이름은 coreT 로 그 순간의 언어다. 항목은 모두 ContextMenu 가 runCommand 로 돌린다.
 */
import * as posix from '@labnoteo/core/posix';
import { diagnoseExperimentPath } from '@labnoteo/core/lib/labnoteStructure';
import { getSeoulDateString, getSeoulDateTimeString } from '@labnoteo/core/lib/dateUtils';
import { isValidWorkflowPath } from '@labnoteo/core/lib/workflowStructure';
import type { TreeEntry } from '../tree/useTree';
import type { CommandContext } from './commands/context';
import { insertDate, insertIssueMarker } from './commands/editorInserts';
import { changeExperimentStatus, toggleDiscussionFlag } from './commands/experiment';
import { deleteEntry, newFolder, newNoteIn, renameEntry } from './commands/fileOps';
import { syncWorkflowChecklist } from './commands/syncChecklist';
import { insertUnitOp } from './commands/unitOp';
import { createWorkflowIn, insertWorkflowOnReadme, isExperimentReadme } from './commands/workflow';
import { coreT } from './i18n';
import { README } from './paths';
import type { MenuItem } from './ui/menuStore';

/** 폴더가 실험 폴더이거나 그 안에 있으면 그 실험 폴더. */
function experimentOf(dir: string): string | undefined {
  const found = diagnoseExperimentPath(posix.join(dir, README));
  return found.kind === 'ok' ? found.folder : undefined;
}

/**
 * 파일 트리 줄의 메뉴.
 * - 파일: 열기, 이름 바꾸기, 삭제. 실험 README 면 실험 상태 변경과 논의 표시 전환을 더한다.
 * - 폴더: 여기에 새 노트, 새 폴더, 이름 바꾸기, 삭제. 실험 안의 폴더면 워크플로 생성(그 실험에)을 더한다.
 */
export function noteTreeMenu(ctx: CommandContext, entry: TreeEntry, entries: readonly TreeEntry[]): MenuItem[] {
  const { path, isDir } = entry;
  const tail: MenuItem[] = [
    { labelKey: 'menu.rename', run: () => renameEntry(ctx, path, isDir, entries) },
    { labelKey: 'menu.delete', run: () => deleteEntry(ctx, path, isDir) },
  ];
  if (isDir) {
    const experiment = experimentOf(path);
    return [
      { labelKey: 'menu.newNoteHere', run: () => newNoteIn(ctx, path) },
      { labelKey: 'menu.newFolder', run: () => newFolder(ctx, path) },
      ...(experiment ? [{ label: coreT('Create workflow'), run: () => createWorkflowIn(ctx, experiment) }] : []),
      ...tail,
    ];
  }
  const experiment = isExperimentReadme(path) ? posix.dirname(path) : undefined;
  return [
    { labelKey: 'menu.open', run: () => ctx.openFile(path) },
    ...(experiment
      ? [
          { label: coreT('Change experiment status'), run: () => changeExperimentStatus(ctx, experiment) },
          { label: coreT('Toggle discussion flag'), run: () => toggleDiscussionFlag(ctx, experiment) },
        ]
      : []),
    ...tail,
  ];
}

/** 어느 노트에서나 쓰는 넣기 명령: 날짜, 날짜와 시간, 논의 이슈 마커. */
function insertItems(ctx: CommandContext): MenuItem[] {
  return [
    { label: coreT('Insert date'), run: async () => insertDate(ctx, getSeoulDateString) },
    { label: coreT('Insert date and time'), run: async () => insertDate(ctx, getSeoulDateTimeString) },
    { label: coreT('Insert issue marker'), run: () => insertIssueMarker(ctx) },
  ];
}

/**
 * 편집기 본문의 메뉴(`path` 는 열린 노트). 표 칸의 메뉴는 표가 따로 띄운다.
 * - 워크플로 노트: 유닛 오퍼레이션 삽입, 그리고 넣기 명령.
 * - 실험 README: 워크플로 삽입(만들고 체크리스트에 등록, 커서에는 링크를 넣지 않는다), 체크리스트 맞추기,
 *   실험 상태 변경, 논의 표시 전환, 그리고 넣기 명령.
 * - 그 밖의 .labnote.md: 넣기 명령. 일반 .md 에는 메뉴가 없다.
 */
export function editorMenu(ctx: CommandContext, path: string): MenuItem[] {
  if (isValidWorkflowPath(path)) {
    return [{ label: coreT('Insert unit operation'), run: () => insertUnitOp(ctx) }, ...insertItems(ctx)];
  }
  if (isExperimentReadme(path)) {
    return [
      { label: coreT('Insert workflow'), run: () => insertWorkflowOnReadme(ctx) },
      { label: coreT('Sync workflow checklist with folder'), run: () => syncWorkflowChecklist(ctx) },
      { label: coreT('Change experiment status'), run: () => changeExperimentStatus(ctx) },
      { label: coreT('Toggle discussion flag'), run: () => toggleDiscussionFlag(ctx) },
      ...insertItems(ctx),
    ];
  }
  return /\.labnote\.md$/i.test(path) ? insertItems(ctx) : [];
}
