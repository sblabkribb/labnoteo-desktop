/**
 * 파일 트리의 기본 파일 작업: 새 폴더, 이름 바꾸기, 삭제(휴지통).
 * - 이름 바꾸기는 다른 노트의 링크를 고친다(SP4: 링크 색인, 계획, 기록, 보고). 실험 구조가 이름에 걸린 것 — 실험 폴더,
 *   실험 폴더를 품은 폴더, labnote 폴더, 워크플로 노트, README — 은 여전히 이유를 말하고 거절한다.
 * - 삭제는 언제나 Windows 휴지통(vault_trash)으로 간다. 영구 삭제로 물러서지 않는다.
 * - 열린 노트(또는 그것을 품은 폴더)를 바꾸거나 지우면 먼저 저장하고 닫는다: 그래야 편집기에 "노트가 사라졌습니다"
 *   대화상자가 뜨지 않고, 내려가는 편집기의 저장이 옛 파일을 되살리지 않는다. 저장하지 못하면 아무것도 하지 않는다.
 */
import { diagnoseExperimentPath } from '@labnoteo/core/lib/labnoteStructure';
import { removeWorkflowFromReadme } from '@labnoteo/core/lib/workflowDelete';
import { isValidWorkflowPath } from '@labnoteo/core/lib/workflowStructure';
import { ERROR_KINDS, hasErrorKind } from '../../fs/errorKinds';
import { t } from '../../i18n/t';
import { NOTE_EXT } from '../../tree/createNote';
import type { TreeEntry } from '../../tree/useTree';
import type { JournalStore } from '../../links/journal';
import { IndexNotReadyError, planRename, type RenamePlan } from '../../links/planRename';
import {
  LinkOpsBusyError,
  linkOps,
  READY_WAIT_MS,
  renameEvents,
  renameWithLinks,
  rewritePlanned,
  type FailReason,
  type LinkSession,
  type RenameReport,
} from '../../links/renameWithLinks';
import { hasUnlinkableChars, linkKey } from '../../links/resolve';
import { movesFor, type Move } from '../../links/rewrite';
import { openNote, processNote } from '../openNotes';
import { README } from '../paths';
import { warnIfWindowsPathTooLong } from '../port/experiments';
import { moveTableCsvs, offerTableCsvCleanupOnDelete } from '../port/tableCsvFiles';
import type { CommandContext, LinkDeps } from './context';
import { entryEvents, filesBefore, movedFiles } from './entryEvents';

export type RenameGuard = 'experimentFolder' | 'experimentParent' | 'labnoteRoot' | 'workflowNote' | 'readme' | undefined;

const GUARD_MESSAGE = {
  experimentFolder: 'fileOps.renameGuarded.experimentFolder',
  experimentParent: 'fileOps.renameGuarded.experimentParent',
  labnoteRoot: 'fileOps.renameGuarded.labnoteRoot',
  workflowNote: 'fileOps.renameGuarded.workflowNote',
  readme: 'fileOps.renameGuarded.readme',
} as const;

const lower = (p: string) => p.toLowerCase();
const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const parentOf = (p: string) => (p.lastIndexOf('/') < 0 ? '' : p.slice(0, p.lastIndexOf('/')));
const joinPath = (dir: string, name: string) => (dir === '' || dir === '.' ? name : `${dir}/${name}`);
/** `p` 가 `base` 자체이거나 그 안에 있다. NTFS 라 대소문자를 가리지 않는다. */
const isUnder = (p: string, base: string) => lower(p) === lower(base) || lower(p).startsWith(`${lower(base)}/`);
const isExperimentFolder = (dir: string) => diagnoseExperimentPath(`${dir}/${README}`).kind === 'ok';

/** 이름 바꾸기를 막는 이유. 막지 않으면 undefined. */
export function renameGuard(path: string, isDir: boolean, entries: readonly TreeEntry[]): RenameGuard {
  if (isDir) {
    if (lower(baseName(path)) === 'labnote') return 'labnoteRoot';
    if (isExperimentFolder(path)) return 'experimentFolder';
    const inside = entries.some((e) => e.isDir && lower(e.path).startsWith(`${lower(path)}/`) && isExperimentFolder(e.path));
    return inside ? 'experimentParent' : undefined;
  }
  if (lower(baseName(path)) === lower(README)) return 'readme';
  if (isValidWorkflowPath(path)) return 'workflowNote';
  return undefined;
}

/** 실험 폴더 이름(`###_…`). 파일(`001_x.md` 같은)은 빼고 본다. */
const looksLikeExperiment = (name: string) => /^\d{3}_/.test(name) && !/\.md$/i.test(name);

/**
 * `dir` 아래(그 자신은 빼고)에 `labnote/###_*` 실험 폴더가 있는가. 트리 항목은 .md 노트로 이어지는 폴더만 실으므로
 * 노트가 아직 없는 실험은 거기에 없다: 폴더를 직접 훑는다. 점으로 시작하는 폴더는 건너뛴다(트리가 숨긴다).
 * 목록은 파일이면 비거나 거절된다: 둘 다 "안에 아무것도 없음"으로 본다.
 */
async function holdsExperiment(fs: CommandContext['host']['fs'], dir: string): Promise<boolean> {
  const list = async (d: string) => {
    try {
      return await fs.list(d);
    } catch {
      return [];
    }
  };
  const queue = [dir];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const name of await list(current)) {
      if (name.startsWith('.')) continue;
      const child = joinPath(current, name);
      if (lower(name) === 'labnote' && (await list(child)).some(looksLikeExperiment)) return true;
      queue.push(child);
    }
  }
  return false;
}

/** renameGuard 에 더해, 폴더면 트리 항목에 없는(노트가 없는) 실험도 디스크에서 찾아 막는다. */
async function renameGuardOnDisk(
  fs: CommandContext['host']['fs'],
  path: string,
  isDir: boolean,
  entries: readonly TreeEntry[],
): Promise<RenameGuard> {
  const guard = renameGuard(path, isDir, entries);
  if (guard || !isDir) return guard;
  return (await holdsExperiment(fs, path)) ? 'experimentParent' : undefined;
}

/** NewNote 와 같은 이름 규칙: 비었거나, 구분자가 있거나(하위 폴더가 생긴다), 점으로 시작하면(트리가 숨긴다) 안 된다. */
function nameProblem(name: string): string | null {
  if (name === '') return t('fileOps.name.empty');
  if (name.includes('/') || name.includes('\\')) return t('fileOps.name.separator');
  if (name.startsWith('.')) return t('fileOps.name.invalid');
  return null;
}

/** 노트 파일의 확장자(이름 바꾸기에서 그대로 남는다). `.labnote.md`, `.md`, 아니면 없음. */
function extensionOf(name: string): string {
  if (/\.labnote\.md$/i.test(name)) return name.slice(-'.labnote.md'.length);
  if (/\.md$/i.test(name)) return name.slice(-'.md'.length);
  return '';
}

/** 사용자가 확장자까지 적었으면 뗀다(확장자는 원래 것이 붙는다). */
function stemOf(input: string, ext: string): string {
  const s = input.trim();
  return ext ? s.replace(/\.labnote\.md$/i, '').replace(/\.md$/i, '') : s;
}

/** Rust confine 의 거절(Windows 금지 이름, 이탈, .obsidian)인가. */
const refusedName = (e: unknown) => hasErrorKind(e, ERROR_KINDS.escape) || hasErrorKind(e, ERROR_KINDS.forbidden);

/** 사용자가 쓴 노트 이름의 몸통(앞뒤 공백과 `.labnote.md`/`.md` 를 뗀 것). 새 노트는 늘 NOTE_EXT 다. */
const noteStem = (input: string) => input.trim().replace(/\.labnote\.md$/i, '').replace(/\.md$/i, '');

/** 쓰는 순간 그 경로에 이미 내용이 있었다(확인과 쓰기 사이에 생겼다). */
class NoteExistsError extends Error {}

/**
 * 파일 트리 메뉴의 "여기에 새 노트": `dir` 안에 빈 `.labnote.md` 를 만들고 연다. 만든 경로를 돌려준다.
 * NewNote 와 같은 규칙이다. 같은 이름은 먼저 확인하고, 쓰기는 빈 내용을 기대값으로 하는 modify 라서
 * 그사이 내용이 있는 노트가 생겨도 덮어쓰지 않는다.
 */
export async function newNoteIn(ctx: CommandContext, dir: string): Promise<string | undefined> {
  const { host } = ctx;
  const input = await host.prompt({
    title: t('menu.newNoteHere'),
    prompt: t('newNote.label'),
    validate: (v) => nameProblem(noteStem(v)),
  });
  if (input === undefined) return undefined;
  const stem = noteStem(input);
  const problem = nameProblem(stem);
  if (problem) {
    host.notify('warn', problem);
    return undefined;
  }
  const path = joinPath(dir, stem + NOTE_EXT);
  if (await host.fs.exists(path)) {
    host.notify('warn', t('fileOps.exists'));
    return undefined;
  }
  try {
    await host.fs.modify(path, (current) => {
      if (current !== '') throw new NoteExistsError();
      return '';
    });
  } catch (e) {
    if (e instanceof NoteExistsError) {
      host.notify('warn', t('fileOps.exists'));
      return undefined;
    }
    if (!refusedName(e)) throw e;
    host.notify('warn', t('fileOps.name.invalid'));
    return undefined;
  }
  ctx.refresh();
  warnIfWindowsPathTooLong(host, ctx.vaultRoot, path);
  await ctx.openFile(path);
  return path;
}

/** `parentDir` 안에 새 폴더를 만든다. 만든 경로를 돌려준다(취소하거나 거절하면 undefined). */
export async function newFolder(ctx: CommandContext, parentDir: string): Promise<string | undefined> {
  const { host } = ctx;
  const input = await host.prompt({
    title: t('fileOps.newFolder'),
    prompt: t('fileOps.newFolder.prompt'),
    validate: (v) => nameProblem(v.trim()),
  });
  if (input === undefined) return undefined;
  const name = input.trim();
  const problem = nameProblem(name);
  if (problem) {
    host.notify('warn', problem);
    return undefined;
  }
  const path = joinPath(parentDir, name);
  // create_dir_all 은 있는 폴더에 조용히 성공하므로 먼저 확인한다(NTFS: 대소문자 무관).
  if (await host.fs.exists(path)) {
    host.notify('warn', t('fileOps.exists'));
    return undefined;
  }
  try {
    await host.fs.mkdir(path);
  } catch (e) {
    if (!refusedName(e)) throw e;
    host.notify('warn', t('fileOps.name.invalid'));
    return undefined;
  }
  ctx.refresh();
  warnIfWindowsPathTooLong(host, ctx.vaultRoot, path);
  return path;
}

/** 링크를 고치지 못한 이유의 문구. */
const REASON_TEXT: Record<FailReason, () => string> = {
  busy: () => t('links.reason.busy'),
  notSaved: () => t('links.reason.notSaved'),
  conflict: () => t('links.reason.conflict'),
  gone: () => t('links.reason.gone'),
  unsafeName: () => t('links.reason.unsafeName'),
  ambiguous: () => t('links.reason.ambiguous'),
  io: () => t('links.reason.io'),
};

/** 링크를 고치지 못한 노트를 한 줄씩: `경로 (이유)`. */
export function failureLines(failed: RenameReport['failed']): string {
  return failed.map((f) => `${f.path} (${REASON_TEXT[f.reason]()})`).join('\n');
}

/** 이름 바꾸기 실패를 알림으로 바꾼다(이미 있음, 거절된 이름). 다룬 실패면 true, 아니면 호출자가 다시 던진다. */
function reportRenameFailure(host: CommandContext['host'], e: unknown): boolean {
  if (e instanceof LinkOpsBusyError) {
    host.notify('warn', t('links.busy'));
    return true;
  }
  if (hasErrorKind(e, ERROR_KINDS.exists)) {
    host.notify('warn', t('fileOps.exists'));
    return true;
  }
  if (refusedName(e)) {
    host.notify('warn', t('fileOps.name.invalid'));
    return true;
  }
  return false;
}

/**
 * 링크를 고치지 않는 이름 바꾸기(링크가 없거나, "이름만 바꾸기"거나, 대소문자만 바뀌거나, 링크 의존성이 없을 때).
 * 열린 노트가 그 경로이거나 그 안에 있으면 먼저 저장하고 닫은 뒤 바꾸고, 새 경로에서 다시 연다. 바꿨으면 true.
 */
async function plainRename(
  ctx: CommandContext,
  path: string,
  to: string,
  isDir: boolean,
  moves: readonly Move[],
  done: string,
): Promise<boolean> {
  const { host } = ctx;
  const active = ctx.activePath();
  const wasOpen = active !== undefined && isUnder(active, path);
  if (wasOpen && !(await ctx.closeActive())) {
    host.notify('warn', t('fileOps.unsaved'));
    return false;
  }
  // 바꾸기 전에 뜬 목록(.json 과 폴더 속 파일까지): 샘플 후속 처리가 파일마다 본다(SP5 D14)
  const files = await filesBefore(host.fs, path, isDir);
  try {
    await host.fs.rename(path, to);
  } catch (e) {
    if (wasOpen) await ctx.openFile(active);
    if (reportRenameFailure(host, e)) return false;
    throw e;
  }
  renameEvents.emit(moves);
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => (settle = resolve));
  entryEvents.emit({ kind: 'renamed', from: path, to, isDir, files: movedFiles(files, path, to), settled });
  try {
    if (wasOpen) await ctx.openFile(to + active.slice(path.length));
  } finally {
    settle();
  }
  host.notify('info', done);
  return true;
}

/**
 * 이름 바꾸기 뒤 링크 고침의 결과를 알린다(D14 7). 실패가 있으면 노트마다 이유를 보이고, "다시 시도"를 고르는 동안
 * 실패한 노트만 지금 글에서 다시 고친다. 새 이름으로 쓸 수 없는 링크(unsafeName)와 이미 고쳤는지 알 수 없는 노트(ambiguous)는
 * 다시 해도 고쳐지지 않는다.
 */
async function reportLinkUpdates(
  ctx: CommandContext,
  plan: RenamePlan,
  first: RenameReport,
  journal: JournalStore,
  session: LinkSession,
): Promise<void> {
  const { host } = ctx;
  let report = first;
  for (;;) {
    if (report.failed.length === 0) {
      host.notify('info', t('links.rename.done', String(plan.linkCount), String(plan.notes.length)));
      return;
    }
    const message = t('links.rename.partial', failureLines(report.failed));
    const fixable = (f: RenameReport['failed'][number]) => f.reason !== 'unsafeName' && f.reason !== 'ambiguous';
    const unfixable = report.failed.filter((f) => !fixable(f));
    const retryable = report.failed.filter(fixable).map((f) => f.path);
    if (retryable.length === 0) {
      host.notify('warn', message);
      return;
    }
    if (!(await host.confirm(message, { confirmLabel: t('links.rename.retry') }))) return;
    const again = await rewritePlanned(ctx, plan, retryable, journal, session);
    report = { ...again, failed: [...again.failed, ...unfixable] };
  }
}

/** 링크 색인이 준비되기를 READY_WAIT_MS 까지 기다린다(D12 1). 준비됐으면 true. */
export async function waitForLinks(ctx: CommandContext, links: LinkDeps): Promise<boolean> {
  if (links.index.ready()) return true;
  ctx.host.notify('info', t('links.waiting'));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, READY_WAIT_MS);
  });
  try {
    await Promise.race([links.index.whenReady(), timeout]);
  } finally {
    clearTimeout(timer);
  }
  return links.index.ready();
}

/**
 * 파일이나 폴더의 이름을 바꾼다. 새 경로를 돌려준다(취소, 거절, 저장 실패면 undefined).
 * 열린 노트가 그 경로이거나 그 안에 있으면 먼저 저장하고 닫은 뒤 바꾸고, 새 경로에서 다시 연다.
 * 링크(SP4 D11, D12): 링크 색인이 준비되기를 기다리고(끝내 안 되면 아무것도 바꾸지 않는다), 바꿀 링크를 먼저 모두
 * 계산한다. 고칠 링크가 있으면 "링크 N개 고치기"와 "이름만 바꾸기"를 묻고(Esc 는 취소), 고치기면 기록을 남기며 바꾼다.
 */
export async function renameEntry(
  ctx: CommandContext,
  path: string,
  isDir: boolean,
  entries: readonly TreeEntry[],
): Promise<string | undefined> {
  // 이름 바꾸기는 한 번에 하나다(D14): 묻기부터 보고까지 링크 잠금을 쥔다. 색인을 기다리는 동안 시작한 두 번째
  // 이름 바꾸기가 첫 번째의 기록을 지우지 못하게 한다.
  const session = linkOps.claim();
  if (!session) {
    ctx.host.notify('warn', t('links.busy'));
    return undefined;
  }
  try {
    return await renameLocked(ctx, path, isDir, entries, session);
  } finally {
    session.release();
  }
}

async function renameLocked(
  ctx: CommandContext,
  path: string,
  isDir: boolean,
  entries: readonly TreeEntry[],
  session: LinkSession,
): Promise<string | undefined> {
  const { host } = ctx;
  const guard = await renameGuardOnDisk(host.fs, path, isDir, entries);
  if (guard) {
    host.notify('warn', t(GUARD_MESSAGE[guard]));
    return undefined;
  }
  const name = baseName(path);
  const ext = isDir ? '' : extensionOf(name);
  const input = await host.prompt({
    title: t('fileOps.rename'),
    prompt: t('fileOps.rename.prompt'),
    value: name.slice(0, name.length - ext.length),
    validate: (v) => nameProblem(stemOf(v, ext)),
  });
  if (input === undefined) return undefined;
  const stem = stemOf(input, ext);
  const problem = nameProblem(stem);
  if (problem) {
    host.notify('warn', problem);
    return undefined;
  }
  const to = joinPath(parentOf(path), stem + ext);
  if (to === path) return undefined;

  const finish = async (): Promise<string> => {
    // 폴더면 그 안에서 가장 긴 경로가 문제다
    const moved = [to, ...entries.filter((e) => lower(e.path).startsWith(`${lower(path)}/`)).map((e) => to + e.path.slice(path.length))];
    const longest = moved.reduce((a, b) => (b.length > a.length ? b : a));
    warnIfWindowsPathTooLong(host, ctx.vaultRoot, longest);
    if (!isDir) await moveTableCsvsAfterRename(host, path, to);
    ctx.refresh();
    return to;
  };

  // 대소문자만 바뀌면 모든 링크가 그대로 풀린다(D11). 링크 의존성이 없으면 예전처럼 링크를 고치지 않는다.
  const { links } = ctx;
  if (linkKey(to) === linkKey(path) || !links) {
    const treeMoves = movesFor(path, to, isDir, entries.filter((e) => !e.isDir).map((e) => e.path));
    const done = links ? t('fileOps.renamed') : t('fileOps.renamed.linksNotUpdated');
    return (await plainRename(ctx, path, to, isDir, treeMoves, done)) ? await finish() : undefined;
  }

  if (!(await waitForLinks(ctx, links))) {
    host.notify('warn', t('links.notReady'));
    return undefined;
  }
  // 열린 노트를 저장하고 그 버퍼를 색인에 곧바로 낸다(D12 2)
  const active = ctx.activePath();
  const handle = active !== undefined ? openNote(active) : undefined;
  if (handle && !(await handle.flush())) {
    host.notify('warn', t('fileOps.unsaved'));
    return undefined;
  }
  handle?.publishLinks();

  let plan: RenamePlan;
  try {
    plan = await planRename({
      from: path,
      to,
      isDir,
      index: links.index,
      images: links.images,
      read: (p) => host.fs.read(p),
      search: links.search,
      activePath: active,
    });
  } catch (e) {
    if (!(e instanceof IndexNotReadyError)) throw e;
    host.notify('warn', t('links.notReady'));
    return undefined;
  }

  // 색인이 준비된 채로 고칠 링크를 찾지 못했다: 묻지 않고 바꾼다
  if (plan.notes.length === 0) {
    return (await plainRename(ctx, path, to, isDir, plan.moves, t('fileOps.renamed'))) ? await finish() : undefined;
  }
  if (plan.hasWikiRewrites && hasUnlinkableChars(baseName(to))) {
    host.notify('warn', t('links.rename.badName'));
    return undefined;
  }
  const choice = await host.pick<'update' | 'skip'>(
    [
      { label: t('links.rename.update', String(plan.linkCount), String(plan.notes.length)), value: 'update' },
      { label: t('links.rename.skip'), value: 'skip' },
    ],
    { title: t('links.rename.title'), selected: 'update' },
  );
  if (choice === undefined) return undefined;
  if (choice === 'skip') {
    return (await plainRename(ctx, path, to, isDir, plan.moves, t('fileOps.renamed.linksNotUpdated'))) ? await finish() : undefined;
  }

  let report: RenameReport;
  try {
    report = await renameWithLinks(ctx, plan, links.journal, { session });
  } catch (e) {
    if (reportRenameFailure(host, e)) return undefined;
    throw e;
  }
  if (!report.renamed) {
    host.notify('warn', t('fileOps.unsaved'));
    return undefined;
  }
  const result = await finish();
  await reportLinkUpdates(ctx, plan, report, links.journal, session);
  return result;
}

/**
 * 이름을 바꾼 노트의 표 CSV(`<노트>_tableN.csv`)가 새 이름을 따라간다(플러그인 main.ts moveTableCsvsAfterRename, #60, A-R6).
 * 앱의 이름 바꾸기는 같은 폴더 안이다. 새 이름이 이미 있는 CSV 는 옛 이름에 남기고 이름을 대며 알린다.
 * 플러그인은 워크플로 노트만 보지만, 앱은 어느 .md 노트에서나 CSV 를 내보내므로 .md 면 모두 본다.
 */
async function moveTableCsvsAfterRename(host: CommandContext['host'], path: string, to: string): Promise<void> {
  if (!/\.md$/i.test(path) || !/\.md$/i.test(to)) return;
  const dir = parentOf(path);
  try {
    const { kept } = await moveTableCsvs(
      host,
      { from: dir, to: parentOf(to) },
      { from: baseName(path), to: baseName(to) },
      new Set(await host.fs.list(dir)),
    );
    if (kept.length > 0) {
      host.notify(
        'warn',
        host.t(
          'Kept {0} table CSV file(s) under the old name: {1}. A CSV of the new name was already there, holding another note\'s table, or the rename failed. Run "{2}" on this note to rewrite its CSVs and move the leftovers to the trash.',
          String(kept.length),
          kept.length > 3 ? host.t('{0} (+{1} more)', kept.slice(0, 3).join(', '), String(kept.length - 3)) : kept.join(', '),
          host.t('Export tables to CSV'),
        ),
      );
    }
  } catch (e) {
    console.warn('[labnoteo] could not move table CSVs after rename:', e);
  }
}

/** README 체크리스트에서 지운 워크플로 노트의 항목을 뺀다(물어본 뒤). 열린 README 는 버퍼에 들어간다. */
async function offerReadmeCleanup(ctx: CommandContext, workflowPath: string): Promise<void> {
  const { host } = ctx;
  const readmePath = joinPath(parentOf(workflowPath), README);
  if (!(await host.fs.exists(readmePath))) return;
  const fileName = baseName(workflowPath);
  if (!removeWorkflowFromReadme(await host.fs.read(readmePath), fileName).changed) return;
  if (!(await host.confirm(t('fileOps.readmeCleanup.confirm', fileName)))) return;
  await processNote(host.fs, readmePath, (text) => removeWorkflowFromReadme(text, fileName).content);
}

const deleteListeners = new Set<(path: string) => void>();

/** 앱에서 휴지통으로 옮긴 파일이나 폴더(뒤로·앞으로 가기 기록이 그 항목을 뺀다, SP4 Task 28). */
export const deleteEvents = {
  emit(path: string): void {
    [...deleteListeners].forEach((l) => l(path));
  },
  subscribe(fn: (path: string) => void): () => void {
    deleteListeners.add(fn);
    return () => void deleteListeners.delete(fn);
  },
};

/**
 * 파일이나 폴더를 휴지통으로 옮긴다. 옮겼으면 true. 위험한 확인(Enter 는 취소)을 먼저 묻는다.
 * 워크플로 노트를 지웠으면 README 체크리스트의 그 항목도 뺄지 묻는다.
 */
export async function deleteEntry(ctx: CommandContext, path: string, isDir: boolean): Promise<boolean> {
  const { host } = ctx;
  if (linkOps.running()) {
    host.notify('warn', t('links.busy'));
    return false;
  }
  const name = baseName(path);
  const ok = await host.confirm(t('fileOps.delete.confirm', name), {
    confirmLabel: t('fileOps.delete.confirmLabel'),
    destructive: true,
  });
  if (!ok) return false;
  const active = ctx.activePath();
  if (active !== undefined && isUnder(active, path) && !(await ctx.closeActive())) {
    host.notify('warn', t('fileOps.unsaved'));
    return false;
  }
  const files = await filesBefore(host.fs, path, isDir);
  await host.fs.trash(path);
  deleteEvents.emit(path);
  entryEvents.emit({ kind: 'deleted', path, isDir, files });
  host.notify('info', t('fileOps.deleted', name));
  if (!isDir && isValidWorkflowPath(path)) await offerReadmeCleanup(ctx, path);
  // 지운 노트의 표 CSV 를 휴지통으로 옮길지 묻는다(#75, A-R6). 폴더면 CSV 도 함께 갔다.
  if (!isDir && /\.md$/i.test(path)) await offerTableCsvCleanupOnDelete(host, [path]);
  ctx.refresh();
  return true;
}
