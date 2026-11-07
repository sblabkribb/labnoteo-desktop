/**
 * The rename executor (plan SP4 Task 24, decision D14): renames, then rewrites the planned notes one by one,
 * journalling each step outside the vault (D15).
 * - Nothing is written before `vault_rename` succeeds; a failed rename clears the journal and touches no note.
 * - Every note is rewritten from fresh text through `processNote` (one undo step in an open note, compare-and-swap
 *   on disk, never recreating a deleted note) with the pure, round-trip-checked `rewriteLinks`.
 * - One failure never stops the others: each is reported with its reason, and `rewritePlanned` retries them.
 * - A rename holds the single-flight link lock (`linkOps.claim`) from its readiness wait to its report; while it is
 *   held or links are written, `linkOps.running()` is true and commands, renames and deletes refuse (`links.busy`).
 *   A writer without the lock throws `LinkOpsBusyError`, so `journal.begin` never clears a live journal.
 */
import { parseRaw } from '../editor/documentIo';
import { ERROR_KINDS, hasErrorKind } from '../fs/errorKinds';
import { ModifyConflictError } from '../fs/tauriLabnoteFs';
import type { CommandContext } from '../labnote/commands/context';
import { NoteBusyError, NoteGoneError, NoteSaveError } from '../labnote/noteErrors';
import { processNote } from '../labnote/openNotes';
import type { JournalStore } from './journal';
import type { RenamePlan } from './planRename';
import { linkKey } from './resolve';
import { rewriteContext, rewriteLinks, type Move, type RewriteContext } from './rewrite';

export type FailReason = 'busy' | 'notSaved' | 'conflict' | 'gone' | 'unsafeName' | 'io';

export interface RenameReport {
  renamed: boolean;
  updated: string[];
  failed: { path: string; reason: FailReason }[];
  /** Updated notes whose recorded `before` text was written back exactly (Undo's fast path, D16). */
  restored?: string[];
}

/** How long a rename waits for the link index before it refuses (D12). */
export const READY_WAIT_MS = 30000;

let running = 0;
let holder: LinkSession | undefined;

/** Another rename (or link rewrite) holds the link lock: nothing was done. */
export class LinkOpsBusyError extends Error {
  constructor() {
    super('links are being updated');
    this.name = 'LinkOpsBusyError';
  }
}

/** The single-flight link lock a rename holds from its readiness wait to its report (D14). */
export interface LinkSession {
  release(): void;
}

/**
 * True while a rename holds the link lock or links are being rewritten: commands, renames and deletes refuse
 * meanwhile (D14). `claim` takes the lock (undefined when it is taken); only its holder may then write links.
 */
export const linkOps: { running(): boolean; claim(): LinkSession | undefined } = {
  running: () => running > 0 || holder !== undefined,
  claim() {
    if (linkOps.running()) return undefined;
    const session: LinkSession = {
      release: () => {
        if (holder === session) holder = undefined;
      },
    };
    holder = session;
    return session;
  },
};

/** Runs `fn` as the only link writer: refuses when another write runs or another session holds the lock. */
async function locked<T>(session: LinkSession | undefined, fn: () => Promise<T>): Promise<T> {
  if (running > 0 || (holder !== undefined && holder !== session)) throw new LinkOpsBusyError();
  running++;
  try {
    return await fn();
  } finally {
    running--;
  }
}

const renameListeners = new Set<(moves: readonly Move[]) => void>();

/** Every successful rename, with or without link updates (navigation history maps its entries through them). */
export const renameEvents = {
  emit(moves: readonly Move[]): void {
    [...renameListeners].forEach((l) => l(moves));
  },
  subscribe(fn: (moves: readonly Move[]) => void): () => void {
    renameListeners.add(fn);
    return () => void renameListeners.delete(fn);
  },
};

export function reasonOf(e: unknown): FailReason {
  if (e instanceof NoteBusyError) return 'busy';
  if (e instanceof NoteSaveError) return 'notSaved';
  if (e instanceof ModifyConflictError) return 'conflict';
  if (e instanceof NoteGoneError || hasErrorKind(e, ERROR_KINDS.notFound)) return 'gone';
  return 'io';
}

const lower = (p: string) => p.toLowerCase();
const isUnder = (p: string, base: string) => lower(p) === lower(base) || lower(p).startsWith(`${lower(base)}/`);

/** Rewrites the plan's notes with the given indices, journalling each one; never stops at a failure. */
async function writeNotes(
  ctx: CommandContext,
  plan: RenamePlan,
  indices: readonly number[],
  journal: JournalStore,
  restore?: ReadonlyMap<string, { before: string; after: string }>,
): Promise<RenameReport> {
  const rctx: RewriteContext = rewriteContext(plan.files, plan.moves);
  const report: RenameReport = { renamed: true, updated: [], failed: [], restored: [] };
  const backs = new Map([...(restore ?? [])].map(([p, v]) => [linkKey(p), v]));
  for (const n of indices) {
    const note = plan.notes[n];
    const path = note.after;
    const back = backs.get(linkKey(note.before));
    const rewrite = (text: string): { text: string; unsafe: number; restored: boolean } => {
      if (back && text === back.after) return { text: back.before, unsafe: 0, restored: true };
      const r = rewriteLinks(text, note.before, note.after, rctx);
      return { text: r.text, unsafe: r.unsafe, restored: false };
    };

    // The planned texts, from a fresh read (a failed read is reported by processNote below).
    let planned: { before?: string; after?: string } = {};
    try {
      const text = parseRaw(path, await ctx.host.fs.read(path)).text;
      planned = { before: text, after: rewrite(text).text };
    } catch {
      // processNote reads again and reports why
    }
    await journal.note({ n, path, ...planned, status: 'writing' });

    let last: { before: string; after: string; unsafe: number; restored: boolean } | undefined;
    try {
      await processNote(ctx.host.fs, path, (text) => {
        const r = rewrite(text);
        last = { before: text, after: r.text, unsafe: r.unsafe, restored: r.restored }; // the last call is the text that was written
        return r.text;
      });
    } catch (e) {
      const reason = reasonOf(e);
      report.failed.push({ path, reason });
      await journal.note({ n, path, ...planned, status: 'failed', reason });
      continue;
    }
    const texts = last ? { before: last.before, after: last.after } : {};
    if (last && last.unsafe > 0) {
      // the safe links in it were written; Retry cannot fix the others
      report.failed.push({ path, reason: 'unsafeName' });
      await journal.note({ n, path, ...texts, status: 'failed', reason: 'unsafeName' });
      continue;
    }
    report.updated.push(path);
    if (last?.restored) report.restored!.push(path);
    await journal.note({ n, path, ...texts, status: 'ok' });
  }
  return report;
}

/**
 * D14 steps 1-6: close the open note under the renamed path, journal the plan, rename, rewrite every planned note,
 * reopen and mark the journal done. A failed rename reopens the note, puts the previous journal back (or clears it)
 * and rethrows the error (nothing was written). `restore` (old path -> journal texts) writes the recorded `before` text back when the
 * note still holds exactly the recorded `after` (Undo, Task 25).
 */
export async function renameWithLinks(
  ctx: CommandContext,
  plan: RenamePlan,
  journal: JournalStore,
  opts: { restore?: ReadonlyMap<string, { before: string; after: string }>; session?: LinkSession } = {},
): Promise<RenameReport> {
  return locked(opts.session, async () => {
    const { host } = ctx;
    const active = ctx.activePath();
    const wasOpen = active !== undefined && isUnder(active, plan.from);
    if (wasOpen && !(await ctx.closeActive())) return { renamed: false, updated: [], failed: [] };

    // The previous rename's journal stays undoable if this one never renames (written back on failure).
    const previous = journal.current() ?? (await journal.load());
    await journal.begin({
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      from: plan.from,
      to: plan.to,
      isDir: plan.isDir,
      moves: plan.moves.map((m) => ({ ...m })),
      status: 'planned',
      planned: plan.notes.map((p) => ({ before: p.before, after: p.after })),
      undoable: true,
    });
    try {
      await host.fs.rename(plan.from, plan.to);
    } catch (e) {
      if (wasOpen) await ctx.openFile(active);
      if (previous) await journal.restore(previous);
      else await journal.clear();
      throw e;
    }
    // Announce before any further await: a watcher 'removed' for the old path must not reach the history first.
    renameEvents.emit(plan.moves);
    await journal.setStatus('renamed');

    const report = await writeNotes(ctx, plan, plan.notes.map((_, i) => i), journal, opts.restore);

    if (wasOpen) await ctx.openFile(plan.to + active.slice(plan.from.length));
    await journal.setStatus('done');
    return report;
  });
}

/** Rewrites only the planned notes at `paths` (their post-rename paths) from fresh text: Retry and recovery. */
export async function rewritePlanned(
  ctx: CommandContext,
  plan: RenamePlan,
  paths: readonly string[],
  journal: JournalStore,
  session?: LinkSession,
): Promise<RenameReport> {
  const wanted = new Set(paths.map(linkKey));
  const indices = plan.notes.flatMap((p, i) => (wanted.has(linkKey(p.after)) ? [i] : []));
  return locked(session, () => writeNotes(ctx, plan, indices, journal));
}
