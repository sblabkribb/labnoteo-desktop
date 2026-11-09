// Ported from app/vendor/labnoteo/src/commands.ts:1842-1877 sha256:af4e49258e6c0fef
// Ported from app/vendor/labnoteo/src/commands.ts:1879-1909 sha256:7f9d7e1f2d3ac644
// Ported from app/vendor/labnoteo/src/commands.ts:1911-1948 sha256:d72da857647c6dde
// labnoteO 0.140.2, Apache-2.0.
// Changes: App → host (Pick<AppHost, 'fs'>; offerTableCsvCleanupOnDelete's app and host are one host); moveTableCsvs: app.vault.getFileByPath(...) instanceof TFile → host.fs.exists, fileManager.renameFile → host.fs.rename without link updates (A-R4); trashTableCsvs: app.vault.getFileByPath / fileManager.trashFile / vault.trash / adapter.trashSystem / adapter.trashLocal → host.fs.trash(path) (the Windows recycle bin; the app has no TFile index or "Deleted files" setting); posix from '@labnoteo/core/posix'.
import type { LabnoteHost } from '@labnoteo/core';
import { planTableCsvMoves, siblingTableCsvs, type WorkflowRename } from '@labnoteo/core/lib/workflowStructure';
import * as posix from '@labnoteo/core/posix';
import type { AppHost } from '../host/createAppHost';

/**
 * Move a workflow note's `<note>_tableN.csv` exports along with it (#60), so
 * they keep the note's name and number, from `dirs.from` to `dirs.to` (the
 * same folder for a rename, another one for a move, #206). `names` and
 * `toNames` are the two folders' current listings (base names; one set for a
 * rename) and are updated as files move. A CSV whose new name is taken, or
 * whose rename fails, stays put and counts as skipped.
 */
export async function moveTableCsvs(
  host: Pick<AppHost, 'fs'>,
  dirs: { from: string; to: string },
  note: WorkflowRename,
  names: Set<string>,
  toNames: Set<string> = names
): Promise<{ moved: number; skipped: number; kept: string[] }> {
  let moved = 0;
  const kept: string[] = [];
  if (dirs.from === dirs.to && note.from === note.to) return { moved, skipped: 0, kept };
  for (const csv of planTableCsvMoves(note.from, note.to, [...names])) {
    const path = posix.join(dirs.from, csv.from);
    if (!(await host.fs.exists(path)) || toNames.has(csv.to)) {
      kept.push(csv.from);
      continue;
    }
    try {
      await host.fs.rename(path, posix.join(dirs.to, csv.to));
      names.delete(csv.from);
      toNames.add(csv.to);
      moved++;
    } catch (err) {
      console.warn('[labnoteo] could not move table CSV:', err);
      kept.push(csv.from);
    }
  }
  return { moved, skipped: kept.length, kept };
}

/**
 * Move the table CSVs `names` (base names in `dir`) to the trash (#74, #75).
 * Returns how many stayed because the move failed.
 */
export async function trashTableCsvs(host: Pick<AppHost, 'fs'>, dir: string, names: readonly string[]): Promise<number> {
  let kept = 0;
  for (const name of names) {
    const path = posix.join(dir, name);
    try {
      await host.fs.trash(path);
    } catch (err) {
      console.warn('[labnoteo] could not trash table CSV:', err);
      kept++;
    }
  }
  return kept;
}

/** One file name per line, the first `max` of them and a count of the rest. */
export function listFileNames(host: Pick<LabnoteHost, 't'>, names: readonly string[], max = 10): string {
  const shown = names.slice(0, max).join('\n');
  return names.length > max ? host.t('{0} (+{1} more)', shown, String(names.length - max)) : shown;
}

/**
 * After workflow notes were deleted, offer to trash the table CSVs still named
 * after them (#75). A note that is back (e.g. restored by git) keeps its CSVs.
 */
export async function offerTableCsvCleanupOnDelete(
  host: Pick<AppHost, 'fs' | 't' | 'confirm' | 'notify'>,
  deletedPaths: readonly string[]
): Promise<void> {
  const byDir = new Map<string, string[]>();
  const listings = new Map<string, string[]>();
  for (const p of deletedPaths) {
    const dir = posix.dirname(p);
    const files = listings.get(dir) ?? (await host.fs.list(dir));
    listings.set(dir, files);
    const note = posix.basename(p);
    if (files.includes(note)) continue;
    const found = byDir.get(dir) ?? [];
    for (const csv of siblingTableCsvs(note, files)) if (!found.includes(csv)) found.push(csv);
    byDir.set(dir, found);
  }
  const all = [...byDir.values()].flat();
  if (all.length === 0) return;

  const ok = await host.confirm(
    host.t(
      'The table CSV files of the deleted note(s) are still in the folder. Move them to the trash?\n\n{0}',
      listFileNames(host, all)
    ),
    { confirmLabel: host.t('Move to trash'), destructive: true }
  );
  if (!ok) return;

  let kept = 0;
  for (const [dir, names] of byDir) kept += await trashTableCsvs(host, dir, names);
  host.notify('info', host.t('{0} CSV file(s) moved to the trash.', String(all.length - kept)));
  if (kept > 0) host.notify('warn', host.t('{0} CSV file(s) could not be moved to the trash.', String(kept)));
}
