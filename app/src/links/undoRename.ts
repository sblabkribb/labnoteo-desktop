/**
 * Undo last rename and crash recovery (plan SP4 Task 25, decisions D15 and D16).
 * - **Undo** runs the inverse rename (`to -> from`) through `planRename` and `renameWithLinks`, so every link that now
 *   points at the new name goes back, including links written after the rename. A note that still holds exactly
 *   the text the rename wrote gets its recorded `before` text back; a note edited since gets only its links changed
 *   back and is listed. Nothing happens when something now has the original name.
 * - **Recovery** (once per vault, after the link index is ready) finishes a rename whose link updates were cut
 *   short: it asks, then re-plans from the journal's moves and rewrites only the notes not recorded `'ok'`.
 *   A plan whose rename never happened is cleared silently.
 */
import { parseRaw } from '../editor/documentIo';
import { ERROR_KINDS, hasErrorKind } from '../fs/errorKinds';
import { t } from '../i18n/t';
import type { CommandContext, LinkDeps } from '../labnote/commands/context';
import { failureLines, waitForLinks } from '../labnote/commands/fileOps';
import { openNote } from '../labnote/openNotes';
import { planFromJournal, type JournalNote, type JournalStore } from './journal';
import { IndexNotReadyError, planRename, type RenamePlan } from './planRename';
import { linkOps, renameWithLinks, rewritePlanned, type LinkSession } from './renameWithLinks';
import { linkKey } from './resolve';
import { applyMoves, invertMoves, type Move } from './rewrite';

/**
 * The files as they are after `moves`: the link index's files and the images, with the moves applied. Applying them
 * is a no-op on an index that already follows the rename, and catches up an index the watcher has not updated yet.
 */
async function afterUniverse(links: LinkDeps, moves: readonly Move[]): Promise<string[]> {
  let images: string[] = [];
  try {
    images = await links.images();
  } catch {
    // no images listed: notes still plan; image links are left as they are
  }
  const out = new Map<string, string>();
  for (const p of applyMoves([...links.index.files(), ...images], moves)) {
    const k = linkKey(p);
    if (!out.has(k)) out.set(k, p);
  }
  return [...out.values()];
}

/** Holds the link lock for `fn`; tells the user when another rename or link update holds it. */
async function withLinkLock<T>(ctx: CommandContext, fn: (session: LinkSession) => Promise<T>, quiet = false): Promise<T | undefined> {
  const session = linkOps.claim();
  if (!session) {
    if (!quiet) ctx.host.notify('warn', t('links.busy'));
    return undefined;
  }
  try {
    return await fn(session);
  } finally {
    session.release();
  }
}

/**
 * Undoes the last rename (D16). Returns the notes whose exact text came back (`restored`) and the notes edited since
 * the rename that only had their links changed back (`skipped`), both at their restored paths; undefined when
 * nothing was undone.
 */
export async function undoLastRename(
  ctx: CommandContext,
  journal: JournalStore,
): Promise<{ restored: string[]; skipped: string[] } | undefined> {
  return withLinkLock(ctx, async (session) => {
    const { host, links } = ctx;
    const j = await journal.load();
    if (!links || !j || j.header.status !== 'done' || !j.header.undoable) {
      host.notify('info', t('links.undo.none'));
      return undefined;
    }
    const { header } = j;
    if (await host.fs.exists(header.from)) {
      host.notify('warn', t('links.undo.blocked'));
      return undefined;
    }
    if (!(await waitForLinks(ctx, links))) {
      host.notify('warn', t('links.notReady'));
      return undefined;
    }
    // The open note is saved and its buffer published, as before any rename (D12 2).
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
        from: header.to,
        to: header.from,
        isDir: header.isDir,
        index: links.index,
        images: links.images,
        read: (p) => host.fs.read(p),
        search: links.search,
        activePath: active,
        files: await afterUniverse(links, header.moves),
      });
    } catch (e) {
      if (!(e instanceof IndexNotReadyError)) throw e;
      host.notify('warn', t('links.notReady'));
      return undefined;
    }

    // Journal paths are post-rename paths: the inverse plan's `before`. Reported paths are where the notes go back to.
    const recorded = j.notes.filter(
      (r): r is JournalNote & { before: string; after: string } => r.status === 'ok' && r.before !== undefined && r.after !== undefined,
    );
    const restore = new Map(recorded.map((r) => [r.path, { before: r.before, after: r.after }]));
    const back = (p: string) => applyMoves([p], invertMoves(header.moves))[0];

    let report;
    try {
      report = await renameWithLinks(ctx, plan, journal, { restore, session });
    } catch (e) {
      if (!hasErrorKind(e, ERROR_KINDS.exists)) throw e;
      host.notify('warn', t('links.undo.blocked'));
      return undefined;
    }
    if (!report.renamed) {
      host.notify('warn', t('fileOps.unsaved'));
      return undefined;
    }
    await journal.clear();
    ctx.refresh();

    const restored = report.restored ?? [];
    const restoredKeys = new Set(restored.map(linkKey));
    const updatedKeys = new Set(report.updated.map(linkKey));
    const skipped = recorded
      .map((r) => back(r.path))
      .filter((p) => updatedKeys.has(linkKey(p)) && !restoredKeys.has(linkKey(p)));
    if (skipped.length > 0) host.notify('warn', t('links.undo.skipped', skipped.join('\n')));
    else host.notify('info', t('links.undo.done'));
    if (report.failed.length > 0) host.notify('warn', t('links.rename.partial', failureLines(report.failed)));
    return { restored, skipped };
  });
}

/**
 * Finishes a rename whose link updates were cut short (D15, on vault open after the link index is ready).
 * A finished journal is kept for Undo; a plan whose rename never happened is cleared without asking.
 */
export async function recoverJournal(ctx: CommandContext, journal: JournalStore): Promise<void> {
  const { host, links } = ctx;
  if (!links) return;
  await withLinkLock(
    ctx,
    async (session) => {
      const j = await journal.load();
      if (!j || j.header.status === 'done') return;
      const { header } = j;
      if (header.status === 'planned') {
        const happened = (await host.fs.exists(header.to)) && !(await host.fs.exists(header.from));
        if (!happened) {
          await journal.clear();
          return;
        }
        await journal.setStatus('renamed');
      }

      // A 'writing' record whose note already holds its planned text was written: it becomes 'ok' with its texts,
      // so Undo can still restore it exactly. Everything else not 'ok' is re-planned.
      const pending: string[] = [];
      for (const [n, p] of header.planned.entries()) {
        const rec = j.notes.find((r) => r.n === n);
        if (rec?.status === 'ok') continue;
        if (rec?.status === 'writing' && rec.after !== undefined) {
          let current: string | undefined;
          try {
            current = parseRaw(rec.path, await host.fs.read(rec.path)).text;
          } catch {
            // unreadable now: re-planned below, which reports why
          }
          if (current === rec.after) {
            await journal.note({ ...rec, status: 'ok' });
            continue;
          }
        }
        pending.push(p.after);
      }
      if (pending.length === 0) {
        await journal.setStatus('done');
        return;
      }

      const ok = await host.confirm(t('links.recover.confirm', String(pending.length)), { confirmLabel: t('links.recover.finish') });
      if (!ok) {
        await journal.clear();
        host.notify('warn', t('fileOps.renamed.linksNotUpdated'));
        return;
      }
      const plan = planFromJournal({ ...j, header: { ...header, status: 'renamed' } }, await afterUniverse(links, header.moves));
      const report = await rewritePlanned(ctx, plan, pending, journal, session);
      await journal.setStatus('done');
      if (report.failed.length > 0) host.notify('warn', t('links.rename.partial', failureLines(report.failed)));
      else host.notify('info', t('links.recover.done'));
    },
    true,
  );
}
