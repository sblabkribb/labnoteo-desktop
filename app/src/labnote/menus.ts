/**
 * 파일 트리와 편집기의 맥락 메뉴(오른쪽 클릭). 메뉴를 여는 순간 만든다: 앱 글자는 labelKey(그릴 때 번역),
 * 플러그인 명령 이름은 coreT 로 그 순간의 언어다. 항목은 모두 ContextMenu 가 runCommand 로 돌린다.
 */
import * as posix from '@labnoteo/core/posix';
import { diagnoseExperimentPath, getExperimentDir } from '@labnoteo/core/lib/labnoteStructure';
import { getSeoulDateString, getSeoulDateTimeString } from '@labnoteo/core/lib/dateUtils';
import { isValidWorkflowPath } from '@labnoteo/core/lib/workflowStructure';
import { createSampleEnv } from '../samples/env';
import type { EditorView } from '@codemirror/view';
import { clipboardTarget, copySelection, cutSelection, pasteClipboard, selectAllIn } from '../editor/commands/clipboardActions';
import { displayKey } from '../editor/commands/appCommands';
import { FORMAT_KEYS, runFormatCommand } from '../editor/commands/formatCommands';
import { INSERT_TABLE_KEY, insertTable } from '../editor/table/commands';
import { openWithDefaultApp, revealInFolder } from '../fs/vaultOpen';
import type { IconName } from '../ui/Icon';
import { activeCellView } from '../editor/table/cellEditor';
import type { LinkHit } from '../editor/live/links';
import { copyText, markdownLinkFor, noteLinkText } from '../links/clipboard';
import { linkIndex } from '../links/linkIndex';
import type { TreeEntry } from '../tree/useTree';
import type { CommandContext } from './commands/context';
import { commandById } from './commands/registry';
import { insertCallout, insertCodeBlock, insertDate, insertHr, insertIssueMarker, insertMathBlock, runBlockInsert } from './commands/editorInserts';
import { changeExperimentStatus, toggleDiscussionFlag } from './commands/experiment';
import { deleteEntry, newFolder, newNoteIn, renameEntry } from './commands/fileOps';
import { syncWorkflowChecklist } from './commands/syncChecklist';
import { insertUnitOp } from './commands/unitOp';
import { createWorkflowIn, insertWorkflowOnReadme, isExperimentReadme } from './commands/workflow';
import { coreT } from './i18n';
import { exportExperimentTablesToCsv, exportTablesToCsv } from './port/exportCsv';
import { sampleEditorMenuItems } from './port/sampleCommands';
import { isNotePath } from './panel/treeIcons';
import { README } from './paths';
import { markerExperimentDir } from '../../vendor/labnoteo/src/issueMarkerIndex';
import { MENU_SEPARATOR, type MenuAction, type MenuItem } from './ui/menuStore';

/** 폴더가 실험 폴더이거나 그 안에 있으면 그 실험 폴더. */
function experimentOf(dir: string): string | undefined {
  const found = diagnoseExperimentPath(posix.join(dir, README));
  return found.kind === 'ok' ? found.folder : undefined;
}

/**
 * 파일 트리 줄의 메뉴(명세 §5.6). 위험 항목(삭제)은 구분선 뒤 맨 끝이다.
 * - 파일: 열기, (첨부: 기본 앱으로 열기, 폴더에서 보기), 위키링크 복사(노트) 또는 임베드 링크 복사(첨부), 경로 복사.
 *   실험 README 면 실험 상태 변경과 논의 표시 전환을 더한다. 그다음 이름 바꾸기, 삭제.
 * - 폴더: 여기에 새 노트, 새 폴더, 경로 복사, 이름 바꾸기, 삭제. 실험 안의 폴더면 워크플로 생성(그 실험에)을 더한다.
 * - CSV 내보내기(플러그인 main.ts registerFileMenu): 실험 폴더 자체와 실험 README 에는 "이 실험의 모든 표", .md 파일에는
 *   "이 노트의 표". 열린 노트가 아니라 누른 노트나 폴더를 내보낸다.
 */
export function noteTreeMenu(ctx: CommandContext, entry: TreeEntry, entries: readonly TreeEntry[]): MenuItem[] {
  const { path, isDir } = entry;
  const copyPath: MenuAction = { labelKey: 'header.copyPath', icon: 'copy', run: () => copyText(path, ctx.host.notify) };
  const tail: MenuItem[] = [
    MENU_SEPARATOR,
    { labelKey: 'menu.rename', icon: 'pencil', run: () => renameEntry(ctx, path, isDir, entries) },
    { labelKey: 'menu.delete', icon: 'trash-2', danger: true, run: () => deleteEntry(ctx, path, isDir) },
  ];
  if (isDir) {
    const experiment = experimentOf(path);
    return [
      { labelKey: 'menu.newNoteHere', icon: 'file-plus', run: () => newNoteIn(ctx, path) },
      { labelKey: 'menu.newFolder', icon: 'folder-plus', run: () => newFolder(ctx, path) },
      ...(experiment ? [{ label: coreT('Create workflow'), icon: 'workflow' as const, run: () => createWorkflowIn(ctx, experiment) }] : []),
      copyPath,
      ...csvItems(ctx, getExperimentDir(path) === path ? path : undefined),
      ...tail,
    ];
  }
  const experiment = isExperimentReadme(path) ? posix.dirname(path) : undefined;
  const attachment = !isNotePath(path);
  return [
    { labelKey: 'menu.open', icon: 'file', run: () => ctx.openFile(path) },
    ...(attachment
      ? [
          { labelKey: 'menu.openDefault', icon: 'external-link' as const, run: () => openWithDefaultApp(path) },
          { labelKey: 'menu.reveal', icon: 'folder-search' as const, run: () => revealInFolder(path) },
          { labelKey: 'menu.copyEmbed', icon: 'link' as const, run: () => copyText(embedLinkText(path), ctx.host.notify) },
        ]
      : [{ labelKey: 'menu.copyLink', icon: 'link' as const, run: () => copyText(noteLinkText(path), ctx.host.notify) }]),
    copyPath,
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

/** 첨부의 임베드 링크: 이름이 하나뿐이면 `![[이름.확장자]]`, 아니면 보관함 경로, 위키링크로 쓸 수 없는 이름이면 Markdown 이미지 링크. */
function embedLinkText(path: string): string {
  const linktext = linkIndex.resolver().linktextFor(path, '');
  return linktext === null ? `!${markdownLinkFor(path)}` : `![[${linktext}]]`;
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

/** 클립보드 항목이 다룰 편집기(표 칸이면 그 셀 편집기). 노트가 열려 있지 않으면 undefined. */
function targetView(ctx: CommandContext): EditorView | undefined {
  const outer = ctx.activeView();
  return outer ? clipboardTarget(outer) : undefined;
}

/** 잘라내기·복사·붙여넣기·모두 선택. 잘라내기와 복사는 고른 글이 없으면 꺼진다. */
function clipboardItems(ctx: CommandContext): MenuItem[] {
  const view = targetView(ctx);
  const empty = !view || view.state.selection.ranges.every((r) => r.empty);
  const onView = (run: (v: EditorView) => unknown) => async () => {
    const v = targetView(ctx);
    if (v) await run(v);
  };
  const off = empty ? { disabled: true, disabledReason: 'menu.needSelection' } : {};
  return [
    { labelKey: 'menu.cut', icon: 'scissors', shortcut: 'Ctrl+X', ...off, run: onView((v) => cutSelection(v)) },
    { labelKey: 'menu.copy', icon: 'copy', shortcut: 'Ctrl+C', ...off, run: onView((v) => copySelection(v)) },
    {
      labelKey: 'menu.paste',
      icon: 'clipboard-paste',
      shortcut: 'Ctrl+V',
      run: onView((v) => pasteClipboard(v, undefined, (m) => ctx.host.notify('warn', m))),
    },
    { labelKey: 'menu.selectAll', icon: 'text-select', shortcut: 'Ctrl+A', run: onView((v) => selectAllIn(v)) },
  ];
}

/**
 * 삽입 ▸: 표, 콜아웃, 코드 블록, 가로줄, 수식 블록, 그리고 날짜, 날짜·시간, 이슈 마커(플러그인 명령).
 * 이슈 마커는 실험 폴더 바로 안의 README·워크플로 노트(markerExperimentDir)에서만 이슈가 되므로
 * 다른 노트에서는 까닭과 함께 꺼 둔다(실험 폴더 밖의 .labnote.md 도).
 */
function insertSubmenu(ctx: CommandContext, path: string): MenuItem[] {
  const block = (labelKey: string, icon: IconName, insert: (v: EditorView) => boolean): MenuAction => ({
    labelKey,
    icon,
    run: async () => runBlockInsert(ctx, insert),
  });
  const labnote = markerExperimentDir(path) !== undefined;
  return [
    { ...block('menu.table', 'table', (v) => insertTable(v)), shortcut: displayKey(INSERT_TABLE_KEY) },
    block('menu.callout', 'quote', insertCallout),
    block('menu.codeBlock', 'square-code', insertCodeBlock),
    block('menu.hr', 'minus', insertHr),
    block('menu.mathBlock', 'sigma', insertMathBlock),
    MENU_SEPARATOR,
    { labelKey: 'menu.date', icon: 'calendar', run: async () => insertDate(ctx, getSeoulDateString) },
    { labelKey: 'menu.dateTime', icon: 'clock', run: async () => insertDate(ctx, getSeoulDateTimeString) },
    {
      labelKey: 'menu.issueMarker',
      icon: 'triangle-alert',
      ...(labnote ? {} : { disabled: true, disabledReason: 'menu.issueMarker.onlyLabnote' }),
      run: () => insertIssueMarker(ctx),
    },
  ];
}

/** 서식 ▸: 서식 명령 전부, 단축키와 함께. 블록 서식은 표 칸에서 아무것도 하지 않는다(runFormat). */
function formatSubmenu(ctx: CommandContext): MenuItem[] {
  return FORMAT_KEYS.map(
    (f): MenuItem => ({
      labelKey: f.nameKey,
      icon: FORMAT_ICONS[f.id],
      shortcut: displayKey(f.key),
      run: async () => runFormatCommand(ctx, f),
    }),
  );
}

/** 서식 ▸ 항목의 아이콘(삽입 ▸ 처럼 왼쪽 아이콘 칸을 채운다). */
export const FORMAT_ICONS: Readonly<Record<string, IconName>> = {
  'format-bold': 'bold',
  'format-italic': 'italic',
  'format-strikethrough': 'strikethrough',
  'format-code': 'code',
  'format-highlight': 'highlighter',
  'format-link': 'link',
  'format-heading-1': 'heading-1',
  'format-heading-2': 'heading-2',
  'format-heading-3': 'heading-3',
  'format-heading-4': 'heading-4',
  'format-heading-5': 'heading-5',
  'format-heading-6': 'heading-6',
  'format-paragraph': 'pilcrow',
  'format-bullet-list': 'list',
  'format-numbered-list': 'list-ordered',
  'format-task': 'list-todo',
  'format-quote': 'text-quote',
  'format-code-block': 'square-code',
};

/**
 * 편집기 본문의 메뉴(`path` 는 열린 노트, 명세 §5.6의 순서). 표 칸의 메뉴는 표가 따로 띄운다.
 * 1. 잘라내기·복사·붙여넣기·모두 선택, 2. 삽입 ▸, 서식 ▸, 3. "실험 노트" 구역(항목이 있을 때만):
 * - 커서가 링크 위면 링크 열기와 링크 복사.
 * - 샘플 추적이 켜진 노트면(어느 .md 든) 샘플 항목: 커서가 샘플 참조 위면 정의로 이동, 그리고 늘 샘플 추가(플러그인 editor-menu 의 순서).
 * - 워크플로 노트: 유닛 오퍼레이션 삽입. 실험 README: 워크플로 삽입(만들고 체크리스트에 등록, 커서에는 링크를 넣지 않는다),
 *   체크리스트 맞추기, 실험 상태 변경, 논의 표시 전환.
 */
export function editorMenu(ctx: CommandContext, path: string, link?: { hit: LinkHit; text: string; open(): void }): MenuItem[] {
  const lab: MenuItem[] = [
    ...(link ? linkItems(ctx, link) : []),
    ...sampleEditorMenuItems(createSampleEnv(ctx), path, cursorState(ctx)).map((i): MenuAction => ({ ...i, icon: i.icon ?? 'test-tube' })),
    ...noteItems(ctx, path),
  ];
  const first = lab[0];
  if (first && !first.separator) lab[0] = { ...first, section: 'menu.labnote' };
  return [
    ...clipboardItems(ctx),
    MENU_SEPARATOR,
    { labelKey: 'menu.insert', icon: 'plus', run: async () => undefined, submenu: insertSubmenu(ctx, path) },
    { labelKey: 'menu.format', icon: 'heading', run: async () => undefined, submenu: formatSubmenu(ctx) },
    ...lab,
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
    { labelKey: 'menu.link.open', icon: 'external-link', run: async () => link.open() },
    { labelKey: 'menu.link.copy', icon: 'link', run: () => copyText(copied, ctx.host.notify) },
  ];
}

function stripAngles(href: string): string {
  const h = href.trim();
  return h.startsWith('<') && h.endsWith('>') ? h.slice(1, -1).trim() : h;
}

/** 보기 머리의 ⋯ 메뉴가 부르는 명령(있고 열린 노트에 맞는 것만, 이 순서로). */
const MORE_COMMANDS = ['print-whole-note', 'print-experiment-worksheet', 'export-tables-csv', 'export-experiment-tables-csv'];

/**
 * 보기 머리의 ⋯ 메뉴(`path` 는 열린 노트): 경로 복사, 링크 복사, 인쇄·CSV 내보내기 명령(열린 노트에 맞는 것만),
 * 그리고 실험 README 면 체크리스트 맞추기·상태 변경·논의 표시 전환.
 */
export function viewMoreMenu(ctx: CommandContext, path: string): MenuItem[] {
  const commands = MORE_COMMANDS.map((id) => commandById(id)).filter(
    (c): c is NonNullable<typeof c> => c !== undefined && (c.available?.(ctx) ?? true),
  );
  return [
    { labelKey: 'header.copyPath', run: () => copyText(path, ctx.host.notify) },
    { labelKey: 'menu.copyLink', run: () => copyText(noteLinkText(path), ctx.host.notify) },
    ...(commands.length > 0 ? [MENU_SEPARATOR] : []),
    ...commands.map((c): MenuItem => ({ label: coreT(c.nameKey), run: () => c.run(ctx) })),
    ...(isExperimentReadme(path)
      ? [
          MENU_SEPARATOR,
          { label: coreT('Sync workflow checklist with folder'), run: () => syncWorkflowChecklist(ctx) },
          { label: coreT('Change experiment status'), run: () => changeExperimentStatus(ctx) },
          { label: coreT('Toggle discussion flag'), run: () => toggleDiscussionFlag(ctx) },
        ]
      : []),
  ];
}

/** "실험 노트" 구역의 노트 종류별 명령. */
function noteItems(ctx: CommandContext, path: string): MenuItem[] {
  if (isValidWorkflowPath(path)) {
    return [{ label: coreT('Insert unit operation'), icon: 'circle-dot', run: () => insertUnitOp(ctx) }];
  }
  if (isExperimentReadme(path)) {
    return [
      { label: coreT('Insert workflow'), icon: 'workflow', run: () => insertWorkflowOnReadme(ctx) },
      { label: coreT('Sync workflow checklist with folder'), icon: 'refresh-cw', run: () => syncWorkflowChecklist(ctx) },
      { label: coreT('Change experiment status'), icon: 'circle-half', run: () => changeExperimentStatus(ctx) },
      { label: coreT('Toggle discussion flag'), icon: 'pencil', run: () => toggleDiscussionFlag(ctx) },
    ];
  }
  return [];
}
