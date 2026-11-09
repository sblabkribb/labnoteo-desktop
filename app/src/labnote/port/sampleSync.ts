// Ported from app/vendor/labnoteo/src/main.ts:3165-3218 sha256:41b727ae4c4b393c
// labnoteO 0.138.0, Apache-2.0.
// Changes: App/LabnotePlugin → SampleEnv (D5); the plugin's private methods become functions over a per-session SampleSyncSession (timer map, aliasConflictsShown, the failure flag); window.setTimeout → setTimeout with the delay passed in; the sampleTrackingFor check moves to fire time (samples/sync.ts awaits samples.ready, D11), so scheduleSampleSync only filters *.labnote.md; vault.read → the caller passes the text (open buffer or fs.read); before saving, every Local and Global {Type}.json of the types in the text is checked with assertRegistryReadable (an empty file is fine, as in safeRegistryFs) and an unreadable one stops the run with one app warning per session (t('samples.syncFailed', path), D12/D13) instead of console.warn; the write goes through env.fs (safeRegistryFs), whose RegistryUnreadableError gets the same warning; plugin.settings.globalSampleFolder → env.globalFolder(); sampleSuggest.clearCache + refreshSampleViews → env.changed(touched registry files); syncSamples returns the touched paths.
import { maskAiCallouts } from '@labnoteo/core/lib/aiCallout';
import {
  extractSampleInfoFromText,
  isSameSampleFolder,
  noteLabsamplesFolder,
  saveSamplesFromDocument,
  type SampleAliasConflict,
} from '@labnoteo/core/lib/sampleStorage';
import { maskSampleListTables } from '@labnoteo/core/lib/sampleUtils';
import { t as appT } from '../../i18n/t';
import { assertRegistryReadable, RegistryUnreadableError, type SampleEnv } from '../../samples/env';
import { sampleListHeaders } from './sampleListTable';

/** The plugin's per-session sync state (its private fields). */
export interface SampleSyncSession {
  /** Path → pending timer (`sampleSyncTimers`). */
  readonly timers: Map<string, ReturnType<typeof setTimeout>>;
  /** `aliasConflictsShown`. */
  readonly aliasConflictsShown: Set<string>;
  /** samples.syncFailed was shown this session. */
  failureShown: boolean;
}

export function createSampleSyncSession(): SampleSyncSession {
  return { timers: new Map(), aliasConflictsShown: new Set(), failureShown: false };
}

/** Debounced write-through of a lab note's sample definitions. */
export function scheduleSampleSync(session: SampleSyncSession, path: string, fire: () => void, delayMs: number): void {
  if (!path.endsWith('.labnote.md')) return;
  const prev = session.timers.get(path);
  if (prev !== undefined) clearTimeout(prev);
  const handle = setTimeout(() => {
    session.timers.delete(path);
    fire();
  }, delayMs);
  session.timers.set(path, handle);
}

/** The registry files a sync of `content` reads or writes: `{folder}/{Type}.json` for the Local and the Global folder. */
export function sampleSyncTargets(env: SampleEnv, path: string, content: string): string[] {
  const headers = sampleListHeaders(env);
  const found = extractSampleInfoFromText(
    maskSampleListTables(maskAiCallouts(content), headers),
    env.settings().customSampleTypes,
  );
  const types = [...new Set(found.map((s) => s.type))];
  const global = env.globalFolder();
  const local = noteLabsamplesFolder(path, global);
  const folders = isSameSampleFolder(local, global) ? [local] : [local, global];
  return types.flatMap((type) => folders.map((folder) => `${folder}/${type}.json`));
}

function warnFailure(env: SampleEnv, session: SampleSyncSession, file: string): void {
  if (session.failureShown) return;
  session.failureShown = true;
  env.host.notify('warn', appT('samples.syncFailed', file));
}

/** Returns the registry files of the types in `content` (empty when nothing was synced). */
export async function syncSamples(env: SampleEnv, session: SampleSyncSession, path: string, content: string): Promise<string[]> {
  const touched = sampleSyncTargets(env, path, content);
  if (touched.length === 0) return touched;
  try {
    // A conflicted registry is read by core as `{}`: never save over one (D13). An empty file is fine.
    for (const file of touched) await assertRegistryReadable(env.fs, file);
    const conflicts = await saveSamplesFromDocument(
      env.fs,
      path,
      content,
      env.globalFolder(),
      env.settings().customSampleTypes,
      sampleListHeaders(env)
    );
    noticeAliasConflicts(env, session, conflicts);
    // Freshly-written definitions should show up in autocomplete, the highlight and the panel right away.
    env.changed(touched);
    return touched;
  } catch (err) {
    if (err instanceof RegistryUnreadableError) warnFailure(env, session, err.path);
    else console.warn('[labnoteo] sample sync failed:', err);
    return [];
  }
}

/**
 * Say once per session that notes define one sample with different aliases
 * (#481): the registry keeps the alias last changed in a definition, and the
 * other notes go on showing theirs.
 */
export function noticeAliasConflicts(env: SampleEnv, session: SampleSyncSession, conflicts: readonly SampleAliasConflict[]): void {
  for (const c of conflicts) {
    const aliases = [c.alias, ...c.others.map(([, a]) => a)].map(a => a.trim().toLowerCase()).sort();
    const key = `${c.type}|${c.id.toLowerCase()}|${aliases.join('|')}`;
    if (session.aliasConflictsShown.has(key)) continue;
    session.aliasConflictsShown.add(key);
    env.host.notify(
      'warn',
      env.t(
        '{0} is defined with different aliases: {1}. The sample keeps the alias of the definition changed last; use "Edit sample" to settle on one and fix the notes together.',
        c.id,
        [[c.source, c.alias] as const, ...c.others].map(([note, alias]) => `${alias} (${note})`).join(', ')
      )
    );
  }
}
