// Ported from app/vendor/labnoteo/src/sampleRelocation.ts:28-352 sha256:37e6bb8f92865dc5
// Ported from app/vendor/labnoteo/src/main.ts:2536-2566 sha256:ee3686f9fb5f8463
// labnoteO 0.138.0, Apache-2.0.
// Changes: SampleRelocationDeps { app, host, globalSampleFolder, customTypes, sampleListHeaders?, onSamplesChanged } → { env, sampleListHeaders } (D5): host → env.host, host.t → env.t, host.fs → env.fs (safeRegistryFs over the recycle bin, D13; a conflicted target registry makes putSampleRecord throw RegistryUnreadableError before anything for that sample is written, and an unreadable source registry loads as {} so nothing is planned from it), globalSampleFolder → env.globalFolder(), customTypes → env.settings().customSampleTypes, onSamplesChanged → env.changed(); readNote's vault.getFileByPath/cachedRead → env.fs.read (undefined when it cannot be read); notesInSampleScope(app, …) → notesInScope(env, …), which filters env.markdownFiles() as sampleScope.ts's notesInSampleScope does but skips a listed note that is gone (the link index can still list the moved note's old path right after the move); offerSamplesLeftBehind's vault.getFolderByPath(root).children → env.fs.list(root), a child being a folder when list() on it succeeds. offerLocalSamplesMoved: LabnotePlugin method → function over env with the per-(fromDir, toDir) batch map as module state (cancelPendingSampleMoves clears it when the follow-ups unsubscribe); this.sampleTrackingFor → env.trackingFor (the caller awaits samples.ready(newPath) first, D11); vault.getAbstractFileByPath(fromDir) → env.fs.exists, so the function is async; window.setTimeout/clearTimeout → setTimeout/clearTimeout with SAMPLE_MOVE_BATCH_MS; this.run → the caller's `run`; waitForNoModal() and this.unloaded removed: the caller (samples/followUps.ts) calls this only after the entry event's `settled`, so `ask` is always true, and its doc comment says "once the move has settled" for "once Obsidian's link-update prompt is gone".
import * as posix from '@labnoteo/core/posix';
import { getExperimentDir } from '@labnoteo/core/lib/labnoteStructure';
import {
  deleteSampleRecord,
  extractSampleInfoFromText,
  loadSamplesByType,
  planLocalSampleAdoption,
  putSampleRecord,
  removeSampleSource,
  sampleReferenceKey,
  sampleTypesInText,
  type SampleAdoption,
  type SampleDatabase,
} from '@labnoteo/core/lib/sampleStorage';
import { maskSampleListTables } from '@labnoteo/core/lib/sampleUtils';
import type { SampleEnv } from '../../samples/env';

/** Relocation offers are batched per (old, new) experiment pair for this long, as the plugin does. */
export const SAMPLE_MOVE_BATCH_MS = 1000;

export interface SampleRelocationDeps {
  env: SampleEnv;
  /** Headers of the sample list tables, whose rows are not a use (#385). */
  sampleListHeaders: string[][];
}

/** A note now in the target experiment, with the name it had before. */
export interface RelocatedNote {
  path: string;
  oldName: string;
}

/** One planned sample, merged across every note that uses it. */
interface PlannedAdoption extends SampleAdoption {
  fromDir: string;
  /** Old file names to drop from the old record's `sources` on a copy. */
  oldNames: string[];
  /** The old record's `sources`, before the plan rewrote them. */
  oldSources: string[];
}

const labsamplesOf = (experimentDir: string): string => posix.join(experimentDir, 'resources', 'labsamples');

/** Load the given `{Type}.json` registries of one folder. */
async function loadDatabase(env: SampleEnv, folder: string, types: readonly string[]): Promise<SampleDatabase> {
  const db: SampleDatabase = {};
  if (!folder) return db;
  for (const type of types) db[type] = await loadSamplesByType(env.fs, folder, type);
  return db;
}

/** A note's saved text. */
async function readNote(env: SampleEnv, path: string): Promise<string | undefined> {
  try {
    if (!(await env.fs.exists(path))) return undefined;
    return await env.fs.read(path);
  } catch {
    return undefined;
  }
}

/** The notes of `folder`'s experiment that can still be read (notesInSampleScope without the ones that are gone). */
async function notesInScope(env: SampleEnv, folder: string): Promise<Array<{ path: string; text: string }>> {
  const expDir = getExperimentDir(folder);
  const scopePrefix = expDir ? `${expDir}/` : undefined;
  const docs: Array<{ path: string; text: string }> = [];
  for (const path of await env.markdownFiles()) {
    if (scopePrefix && !path.startsWith(scopePrefix)) continue;
    const text = await readNote(env, path);
    if (text !== undefined) docs.push({ path, text });
  }
  return docs;
}

/** Plan what `notes` (now in `toDir`) need from `fromDir`'s Local registry. */
async function planFrom(
  deps: SampleRelocationDeps,
  fromDir: string,
  toDir: string,
  notes: readonly RelocatedNote[],
): Promise<PlannedAdoption[]> {
  const { env } = deps;
  const customTypes = env.settings().customSampleTypes;
  const texts: Array<{ note: RelocatedNote; text: string }> = [];
  for (const note of notes) {
    const text = await readNote(env, note.path);
    if (text !== undefined) texts.push({ note, text });
  }
  const types = [...new Set(texts.flatMap((t) => sampleTypesInText(t.text, customTypes)))];
  if (types.length === 0) return [];

  const fromFolder = labsamplesOf(fromDir);
  const from = await loadDatabase(env, fromFolder, types);
  if (Object.values(from).every((records) => Object.keys(records).length === 0)) return [];
  const to = await loadDatabase(env, labsamplesOf(toDir), types);
  const global = await loadDatabase(env, env.globalFolder(), types);

  // A row of a sample list table names a sample without using it (#385).
  const planNote = (text: string, newName: string, usedElsewhere: ReadonlySet<string>) =>
    planLocalSampleAdoption({
      noteText: maskSampleListTables(text, deps.sampleListHeaders),
      newName,
      from,
      to,
      global,
      usedElsewhere,
      additionalTypes: customTypes,
    });

  // Scanning the old experiment's notes is the costly part; skip it when no
  // note has anything to bring.
  if (texts.every(({ note, text }) => planNote(text, posix.basename(note.path), new Set()).length === 0)) {
    return [];
  }
  const usedElsewhere = new Set<string>();
  for (const doc of await notesInScope(env, fromFolder)) {
    for (const s of extractSampleInfoFromText(maskSampleListTables(doc.text, deps.sampleListHeaders), customTypes)) {
      usedElsewhere.add(sampleReferenceKey(s.type, s.id));
    }
  }

  const merged = new Map<string, PlannedAdoption>();
  for (const { note, text } of texts) {
    const planned = planNote(text, posix.basename(note.path), usedElsewhere);
    for (const a of planned) {
      const key = sampleReferenceKey(a.type, a.id);
      const prev = merged.get(key);
      if (prev) {
        prev.record.sources = [...new Set([...prev.record.sources, ...a.record.sources])];
        if (!prev.oldNames.includes(note.oldName)) prev.oldNames.push(note.oldName);
      } else {
        merged.set(key, {
          ...a,
          fromDir,
          oldNames: [note.oldName],
          oldSources: from[a.type]?.[a.id]?.sources ?? [],
        });
      }
    }
  }
  return [...merged.values()];
}

function describe(env: SampleEnv, a: PlannedAdoption): string {
  const label = a.record.alias ? `${a.id} (${a.record.alias})` : a.id;
  const from = posix.basename(a.fromDir);
  return `- ${label}: ${
    a.action === 'copy' ? env.t('copy from {0} (still used there)', from) : env.t('move from {0}', from)
  }`;
}

/** Which samples {@link apply} moved to Global, and which it copied since Global had the id. */
interface GlobalMoves {
  moved: string[];
  taken: string[];
}

/**
 * Bring `plan` into `toDir`. With `copiesToGlobal`, a sample the old
 * experiment still uses moves to Global instead of being copied, so both
 * experiments keep one record (#173); one Global already has is copied.
 */
async function apply(
  deps: SampleRelocationDeps,
  toDir: string,
  plan: readonly PlannedAdoption[],
  copiesToGlobal = false,
): Promise<GlobalMoves> {
  const { env } = deps;
  const toFolder = labsamplesOf(toDir);
  const global = env.globalFolder();
  const result: GlobalMoves = { moved: [], taken: [] };
  for (const a of plan) {
    const fromFolder = labsamplesOf(a.fromDir);
    if (a.action === 'copy' && copiesToGlobal && global) {
      if (!(await loadSamplesByType(env.fs, global, a.type))[a.id]) {
        const old = (await loadSamplesByType(env.fs, fromFolder, a.type))[a.id] ?? a.record;
        const sources = [...new Set([...old.sources.filter((s) => !a.oldNames.includes(s)), ...a.record.sources])];
        await putSampleRecord(env.fs, global, a.type, a.id, { ...old, sources });
        await deleteSampleRecord(env.fs, fromFolder, a.type, a.id);
        result.moved.push(a.id);
        continue;
      }
      result.taken.push(a.id);
    }
    await putSampleRecord(env.fs, toFolder, a.type, a.id, a.record);
    if (a.action === 'move') {
      await deleteSampleRecord(env.fs, fromFolder, a.type, a.id);
    } else {
      for (const name of a.oldNames) await removeSampleSource(env.fs, fromFolder, a.type, a.id, name);
    }
  }
  if (plan.length > 0) env.changed();
  return result;
}

/**
 * Ask, then re-plan from disk (it may have changed while asking) and apply.
 * When some samples would be copied (the old experiment still uses them), the
 * copies drift apart from then on, so the user may instead move those to
 * Global (#173).
 */
async function confirmAndApply(
  deps: SampleRelocationDeps,
  toDir: string,
  plan: readonly PlannedAdoption[],
  replan: () => Promise<PlannedAdoption[]>,
): Promise<number | undefined> {
  const { env } = deps;
  const { host } = env;
  const question = env.t(
    "Notes in {0} use {1} local sample(s) that are still in another experiment's registry, so the notes cannot find them. Bring them into {0}?",
    posix.basename(toDir),
    String(plan.length),
  );
  const copies = plan.filter((a) => a.action === 'copy');
  let copiesToGlobal = false;
  if (copies.length > 0 && env.globalFolder()) {
    const list = plan.map((a) => describe(env, a).replace(/^- /, '')).join('; ');
    const choice = await host.pick<'bring' | 'global' | 'cancel'>(
      [
        {
          label: env.t('Bring samples (copies are edited separately from now on)'),
          detail: list,
          value: 'bring',
        },
        {
          label: env.t('Move samples the other experiment still uses to Global, bring the rest'),
          detail: copies.map((a) => a.id).join(', '),
          value: 'global',
        },
        { label: env.t('Cancel'), value: 'cancel' },
      ],
      { placeholder: question },
    );
    if (!choice || choice === 'cancel') return undefined;
    copiesToGlobal = choice === 'global';
  } else {
    const ok = await host.confirm(`${question}\n\n${plan.map((a) => describe(env, a)).join('\n')}`, {
      confirmLabel: env.t('Bring samples'),
    });
    if (!ok) return undefined;
  }
  const wanted = new Set(plan.map((a) => `${a.fromDir}\u0000${sampleReferenceKey(a.type, a.id)}`));
  const fresh = (await replan()).filter((a) => wanted.has(`${a.fromDir}\u0000${sampleReferenceKey(a.type, a.id)}`));
  const { moved, taken } = await apply(deps, toDir, fresh, copiesToGlobal);
  if (moved.length > 0) host.notify('info', env.t('Moved to Global: {0}', moved.join(', ')));
  if (taken.length > 0) {
    host.notify('warn', env.t('Global already has {0}, so it was copied instead.', taken.join(', ')));
  }
  return fresh.length - moved.length;
}

/**
 * After notes moved from `fromDir` into `toDir`, offer to bring the Local
 * samples they use. With `ask` false (a prompt cannot be shown now) only say
 * how to bring them later. Returns how many were brought in.
 */
export async function offerSamplesAfterMove(
  deps: SampleRelocationDeps,
  fromDir: string,
  toDir: string,
  notes: readonly RelocatedNote[],
  ask = true,
): Promise<number> {
  const { env } = deps;
  const replan = () => planFrom(deps, fromDir, toDir, notes);
  const plan = await replan();
  if (plan.length === 0) return 0;
  const brought = ask ? await confirmAndApply(deps, toDir, plan, replan) : undefined;
  if (brought === undefined) {
    notifyLeftBehind(env, fromDir, toDir);
    return 0;
  }
  env.host.notify('info', env.t('Brought {0} local sample(s) into {1}.', String(brought), posix.basename(toDir)));
  return brought;
}

/** The samples stayed behind; say how to bring them later. */
function notifyLeftBehind(env: SampleEnv, fromDir: string, toDir: string): void {
  env.host.notify(
    'info',
    env.t(
      'The local samples stay in {0}. To bring them later, run "{1}" from a note in {2}.',
      posix.basename(fromDir),
      env.t('Sync workflow checklist with folder'),
      posix.basename(toDir),
    ),
  );
}

/** A folder is a path that list() accepts. */
async function isFolder(env: SampleEnv, path: string): Promise<boolean> {
  try {
    await env.fs.list(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * For "Sync workflow checklist with folder": find the Local samples the notes
 * in `toDir` use but that only another experiment registers, and offer to bring
 * them in. A sample found in more than one other experiment is reported, not
 * guessed, unless exactly one of them lists the note in its `sources`. Returns
 * how many were brought in.
 */
export async function offerSamplesLeftBehind(
  deps: SampleRelocationDeps,
  toDir: string,
  names: readonly string[],
): Promise<number> {
  const { env } = deps;
  const notes = names.map((name) => ({ path: posix.join(toDir, name), oldName: name }));
  const root = posix.dirname(toDir);
  if (!(await isFolder(env, root)) || notes.length === 0) return 0;
  const others: string[] = [];
  for (const child of await env.fs.list(root)) {
    const p = posix.join(root, child);
    if (p !== toDir && /^\d{3}_/.test(posix.basename(p)) && (await isFolder(env, p))) others.push(p);
  }

  const replan = async (): Promise<PlannedAdoption[]> => {
    const candidates = new Map<string, PlannedAdoption[]>();
    for (const dir of others) {
      for (const a of await planFrom(deps, dir, toDir, notes)) {
        const key = sampleReferenceKey(a.type, a.id);
        candidates.set(key, [...(candidates.get(key) ?? []), a]);
      }
    }
    const chosen: PlannedAdoption[] = [];
    ambiguous = [];
    for (const list of candidates.values()) {
      const listed = list.filter((a) => a.oldNames.some((name) => a.oldSources.includes(name)));
      if (list.length === 1) chosen.push(list[0]);
      else if (listed.length === 1) chosen.push(listed[0]);
      else ambiguous.push(list);
    }
    return chosen;
  };
  let ambiguous: PlannedAdoption[][] = [];

  const plan = await replan();
  if (ambiguous.length > 0) {
    env.host.notify(
      'warn',
      env.t(
        'These samples are registered in more than one other experiment, so they were not brought in: {0}',
        ambiguous.map((list) => `${list[0].id} (${list.map((a) => posix.basename(a.fromDir)).join(', ')})`).join('; '),
      ),
    );
  }
  if (plan.length === 0) return 0;
  return (await confirmAndApply(deps, toDir, plan, replan)) ?? 0;
}

/** The pending batches of offerLocalSamplesMoved (the plugin's this.samplesMoved). */
const samplesMoved = new Map<
  string,
  { fromDir: string; toDir: string; notes: RelocatedNote[]; timer: ReturnType<typeof setTimeout> }
>();

/** Drop every batch that has not fired yet (the follow-ups stopped listening). */
export function cancelPendingSampleMoves(): void {
  for (const pending of samplesMoved.values()) clearTimeout(pending.timer);
  samplesMoved.clear();
}

/**
 * A note moved into another experiment leaves the Local samples it used in
 * the old experiment's registry, where it can no longer find them (#97).
 * Once the move has settled, offer to bring them along,
 * once per (old, new) experiment pair for a batch of moves.
 */
export async function offerLocalSamplesMoved(
  env: SampleEnv,
  oldPath: string,
  newPath: string,
  sampleListHeaders: string[][],
  run: (job: () => Promise<void>) => void,
): Promise<void> {
  if (!env.trackingFor(newPath) || !/\.md$/i.test(newPath)) return;
  if (posix.basename(newPath) === 'README.labnote.md') return;
  const fromDir = getExperimentDir(oldPath);
  const toDir = getExperimentDir(newPath);
  if (!fromDir || !toDir || fromDir === toDir) return;
  // Renaming or moving a whole experiment folder renames every note in it;
  // by then its old folder no longer exists.
  if (!(await env.fs.exists(fromDir))) return;

  const key = `${fromDir}\u0000${toDir}`;
  const pending = samplesMoved.get(key);
  if (pending) clearTimeout(pending.timer);
  const notes = (pending?.notes ?? []).filter((n) => n.path !== oldPath);
  notes.push({ path: newPath, oldName: posix.basename(oldPath) });
  const timer = setTimeout(() => {
    samplesMoved.delete(key);
    run(async () => {
      await offerSamplesAfterMove({ env, sampleListHeaders }, fromDir, toDir, notes, true);
    });
  }, SAMPLE_MOVE_BATCH_MS);
  samplesMoved.set(key, { fromDir, toDir, notes, timer });
}
