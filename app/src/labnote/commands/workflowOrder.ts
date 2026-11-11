/**
 * 실험 탭과 Workflow 노트 머리 메뉴의 Workflow 순서 바꾸기: 위로·아래로(키, 끌어 놓기), 여기 뒤에 추가, 지우기(번호 당기기는 고를 때만).
 * - 순서는 파일 이름의 NNN 이다. 바뀌는 노트만 이름을 바꾼다(맞바꾸기 = 둘). 보관함의 모든 링크는 이름 바꾸기와 같은 링크 고침
 *   (planRename 의 후보, rewrite.ts)으로 한 번에 고친다: 옮기는 모든 노트를 한 맥락(rewriteContext)에 넣어, 번호를 맞바꿔도
 *   링크가 엇갈리지 않는다. 걸음마다 색인을 다시 기다리지 않는다.
 * - README 체크리스트는 이 파일이 직접 쓴다(링크 고침 후보에서 뺀다): 줄 묶음의 차례, 이름표의 NNN, 그리고 링크 대상을 한 번의
 *   processNote 로. 체크(상자), 앞붙이, 꼬리, CRLF 는 그대로다. 줄을 잃거나 겹치면 쓰기 전에 멈춘다.
 * - 폴더와 체크리스트가 맞지 않으면(workflowOrderPlan.readOrder) 아무것도 하지 않고 까닭과 「폴더와 Workflow 체크리스트 맞추기」
 *   단추를 알린다. 링크 잠금(linkOps)을 쥔 동안만 쓴다.
 * - 되돌리기: 여러 파일이라 Ctrl+Z 는 없다. 옮기기는 알림의 "되돌리기" 단추가 거꾸로 옮긴다. "마지막 이름 바꾸기 되돌리기"가
 *   이 일의 한 걸음만 되돌리지 않게, 그리고 앞의 기록이 이 일 뒤에 잘못 되돌리지 않게 고침 기록을 비운다.
 */
import * as posix from '@labnoteo/core/posix';
import { t } from '../../i18n/t';
import { candidates } from '../../links/planRename';
import { linkOps, renameEvents, type FailReason, reasonOf } from '../../links/renameWithLinks';
import { linkKey } from '../../links/resolve';
import { rewriteContext, rewriteLinksDetailed, type Move, type RewriteContext } from '../../links/rewrite';
import { NoteBusyError, NoteSaveError } from '../noteErrors';
import { openNote, processNote } from '../openNotes';
import { resolveReadmePath, samePath } from '../paths';
import { listFileNames, moveTableCsvs, offerTableCsvCleanupOnDelete } from '../port/tableCsvFiles';
import type { CommandContext, LinkDeps } from './context';
import { entryEvents, filesBefore, movedFiles } from './entryEvents';
import { deleteEvents, failureLines, waitForLinks } from './fileOps';
import { readmeStamp } from './stamp';
import { syncWorkflowChecklist } from './syncChecklist';
import { notifyWorkflowCreated, pickWorkflowAndAlias, readReadmeText, writeWorkflowFile } from './workflow';
import {
  checklistLines,
  insertChecklistLine,
  parseWfName,
  physicalSteps,
  planCloseGap,
  planInsert,
  planMove,
  readOrder,
  relabelChecklist,
  removeChecklistLine,
  reorderChecklist,
  TargetTakenError,
  type NameMove,
  type OrderItem,
  type Refusal,
} from './workflowOrderPlan';

/** 「폴더와 Workflow 체크리스트 맞추기」의 이름(지금 언어). */
const syncName = (host: CommandContext['host']) => host.t('Sync workflow checklist with folder');

/** 이 실험의 지금 상태: 폴더 이름들, README 경로와 글(열려 있으면 버퍼), 맞으면 번호 차례의 Workflow. */
async function readState(ctx: CommandContext, dir: string) {
  const names = await ctx.host.fs.list(dir);
  const readmePath = await resolveReadmePath(ctx.host.fs, dir);
  const readme = await readReadmeText(ctx, readmePath);
  return { names, readmePath, readme, order: readOrder(names, readme) };
}

const REASON_TEXT: Record<Refusal['reason'], (names: string) => string> = {
  noReadme: () => t('wfOrder.refuse.noReadme'),
  noSection: () => t('wfOrder.refuse.noSection'),
  unlisted: (n) => t('wfOrder.refuse.unlisted', n),
  missing: (n) => t('wfOrder.refuse.missing', n),
  duplicate: (n) => t('wfOrder.refuse.duplicate', n),
  sameNumber: (n) => t('wfOrder.refuse.sameNumber', n),
  staging: (n) => t('wfOrder.refuse.staging', n),
  order: () => t('wfOrder.refuse.order'),
  outside: (n) => t('wfOrder.refuse.outside', n),
};

/** 폴더와 체크리스트가 맞지 않는다: 까닭과 맞추기 단추를 알린다. */
function refuse(ctx: CommandContext, dir: string, refusal: Refusal): void {
  const { host } = ctx;
  const why = REASON_TEXT[refusal.reason](refusal.names.slice(0, 5).join(', '));
  host.notify('warn', t('wfOrder.refused', why, syncName(host)), {
    action: { label: syncName(host), run: () => void syncWorkflowChecklist(ctx, dir).catch((e) => console.error(e)) },
  });
}

/** 링크 잠금을 쥐고 `fn` 을 돈다. 다른 이름 바꾸기가 쥐고 있으면 알리고 undefined. */
async function withLinkLock<T>(ctx: CommandContext, fn: () => Promise<T>): Promise<T | undefined> {
  const session = linkOps.claim();
  if (!session) {
    ctx.host.notify('warn', t('links.busy'));
    return undefined;
  }
  try {
    return await fn();
  } finally {
    session.release();
  }
}

export interface RenumberResult {
  /** 링크를 고치지 못한 노트. */
  failed: { path: string; reason: FailReason }[];
}

/**
 * 한 실험 폴더 안의 Workflow 노트 이름들을 바꾸고(`moves`, 파일 이름), 보관함의 링크와 README 를 고친다. 링크 잠금 안에서 부른다.
 * `readmeEdit` 은 옛 이름 그대로의 README 글을 바꾼다(줄 차례, 이름표 NNN, 새 줄). 그 뒤 링크 대상을 고친다.
 * README 의 결과는 이름을 바꾸기 전에 한 번 미리 만들어 보고(`check`), 틀리면 아무것도 바꾸지 않고 던진다.
 * 돌려주는 값이 undefined 면 아무것도 바꾸지 않았다(알림은 했다).
 */
async function renumber(
  ctx: CommandContext,
  dir: string,
  state: { names: string[]; readmePath: string; readme: string | undefined },
  moves: readonly NameMove[],
  readmeEdit: (text: string) => string,
  check: (text: string) => boolean,
): Promise<RenumberResult | undefined> {
  const { host } = ctx;
  const links = ctx.links;
  const full = (name: string) => posix.join(dir, name);
  const pathMoves: Move[] = moves.map((m) => ({ from: full(m.from), to: full(m.to) }));
  let steps: NameMove[];
  try {
    steps = physicalSteps(moves, state.names);
  } catch (e) {
    if (!(e instanceof TargetTakenError)) throw e;
    host.notify('warn', t('wfOrder.targetTaken', e.names.join(', ')));
    return undefined;
  }

  // 링크 색인: 이름 바꾸기와 같이 준비되기를 기다린다. 열린 노트를 저장하고 그 버퍼를 색인에 낸다.
  let rctx: RewriteContext | undefined;
  let planned: { before: string; after: string }[] = [];
  const active = ctx.activePath();
  if (links) {
    if (!(await waitForLinks(ctx, links))) {
      host.notify('warn', t('links.notReady'));
      return undefined;
    }
    const handle = active !== undefined ? openNote(active) : undefined;
    if (handle && !(await handle.flush())) {
      host.notify('warn', t('fileOps.unsaved'));
      return undefined;
    }
    handle?.publishLinks();
    await links.index.settled();
    ({ rctx, planned } = await planLinks(ctx, links, dir, state, pathMoves));
  }
  const rewriteReadme = (text: string): string => {
    const edited = readmeEdit(text);
    return rctx ? rewriteLinksDetailed(edited, state.readmePath, state.readmePath, rctx).text : edited;
  };
  if (state.readme !== undefined && !check(rewriteReadme(state.readme))) throw new Error('the README checklist would lose or duplicate an entry');

  // 옮기는 노트가 열려 있으면 저장하고 닫는다(다시 연다)
  const moved = new Map(pathMoves.map((m) => [linkKey(m.from), m.to]));
  const reopen = active !== undefined ? moved.get(linkKey(active)) : undefined;
  if (reopen !== undefined && !(await ctx.closeActive())) {
    host.notify('warn', t('fileOps.unsaved'));
    return undefined;
  }

  let settle!: () => void;
  const settled = new Promise<void>((resolve) => (settle = resolve));
  const done: NameMove[] = [];
  try {
    try {
      for (const step of steps) {
        const from = full(step.from);
        const to = full(step.to);
        const files = await filesBefore(host.fs, from, false);
        await host.fs.rename(from, to);
        done.push(step);
        renameEvents.emit([{ from, to }]);
        entryEvents.emit({ kind: 'renamed', from, to, isDir: false, files: movedFiles(files, from, to), settled });
        await moveCsvs(ctx, dir, step);
      }
    } catch (e) {
      // 한 걸음이 실패했다: 한 걸음들을 거꾸로 되돌린다(링크와 README 는 아직 쓰지 않았다)
      for (const step of [...done].reverse()) {
        try {
          await host.fs.rename(full(step.to), full(step.from));
          renameEvents.emit([{ from: full(step.to), to: full(step.from) }]);
          entryEvents.emit({ kind: 'renamed', from: full(step.to), to: full(step.from), isDir: false, files: [{ from: full(step.to), to: full(step.from) }], settled });
          await moveCsvs(ctx, dir, { from: step.to, to: step.from });
        } catch (err) {
          console.error('[labnoteo] could not undo a Workflow rename:', err);
        }
      }
      if (reopen !== undefined && active !== undefined) await ctx.openFile(active);
      throw e;
    }

    const result: RenumberResult = { failed: [] };
    if (rctx) {
      for (const note of planned) {
        try {
          await processNote(host.fs, note.after, (text) => rewriteLinksDetailed(text, note.before, note.after, rctx!).text);
        } catch (e) {
          result.failed.push({ path: note.after, reason: reasonOf(e) });
        }
      }
    }
    if (state.readme !== undefined) {
      const stamp = readmeStamp(ctx.settings);
      try {
        await processNote(host.fs, state.readmePath, (text) => {
          const next = rewriteReadme(text);
          if (!check(next)) throw new Error('the README checklist would lose or duplicate an entry');
          return next === text ? text : stamp(next, state.readmePath);
        });
      } catch (e) {
        if (!(e instanceof NoteBusyError || e instanceof NoteSaveError)) throw e;
        result.failed.push({ path: state.readmePath, reason: reasonOf(e) });
      }
    }
    // 앞의 이름 바꾸기 기록은 이제 이 노트들의 옛 이름을 말한다: "마지막 이름 바꾸기 되돌리기"가 엇갈리게 되돌리지 않게 비운다
    if (links) await links.journal.clear();
    if (reopen !== undefined) await ctx.openFile(reopen);
    return result;
  } finally {
    settle();
    ctx.refresh();
  }
}

/** 이 일이 고칠 노트들(README 와 옮기는 노트 자신은 빼지 않는다: README 만 뺀다)과 그 맥락. */
async function planLinks(
  ctx: CommandContext,
  links: LinkDeps,
  dir: string,
  state: { names: string[]; readmePath: string },
  moves: readonly Move[],
): Promise<{ rctx: RewriteContext; planned: { before: string; after: string }[] }> {
  const all = new Map<string, string>();
  const add = (p: string) => {
    if (!all.has(linkKey(p))) all.set(linkKey(p), p);
  };
  links.index.files().forEach(add);
  (await links.images().catch(() => [] as string[])).forEach(add);
  state.names.forEach((n) => add(posix.join(dir, n)));
  const files = [...all.values()];
  const rctx = rewriteContext(files, moves);
  const sources = new Map<string, string>();
  for (const p of candidates(links.index, moves)) sources.set(linkKey(p), p);
  const active = ctx.activePath();
  if (active !== undefined && /\.md$/i.test(active)) sources.set(linkKey(active), active);
  const planned: { before: string; after: string }[] = [];
  for (const before of sources.values()) {
    if (samePath(before, state.readmePath)) continue;
    let raw: string;
    try {
      raw = await ctx.host.fs.read(before);
    } catch {
      continue; // 지워진 노트: 고칠 것이 없다
    }
    const after = rctx.moved(before) ?? before;
    const r = rewriteLinksDetailed(raw, before, after, rctx);
    if (r.changed > 0 || r.unsafe > 0) planned.push({ before, after });
  }
  return { rctx, planned };
}

/** 노트의 표 CSV(`<노트>_tableN.csv`)가 이름 한 걸음을 따라간다. 못 옮긴 것은 남기고 알리지 않는다(이름 바꾸기와 같다). */
async function moveCsvs(ctx: CommandContext, dir: string, step: NameMove): Promise<void> {
  try {
    await moveTableCsvs(ctx.host, { from: dir, to: dir }, { from: step.from, to: step.to }, new Set(await ctx.host.fs.list(dir)));
  } catch (e) {
    console.warn('[labnoteo] could not move table CSVs after a Workflow rename:', e);
  }
}

/** 링크를 고치지 못한 노트가 있으면 알린다. */
function reportFailures(ctx: CommandContext, result: RenumberResult): void {
  if (result.failed.length > 0) ctx.host.notify('warn', t('wfOrder.linksFailed', failureLines(result.failed)));
}

/** README 의 체크리스트 줄 이름들(소문자, 확장자 뗀 것), 차례대로. */
const entryKeys = (text: string): string[] => (checklistLines(text) ?? []).map((e) => e.name.toLowerCase().replace(/(\.labnote)?\.md$/, ''));
const stemOf = (name: string) => name.toLowerCase().replace(/(\.labnote)?\.md$/, '');

/** 이름 바꾸기 목록의 한 줄씩: `옛 이름 → 새 이름`. */
const moveLines = (moves: readonly NameMove[]) => moves.map((m) => `${m.from} → ${m.to}`).join('\n');

/** 그 Workflow 노트를 `target` 자리(0부터, 번호 차례)로, 또는 한 칸 위·아래로 옮긴다. 옮긴 뒤의 경로, 안 했으면 undefined. */
export async function moveWorkflow(ctx: CommandContext, path: string, target: 'up' | 'down' | number): Promise<string | undefined> {
  const dir = posix.dirname(path);
  return withLinkLock(ctx, async () => {
    const { host } = ctx;
    const state = await readState(ctx, dir);
    if (!state.order.ok) {
      refuse(ctx, dir, state.order.refusal);
      return undefined;
    }
    const items = state.order.items;
    const from = items.findIndex((w) => samePath(posix.join(dir, w.name), path));
    if (from < 0) return undefined;
    const to = target === 'up' ? from - 1 : target === 'down' ? from + 1 : target;
    if (to < 0 || to >= items.length || to === from) return undefined;
    const moves = planMove(items, from, to);
    if (moves.length === 0) return undefined;
    if (moves.length > 2) {
      const ok = await host.confirm(t('wfOrder.confirm', String(moves.length), moveLines(moves)), { confirmLabel: t('wfOrder.confirmLabel') });
      if (!ok) return undefined;
    }
    const order = items.map((w) => w.name);
    const [name] = order.splice(from, 1);
    order.splice(to, 0, name);
    const expected = order.map((n) => stemOf(moves.find((m) => m.from === n)?.to ?? n));
    const result = await renumber(
      ctx,
      dir,
      state,
      moves,
      (text) => relabelChecklist(reorderChecklist(text, order), moves),
      (text) => sameList(entryKeys(text), expected),
    );
    if (!result) return undefined;
    const newName = moves.find((m) => m.from === items[from].name)?.to ?? items[from].name;
    const newPath = posix.join(dir, newName);
    reportFailures(ctx, result);
    host.notify('info', t('wfOrder.moved', newName, String(to + 1)), {
      ms: 10000,
      action: { label: t('wfOrder.undo'), run: () => void moveWorkflow(ctx, newPath, from).catch((e) => console.error(e)) },
    });
    return newPath;
  });
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * "여기 뒤에 Workflow 추가": 카탈로그에서 고르고 별칭을 물은 뒤(닫으면 아무것도 바뀌지 않는다), 그 줄 다음 번호를 비우려고
 * 뒤 노트들의 번호를 하나씩 밀고(이름, 링크, README), 새 노트를 그 번호로 만들어 체크리스트의 그 줄 바로 뒤에 넣고 연다.
 */
export async function insertWorkflowAfter(ctx: CommandContext, path: string): Promise<string | undefined> {
  const dir = posix.dirname(path);
  const first = await readState(ctx, dir);
  if (!first.order.ok) {
    refuse(ctx, dir, first.order.refusal);
    return undefined;
  }
  // 뒤 노트 셋 이상의 번호가 바뀌면 고르기 전에 그 목록으로 묻는다(옮기기와 같다)
  const at = first.order.items.findIndex((w) => samePath(posix.join(dir, w.name), path));
  const preview = at < 0 ? [] : planInsert(first.order.items, at).moves;
  if (preview.length > 2) {
    const ok = await ctx.host.confirm(t('wfOrder.confirm', String(preview.length), moveLines(preview)), { confirmLabel: t('wfOrder.confirmLabel') });
    if (!ok) return undefined;
  }
  const picked = await pickWorkflowAndAlias(ctx, dir);
  if (!picked) return undefined;
  const created = await withLinkLock(ctx, async () => {
    const state = await readState(ctx, dir);
    if (!state.order.ok) {
      refuse(ctx, dir, state.order.refusal);
      return undefined;
    }
    const items = state.order.items;
    const after = items.findIndex((w) => samePath(posix.join(dir, w.name), path));
    if (after < 0) return undefined;
    const { seq, moves } = planInsert(items, after);
    if (moves.length > 0) {
      const expected = items.map((w) => stemOf(moves.find((m) => m.from === w.name)?.to ?? w.name));
      const result = await renumber(
        ctx,
        dir,
        state,
        moves,
        (text) => relabelChecklist(text, moves),
        (text) => sameList(entryKeys(text), expected),
      );
      if (!result) return undefined;
      reportFailures(ctx, result);
    }
    const anchor = moves.find((m) => m.from === items[after].name)?.to ?? items[after].name;
    const stamp = readmeStamp(ctx.settings);
    return writeWorkflowFile(ctx, dir, picked.chosen, picked.alias, {
      seq,
      register: async (readmePath, entry) => {
        if (!(await ctx.host.fs.exists(readmePath))) return 'noReadme';
        let had = false;
        await processNote(ctx.host.fs, readmePath, (text) => {
          had = checklistLines(text) !== undefined;
          const next = insertChecklistLine(text, anchor, { ...entry, seq });
          return next === text ? text : stamp(next, readmePath);
        });
        return had ? 'registered' : 'noSection';
      },
    });
  });
  if (!created) return undefined;
  await ctx.openFile(created.path);
  notifyWorkflowCreated(ctx, created);
  return created.path;
}

/**
 * "Workflow 삭제": 늘 묻는다(위험한 확인, Enter 는 취소). 이 노트를 가리키는 다른 노트가 있으면 그 목록을 함께 보인다.
 * OS 휴지통으로 옮기고 README 체크리스트에서 그 줄 하나만 뺀다. 뒤 Workflow 가 있고 폴더와 체크리스트가 맞으면 번호를
 * 당길지 따로 묻는다(기본은 그대로 두기).
 */
export async function deleteWorkflow(ctx: CommandContext, path: string): Promise<boolean> {
  const { host } = ctx;
  if (linkOps.running()) {
    host.notify('warn', t('links.busy'));
    return false;
  }
  const dir = posix.dirname(path);
  const name = posix.basename(path);
  const state = await readState(ctx, dir);
  const referrers = ctx.links
    ? [...new Set(ctx.links.index.backlinks(path).map((b) => b.source))].filter((s) => !samePath(s, state.readmePath) && !samePath(s, path))
    : [];
  const message = [
    t('wfOrder.delete.confirm', name),
    ...(referrers.length > 0 ? [t('wfOrder.delete.referrers', listFileNames(host, referrers))] : []),
  ].join('\n\n');
  const ok = await host.confirm(message, { title: t('wfOrder.delete'), confirmLabel: t('fileOps.delete.confirmLabel'), destructive: true });
  if (!ok) return false;
  const active = ctx.activePath();
  const wasOpen = active !== undefined && samePath(active, path);
  if (wasOpen && !(await ctx.closeActive())) {
    host.notify('warn', t('fileOps.unsaved'));
    return false;
  }
  const files = await filesBefore(host.fs, path, false);
  await host.fs.trash(path);
  deleteEvents.emit(path);
  entryEvents.emit({ kind: 'deleted', path, isDir: false, files });
  host.notify('info', t('fileOps.deleted', name));

  if (state.readme !== undefined) {
    const stamp = readmeStamp(ctx.settings);
    try {
      await processNote(host.fs, state.readmePath, (text) => {
        const next = removeChecklistLine(text, name);
        return next === text ? text : stamp(next, state.readmePath);
      });
    } catch (e) {
      if (!(e instanceof NoteBusyError || e instanceof NoteSaveError)) throw e;
      host.notify('warn', t('wfOrder.readmeNotUpdated', syncName(host)));
    }
  }
  await offerTableCsvCleanupOnDelete(host, [path]);
  ctx.refresh();
  // 지운 노트가 열려 있었으면 빈 편집기 대신 그 실험의 README 를 연다(번호 당기기를 묻는 동안에도 실험이 보인다)
  if (wasOpen && (await host.fs.exists(state.readmePath))) await ctx.openFile(state.readmePath);

  if (state.order.ok) await offerCloseGap(ctx, dir, state.order.items, name);
  return true;
}

/** 지운 노트 뒤의 번호를 당길지 묻고(기본은 그대로), 고르면 당긴다. */
async function offerCloseGap(ctx: CommandContext, dir: string, before: readonly OrderItem[], deleted: string): Promise<void> {
  const gone = before.find((w) => w.name === deleted);
  if (!gone) return;
  const preview = planCloseGap(
    before.filter((w) => w !== gone),
    gone.seq,
  );
  if (preview.length === 0) return;
  const answer = await ctx.host.choose<'keep' | 'close'>(t('wfOrder.gap.ask', String(preview.length), moveLines(preview)), [
    { label: t('wfOrder.gap.keep'), value: 'keep' },
    { label: t('wfOrder.gap.close'), value: 'close' },
  ]);
  if (answer !== 'close') return;
  await withLinkLock(ctx, async () => {
    const state = await readState(ctx, dir);
    if (!state.order.ok) {
      refuse(ctx, dir, state.order.refusal);
      return;
    }
    const items = state.order.items;
    const moves = planCloseGap(items, gone.seq);
    if (moves.length === 0) return;
    const expected = items.map((w) => stemOf(moves.find((m) => m.from === w.name)?.to ?? w.name));
    const result = await renumber(
      ctx,
      dir,
      state,
      moves,
      (text) => relabelChecklist(text, moves),
      (text) => sameList(entryKeys(text), expected),
    );
    if (!result) return;
    reportFailures(ctx, result);
    ctx.host.notify('info', t('wfOrder.gap.closed', String(moves.length)));
  });
}

/** 그 경로가 번호가 붙은 Workflow 노트 이름인가(메뉴가 항목을 보일지). */
export const isNumberedWorkflow = (path: string): boolean => parseWfName(posix.basename(path)) !== undefined;
