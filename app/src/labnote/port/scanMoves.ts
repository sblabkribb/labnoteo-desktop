// Ported from app/vendor/labnoteo/src/barcode/barcodeFeature.ts:31-42 sha256:688d0cb02151a30c
// Ported from app/vendor/labnoteo/src/barcode/barcodeFeature.ts:362-405 sha256:58728a7a48a39166
// labnoteO 0.140.2, Apache-2.0.
// Changes: planScanMoves is verbatim. moveScansWithNote becomes a function over ScanMoveDeps instead of a
// BarcodeFeature method, taking the note's old and new paths (TFile becomes a path; app.vault.read becomes the
// editor-aware deps.fs.read; the TFolder children become deps.fs.list, which also covers a missing folder;
// createFolder is dropped because vault_rename creates the target's folders; fileManager.renameFile becomes
// deps.fs.rename). It is triggered by startScanMoves: entryEvents `renamed` after `settled`, for each `files` pair
// of a `*.labnote.md` whose getExperimentDir changed. A name already taken in the target is no longer left behind:
// it moves under the next free `_N` name (a rename refused with `exists` tries the next one). Obsidian's renameFile
// also fixed the links; here the note's own wikilinks and embeds that name a moved scan by its old vault path, or
// by its old name when the name changed, are pointed at the new vault path in one processNote write (an open
// note's buffer, refused while composing). A busy note is retried every BUSY_RETRY_MS up to BUSY_RETRIES; if it
// stays busy, the scans are moved back so no embed points at a missing file, and they count as stayed.
/**
 * Taking a note's scans (`images/scans/<labnote_id>_*`) along when the note
 * moves to another experiment, like its table CSVs.
 */
import { getExperimentDir } from '@labnoteo/core/lib/labnoteStructure';
import { readNoteId } from '@labnoteo/core/lib/noteId';
import type { LabnoteHost } from '@labnoteo/core';
import * as posix from '@labnoteo/core/posix';
import { ERROR_KINDS, hasErrorKind } from '../../fs/errorKinds';
import type { AppFs } from '../../fs/tauriLabnoteFs';
import { extractLinks } from '../../links/extract';
import { linkKey, splitLinktext } from '../../links/resolve';
import { entryEvents } from '../commands/entryEvents';
import { NoteBusyError } from '../noteErrors';
import { freeName, isScanOfNote, SCANS_SUBFOLDER } from './imageStore';
import { isBarcodeNote } from './noteIdService';
import { BUSY_RETRIES, BUSY_RETRY_MS } from './scanPipeline';

/**
 * Which of a note's scans (by name in the old experiment's scans folder) move
 * along to the new one, and which stay because the name is taken there.
 */
export function planScanMoves(
  names: readonly string[],
  noteId: string,
  takenInTarget: ReadonlySet<string>
): { move: string[]; keep: string[] } {
  const own = names.filter(n => isScanOfNote(n, noteId));
  return { move: own.filter(n => !takenInTarget.has(n)), keep: own.filter(n => takenInTarget.has(n)) };
}

export interface ScanMoveDeps {
  /** The editor-aware fs: `read` gives an open note's buffer. */
  fs: Pick<AppFs, 'read' | 'list' | 'rename'>;
  host: Pick<LabnoteHost, 'notify' | 't'>;
  /** Rewrites a note once; refuses a busy or composing open note with NoteBusyError and writes nothing. */
  processNote(path: string, fn: (text: string) => string): Promise<boolean>;
  /** Runs the work a rename starts; failures become notices (idWatch notifyingRun). */
  run(fn: () => Promise<unknown>): void;
  /** Called after scan images moved (the editor's image-name index is stale). */
  imagesMoved?(): void;
  wait?(ms: number): Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const isBusy = (e: unknown): boolean => e instanceof NoteBusyError || (e instanceof Error && e.name === 'NoteBusyError');

/** The experiment a note lives in, or its folder when it is outside one (the plugin's fallback). */
const experimentOf = (notePath: string): string => getExperimentDir(notePath) ?? posix.dirname(notePath);

/**
 * Points the note's wikilinks and embeds at the moved scans: a link by the old vault path, or by the old name
 * when the name changed, gets the new vault path. A name-only link to an unchanged name still finds the file.
 */
function pointLinksAt(moves: ReadonlyArray<{ from: string; to: string }>): (text: string) => string {
  const byPath = new Map(moves.map((m) => [linkKey(m.from), m]));
  const byName = new Map(moves.map((m) => [linkKey(posix.basename(m.from)), m]));
  return (text) => {
    const edits: Array<{ from: number; to: number; insert: string }> = [];
    for (const link of extractLinks(text)) {
      if (link.kind !== 'wiki' && link.kind !== 'embed') continue;
      const path = splitLinktext(link.target).path;
      const exact = byPath.get(linkKey(path));
      const named = path.includes('/') ? undefined : byName.get(linkKey(path));
      const move = exact ?? named;
      if (!move) continue;
      if (!exact && posix.basename(move.from) === posix.basename(move.to)) continue;
      edits.push({ from: link.pathFrom, to: link.pathTo, insert: move.to });
    }
    let out = text;
    for (const e of edits.sort((a, b) => b.from - a.from)) out = out.slice(0, e.from) + e.insert + out.slice(e.to);
    return out;
  };
}

async function listNames(deps: ScanMoveDeps, dir: string): Promise<string[]> {
  try {
    return await deps.fs.list(dir);
  } catch {
    return [];
  }
}

/** Renames `from` into `dir` under `name`, or the next free `_N` name when the target refuses with `exists`. */
async function renameFree(
  deps: ScanMoveDeps,
  from: string,
  dir: string,
  name: string,
  taken: Set<string>,
): Promise<string> {
  for (;;) {
    const free = freeName(name, (c) => taken.has(c.toLowerCase()));
    taken.add(free.toLowerCase());
    const to = posix.join(dir, free);
    try {
      await deps.fs.rename(from, to);
      return to;
    } catch (err) {
      if (!hasErrorKind(err, ERROR_KINDS.exists)) throw err;
    }
  }
}

/**
 * A workflow note moved from `from` to `to`: when its experiment changed, move its scans
 * (`images/scans/<labnote_id>_*`) along, like its table CSVs.
 */
export async function moveScansWithNote(deps: ScanMoveDeps, from: string, to: string): Promise<void> {
  const { host } = deps;
  const fromExp = experimentOf(from);
  const toExp = experimentOf(to);
  if (fromExp === toExp) return;
  let text: string;
  try {
    text = await deps.fs.read(to);
  } catch {
    return; // gone again
  }
  const noteId = readNoteId(text);
  if (!noteId) return;
  const sourceDir = posix.join(fromExp, SCANS_SUBFOLDER);
  const targetDir = posix.join(toExp, SCANS_SUBFOLDER);
  const targetNames = await listNames(deps, targetDir);
  const { move, keep } = planScanMoves(await listNames(deps, sourceDir), noteId, new Set(targetNames));
  if (move.length === 0 && keep.length === 0) return;

  const taken = new Set(targetNames.map((n) => n.toLowerCase()));
  const moved: Array<{ from: string; to: string }> = [];
  let failed = 0;
  // The free names first, then the taken ones under `_N` names, so a free name is never taken by a renamed one.
  for (const name of [...move, ...keep]) {
    const source = posix.join(sourceDir, name);
    try {
      moved.push({ from: source, to: await renameFree(deps, source, targetDir, name, taken) });
    } catch (err) {
      console.warn('[labnoteo] could not move scan', name, err);
      failed++;
    }
  }
  if (moved.length > 0) deps.imagesMoved?.();

  const rewrite = pointLinksAt(moved);
  let current = text;
  try {
    current = await deps.fs.read(to);
  } catch {
    // the note went away meanwhile: nothing to point
  }
  if (moved.length > 0 && rewrite(current) !== current) {
    const wait = deps.wait ?? sleep;
    for (let attempt = 0; ; attempt++) {
      try {
        await deps.processNote(to, rewrite);
        break;
      } catch (err) {
        if (isBusy(err) && attempt < BUSY_RETRIES) {
          await wait(BUSY_RETRY_MS);
          continue;
        }
        if (!isBusy(err)) throw err;
        // Still busy: nothing was written, so the scans go back where the note's links expect them.
        for (const m of moved.splice(0).reverse()) {
          try {
            await deps.fs.rename(m.to, m.from);
          } catch (back) {
            console.warn('[labnoteo] could not move scan back', m.to, back);
          }
          failed++;
        }
        deps.imagesMoved?.();
        break;
      }
    }
  }

  if (moved.length > 0) host.notify('info', host.t('Moved {0} scan image(s) to {1} with the note.', String(moved.length), targetDir));
  if (failed > 0) {
    host.notify(
      'warn',
      host.t('{0} scan image(s) stayed in {1}: a file with the same name is already in {2}, or the move failed.', String(failed), sourceDir, targetDir),
    );
  }
}

/**
 * Follows the app's renames: after a rename settles, each `*.labnote.md` it moved to another experiment takes its
 * scans along, one note at a time. The returned function stops listening.
 */
export function startScanMoves(deps: ScanMoveDeps): () => void {
  let live = true;
  let chain: Promise<unknown> = Promise.resolve();
  const off = entryEvents.subscribe((e) => {
    if (!live || e.kind !== 'renamed') return;
    const notes = e.files.filter((f) => isBarcodeNote(f.to) && experimentOf(f.from) !== experimentOf(f.to));
    if (notes.length === 0) return;
    deps.run(() => {
      const job = chain.then(async () => {
        await e.settled.catch(() => undefined);
        for (const f of notes) {
          if (!live) return;
          await moveScansWithNote(deps, f.from, f.to);
        }
      });
      chain = job.catch(() => undefined);
      return job;
    });
  });
  return () => {
    live = false;
    off();
  };
}
