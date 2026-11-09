/**
 * 파일 트리와 편집기의 맥락 메뉴(오른쪽 클릭). 메뉴를 여는 순간 만든다: 앱 글자는 labelKey(그릴 때 번역),
 * 플러그인 명령 이름은 coreT 로 그 순간의 언어다. 항목은 모두 ContextMenu 가 runCommand 로 돌린다.
 */
import * as posix from '@labnoteo/core/posix';
import { diagnoseExperimentPath, getExperimentDir } from '@labnoteo/core/lib/labnoteStructure';
import { getSeoulDateString, getSeoulDateTimeString } from '@labnoteo/core/lib/dateUtils';
import { isValidWorkflowPath } from '@labnoteo/core/lib/workflowStructure';
import { createSampleEnv } from '../samples/env';
import { FORMAT_KEYS, runFormatCommand } from '../editor/commands/formatCommands';
import { activeCellView } from '../editor/table/cellEditor';
import type { LinkHit } from '../editor/live/links';
import { copyText, noteLinkText } from '../links/clipboard';
import type { TreeEntry } from '../tree/useTree';
import type { CommandContext } from './commands/context';
import { insertDate, insertIssueMarker } from './commands/editorInserts';
import { changeExperimentStatus, toggleDiscussionFlag } from './commands/experiment';
import { deleteEntry, newFolder, newNoteIn, renameEntry } from './commands/fileOps';
import { syncWorkflowChecklist } from './commands/syncChecklist';
import { insertUnitOp } from './commands/unitOp';
import { createWorkflowIn, insertWorkflowOnReadme, isExperimentReadme } from './commands/workflow';
import { coreT } from './i18n';
import { exportExperimentTablesToCsv, exportTablesToCsv } from './port/exportCsv';
import { sampleEditorMenuItems } from './port/sampleCommands';
import { README } from './paths';
import { MENU_SEPARATOR, type MenuAction, type MenuItem } from './ui/menuStore';

/** 폴더가 실험 폴더이거나 그 안에 있으면 그 실험 폴더. */
function experimentOf(dir: string): string | undefined {
  const found = diagnoseExperimentPath(posix.join(dir, README));
  return found.kind === 'ok' ? found.folder : undefined;
}

/**
 * 파일 트리 줄의 메뉴.
 * - 파일: 열기, 위키링크 복사, 이름 바꾸기, 삭제. 실험 README 면 실험 상태 변경과 논의 표시 전환을 더한다.
 * - 폴더: 여기에 새 노트, 새 폴더, 이름 바꾸기, 삭제. 실험 안의 폴더면 워크플로 생성(그 실험에)을 더한다.
 * - CSV 내보내기(플러그인 main.ts registerFileMenu): 실험 폴더 자체와 실험 README 에는 "이 실험의 모든 표", .md 파일에는
 *   "이 노트의 표". 열린 노트가 아니라 누른 노트나 폴더를 내보낸다.
 */
export function noteTreeMenu(ctx: CommandContext, entry: TreeEntry, entries: readonly TreeEntry[]): MenuAction[] {
  const { path, isDir } = entry;
  const tail: MenuAction[] = [
    { labelKey: 'menu.rename', run: () => renameEntry(ctx, path, isDir, entries) },
    { labelKey: 'menu.delete', run: () => deleteEntry(ctx, path, isDir) },
  ];
  if (isDir) {
    const experiment = experimentOf(path);
    return [
      { labelKey: 'menu.newNoteHere', run: () => newNoteIn(ctx, path) },
      { labelKey: 'menu.newFolder', run: () => newFolder(ctx, path) },
      ...(experiment ? [{ label: coreT('Create workflow'), run: () => createWorkflowIn(ctx, experiment) }] : []),
      ...csvItems(ctx, getExperimentDir(path) === path ? path : undefined),
      ...tail,
    ];
  }
  const experiment = isExperimentReadme(path) ? posix.dirname(path) : undefined;
  return [
    { labelKey: 'menu.open', run: () => ctx.openFile(path) },
    { labelKey: 'menu.copyLink', run: () => copyText(noteLinkText(path), ctx.host.notify) },
    ...(experiment
      ? [
          { label: coreT('Change experiment status'), run: () => changeExperimentStatus(ctx, experiment) },
          { label: coreT('Toggle discussion flag'), run: () => toggleDiscussionFlag(ctx, experiment) },
        ]
      : []),
    ...csvItems(ctx, csvExperimentOfFile(path), path),
    ...tail,
  ];
}

/** 실험 README 면 그 실험 폴더(플러그인처럼 이름은 대소문자를 가리지 않고, 실험은 getExperimentDir 로). */
function csvExperimentOfFile(path: string): string | undefined {
  return posix.basename(path).toLowerCase() === README.toLowerCase() ? getExperimentDir(path) : undefined;
}

/** CSV 내보내기 항목: 실험 폴더가 있으면 실험 전체, .md 노트면 그 노트(플러그인 순서). */
function csvItems(ctx: CommandContext, experimentDir: string | undefined, notePath?: string): MenuAction[] {
  return [
    ...(experimentDir
      ? [{ label: coreT('Export all tables of this experiment to CSV'), run: () => exportExperimentTablesToCsv(ctx, experimentDir) }]
      : []),
    ...(notePath !== undefined && posix.extname(notePath) === '.md'
      ? [{ label: coreT('Export tables to CSV'), run: () => exportTablesToCsv(ctx, notePath) }]
      : []),
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
 * 서식 항목: 구분선 하나 뒤에 납작하게(MenuItem 에는 하위 메뉴가 없다). 이름은 labelKey 라 그릴 때 번역한다.
 * 블록 서식은 표 칸에서 아무것도 하지 않는다(runFormat).
 */
function formatItems(ctx: CommandContext): MenuItem[] {
  return [MENU_SEPARATOR, ...FORMAT_KEYS.map((f): MenuItem => ({ labelKey: f.nameKey, run: async () => runFormatCommand(ctx, f) }))];
}

/**
 * 편집기 본문의 메뉴(`path` 는 열린 노트). 커서가 링크 위면 링크 열기와 링크 복사가 맨 앞에 온다. 표 칸의 메뉴는 표가 따로 띄운다. 어느 노트든 끝에 서식 항목이 붙는다.
 * - 워크플로 노트: 유닛 오퍼레이션 삽입, 그리고 넣기 명령.
 * - 실험 README: 워크플로 삽입(만들고 체크리스트에 등록, 커서에는 링크를 넣지 않는다), 체크리스트 맞추기,
 *   실험 상태 변경, 논의 표시 전환, 그리고 넣기 명령.
 * - 그 밖의 .labnote.md: 넣기 명령. 일반 .md 는 서식 항목만.
 * 샘플 추적이 켜진 노트면(어느 .md 든) 노트 항목 앞에 샘플 항목이 온다: 커서가 샘플 참조 위면 정의로 이동, 그리고 늘 샘플 추가
 * (플러그인 editor-menu 의 순서).
 */
export function editorMenu(ctx: CommandContext, path: string, link?: { hit: LinkHit; text: string; open(): void }): MenuItem[] {
  return [
    ...(link ? linkItems(ctx, link) : []),
    ...sampleEditorMenuItems(createSampleEnv(ctx), path, cursorState(ctx)),
    ...noteItems(ctx, path),
    ...formatItems(ctx),
  ];
}

/** 커서가 있는 편집기의 상태: 표 칸을 편집 중이면 그 셀 편집기(바깥 커서는 칸 안 커서를 늘 따라가지 않는다). */
function cursorState(ctx: CommandContext) {
  const outer = ctx.activeView();
  return outer ? (activeCellView(outer) ?? outer).state : undefined;
}

/** 커서 아래 링크의 항목(SP4 Task 12): 열기, 그리고 복사(위키링크는 원문 그대로, Markdown 링크는 주소). */
function linkItems(ctx: CommandContext, link: { hit: LinkHit; text: string; open(): void }): MenuItem[] {
  const { hit } = link;
  const copied = hit.kind === 'wiki' ? link.text : stripAngles(hit.href);
  return [
    { labelKey: 'menu.link.open', run: async () => link.open() },
    { labelKey: 'menu.link.copy', run: () => copyText(copied, ctx.host.notify) },
  ];
}

function stripAngles(href: string): string {
  const h = href.trim();
  return h.startsWith('<') && h.endsWith('>') ? h.slice(1, -1).trim() : h;
}

function noteItems(ctx: CommandContext, path: string): MenuItem[] {
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
