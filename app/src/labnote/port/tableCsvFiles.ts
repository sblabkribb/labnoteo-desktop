// Ported from app/vendor/labnoteo/src/commands.ts:1879-1909 sha256:7f9d7e1f2d3ac644
// labnoteO 0.140.2, Apache-2.0.
// Changes: App → host (Pick<AppHost, 'fs'>); app.vault.getFileByPath / fileManager.trashFile / vault.trash / adapter.trashSystem / adapter.trashLocal → host.fs.trash(path) (the Windows recycle bin; the app has no TFile index or "Deleted files" setting); posix from '@labnoteo/core/posix'.
import type { LabnoteHost } from '@labnoteo/core';
import * as posix from '@labnoteo/core/posix';
import type { AppHost } from '../host/createAppHost';

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
