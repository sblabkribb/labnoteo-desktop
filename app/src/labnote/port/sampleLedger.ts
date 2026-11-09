// Ported from app/vendor/labnoteo/src/main.ts:1101-1132 sha256:455f3dbd21259295
// Ported from app/vendor/labnoteo/src/main.ts:1403-1447 sha256:60bd9dfca906254a
// Ported from app/vendor/labnoteo/src/main.ts:1487-1506 sha256:f4d5b0f86ecc98f6
// Ported from app/vendor/labnoteo/src/main.ts:1539-1566 sha256:491a4a1fe0e0e491
// labnoteO 0.138.0, Apache-2.0.
// Changes: LabnotePlugin methods → functions taking SampleEnv (D5); TFile/TFolder arguments → their new paths (newPath, newFolder); plugin.t → env.t; this.host → env.host; this.fs → env.fs (safeRegistryFs over the recycle bin, D13); getSampleDisplayMeta(settings.customSampleTypes).types → env.types(); refreshSampleViews()/sampleSuggest.clearCache() → env.changed(paths); app.vault.read(file) → env.fs.read; vault.getAbstractFileByPath(p) (TFile or TFolder) and `file.path !== movedPath` → env.fs.exists; app.fileManager.renameFile → env.fs.rename (no links point at a registry JSON or a labsamples folder); waitForNoModal() removed: the caller (samples/followUps.ts) awaits the entry event's `settled`, which resolves after the rename flow and its link rewrite are done, so `settled` is always true here; this.unloaded removed (wireSampleFollowUps unsubscribes); readmeSyncHolds removed (the app has no README sync hold: renumber-workflows is DEFERRED and must call queueSampleSourceRenames itself after its hold, #149); the per-experiment queue sampleSourceRenames is module state; window.setTimeout → setTimeout; noticeSampleLedgerDeleted's plugin sentence (restore from Obsidian's .trash folder or the system trash) → appT('samples.registryDeletedRecycleBin'), which names the Recycle Bin: the app deletes to it, not to .trash.
import * as posix from '@labnoteo/core/posix';
import { getExperimentDir } from '@labnoteo/core/lib/labnoteStructure';
import { renameSampleSourcesInFolder } from '@labnoteo/core/lib/sampleStorage';
import { isCatalogSampleType } from '@labnoteo/core/lib/sampleUtils';
import type { SampleEnv } from '../../samples/env';
import { t as appT } from '../../i18n/t';

/** 실험마다 이어 붙이는 sources 이름 바꾸기(플러그인의 this.sampleSourceRenames). */
const sampleSourceRenames = new Map<string, Promise<void>>();

/**
 * A note was renamed within its folder in an experiment: the Local registry
 * lists it under the new name (#149). Renumbering holds the folder and
 * applies all its renames at once when it is done.
 */
export function renameLocalSampleSources(env: SampleEnv, oldPath: string, newPath: string): void {
  if (!newPath.endsWith('.md') || posix.dirname(newPath) !== posix.dirname(oldPath)) return;
  const dir = getExperimentDir(newPath);
  if (!dir) return;
  const from = posix.basename(oldPath);
  const to = posix.basename(newPath);
  if (from !== to) void queueSampleSourceRenames(env, dir, new Map([[from, to]]));
}

/**
 * Rename note names in `dir`'s Local registry, one write after another per
 * experiment so quick successive renames apply in event order.
 */
export function queueSampleSourceRenames(env: SampleEnv, dir: string, renames: ReadonlyMap<string, string>): Promise<void> {
  const folder = posix.join(dir, 'resources', 'labsamples');
  const types = env.types();
  const next = (sampleSourceRenames.get(dir) ?? Promise.resolve())
    .then(async () => {
      if ((await renameSampleSourcesInFolder(env.fs, folder, renames, types)) > 0) env.changed([folder]);
    })
    .catch((err) => console.error('Labnote: renaming sample sources failed', err));
  sampleSourceRenames.set(dir, next);
  void next.then(() => {
    if (sampleSourceRenames.get(dir) === next) sampleSourceRenames.delete(dir);
  });
  return next;
}

/**
 * A sample registry `{Type}.json` was renamed or moved away (#430): its
 * samples read as unregistered, and the next one added starts a new, empty
 * registry under the old name. Offer the name back.
 */
export async function offerSampleLedgerBack(env: SampleEnv, newPath: string, type: string, oldPath: string): Promise<void> {
  const movedPath = newPath;
  let count = 0;
  try {
    const parsed: unknown = JSON.parse(await env.fs.read(movedPath));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) count = Object.keys(parsed).length;
  } catch {
    // An unreadable registry still loses its name.
  }
  const parts = [
    env.t(
      '{0} was renamed to {1}: its {2} {3} sample(s) will show as unregistered, and the next {3} sample added starts a new, empty {0}.',
      oldPath,
      movedPath,
      String(count),
      type,
    ),
  ];
  if (
    isCatalogSampleType(type) &&
    posix.dirname(movedPath) === posix.dirname(oldPath) &&
    posix.basename(movedPath).startsWith(`${type}_`)
  ) {
    parts.push(env.t('Under this name it is read as a read-only product catalog.'));
  }
  const warning = parts.join(' ');
  if (!(await env.fs.exists(movedPath))) return;
  if (await env.fs.exists(oldPath)) {
    env.host.notify('warn', warning);
    return;
  }
  const ok = await env.host.confirm(`${warning} ${env.t('Rename it back to "{0}"?', oldPath)}`, {
    confirmLabel: env.t('Rename back'),
  });
  if (!ok || !(await env.fs.exists(movedPath)) || (await env.fs.exists(oldPath))) return;
  await env.fs.rename(movedPath, oldPath);
  env.changed([oldPath, movedPath]);
}

/**
 * A sample registry `{Type}.json` was deleted (#430): its samples read as
 * unregistered, and the next one added starts a new, empty registry. Not
 * when its whole folder went.
 */
export async function noticeSampleLedgerDeleted(env: SampleEnv, filePath: string, folder: string, type: string): Promise<void> {
  // A deleted folder reports its files first; give it a moment to go too.
  await new Promise((resolve) => setTimeout(resolve, 500));
  if (!(await env.fs.exists(folder))) return;
  if (await env.fs.exists(filePath)) return;
  // Plugin key: "The sample registry {0} was deleted: … Restore it from the trash (Obsidian's .trash folder or the system trash) before adding samples."
  env.host.notify('warn', appT('samples.registryDeletedRecycleBin', filePath, type));
}

/**
 * An experiment's `resources/labsamples` (or its `resources`) was renamed or
 * moved away (#338): every Local sample of the experiment reads as
 * unregistered without a word. Offer the old name back.
 */
export async function offerLabsamplesFolderBack(env: SampleEnv, newFolder: string, dir: string, oldPath: string): Promise<void> {
  const movedPath = newFolder;
  const warning = env.t(
    '"{0}" no longer has resources/labsamples: its Local samples will show as unregistered, and new ones go to a new, empty registry.',
    posix.basename(dir),
  );
  if (!(await env.fs.exists(movedPath))) return;
  const free = async (): Promise<boolean> =>
    (await env.fs.exists(dir)) && !(await env.fs.exists(oldPath)) && (await env.fs.exists(posix.dirname(oldPath)));
  if (!(await free())) {
    env.host.notify('warn', warning);
    return;
  }
  const ok = await env.host.confirm(`${warning} ${env.t('Rename it back to "{0}"?', oldPath)}`, {
    confirmLabel: env.t('Rename back'),
  });
  if (!ok || !(await env.fs.exists(movedPath)) || !(await free())) return;
  await env.fs.rename(movedPath, oldPath);
  env.changed([oldPath]);
}
