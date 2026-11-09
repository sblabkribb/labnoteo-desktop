// Ported from app/vendor/labnoteo/src/sampleActions.ts:1031-1047 sha256:ffb375f9524c5bc9
// Ported from app/vendor/labnoteo/src/sampleActions.ts:1097-1278 sha256:63bb36a7721812f0
// Ported from app/vendor/labnoteo/src/sampleActions.ts:1321-1366 sha256:1d931e56b488573d
// labnoteO 0.140.2, Apache-2.0.
// Changes: App/LabnotePlugin → SampleEnv (D5); plugin.t → env.t; plugin.fs → env.fs; plugin.settings.globalSampleFolder → env.globalFolder(); plugin.settings.customSampleTypes → env.settings().customSampleTypes; usageSpotLabel takes the core Translator, as `translate`, since the app catalog test reads a bare one-letter t call as an app key. ScopedNote and notesInSampleScope (1259-1300) were ported ahead in sampleScope.ts (Task 14) and are re-exported here. otherExperimentsWithSample (1011-1027) comes here ahead of its edit range (Task 20), because notesForSample needs it. notesReferencingSample, notesUsingSample, notesForSample and heldNotesSentence are exported for the edit, delete and move ports.
import type { PickItem, Translator } from '@labnoteo/core';
import { compareSamples, getSampleDisplayMeta, isCatalogSampleType } from '@labnoteo/core/lib/sampleUtils';
import {
  findSampleUsages,
  findSampleUsageSpots,
  isSameSampleFolder,
  listExperimentSampleFolders,
  loadSamplesByType,
  noteLabsamplesFolder,
  noteLocalSampleFolder,
  type SampleRecord,
  type SampleUsageSpot,
} from '@labnoteo/core/lib/sampleStorage';
import { getExperimentDir } from '@labnoteo/core/lib/labnoteStructure';
import type { SampleEnv } from '../../samples/env';
import { sampleListHeaders } from './sampleListTable';
import { loadCatalogSamples, notesInSampleScope, type ScopedNote } from './sampleScope';

export { notesInSampleScope, type ScopedNote };

/**
 * The experiments other than `folder`'s whose Local registry also has `(type,
 * id)`: copies an import left behind, which an edit here does not reach (#173).
 */
export async function otherExperimentsWithSample(
  env: SampleEnv,
  folder: string,
  type: string,
  id: string,
): Promise<string[]> {
  const out: string[] = [];
  for (const other of await listExperimentSampleFolders(env.fs, '')) {
    if (isSameSampleFolder(other, folder) || isSameSampleFolder(other, env.globalFolder())) continue;
    if ((await loadSamplesByType(env.fs, other, type))[id]) out.push(getExperimentDir(other) ?? other);
  }
  return out;
}

/** A sample definition located in a JSON registry (or read-only catalog). */
export interface ResolvedSampleDefinition {
  scope: 'local' | 'global' | 'catalog';
  folder: string;
  record: SampleRecord;
  /** The catalog file a `catalog` record was read from (#431). */
  file?: string;
}

/**
 * Resolve a `(type, id)` reference to its definition record: local `{Type}.json`
 * first, then the vault-global one, then (for catalog types) the read-only
 * `{Type}_*.json` product catalog. Returns undefined when nothing matches.
 */
export async function resolveSampleDefinition(
  env: SampleEnv,
  opts: { type: string; id: string; docPath: string },
): Promise<ResolvedSampleDefinition | undefined> {
  const { type, id, docPath } = opts;
  const globalFolder = env.globalFolder();
  const localFolder = noteLocalSampleFolder(docPath, globalFolder);

  if (localFolder) {
    const localDb = await loadSamplesByType(env.fs, localFolder, type);
    if (localDb[id]) return { scope: 'local', folder: localFolder, record: localDb[id] };
  }

  if (globalFolder) {
    const globalDb = await loadSamplesByType(env.fs, globalFolder, type);
    if (globalDb[id]) return { scope: 'global', folder: globalFolder, record: globalDb[id] };
  }

  if (isCatalogSampleType(type)) {
    const fileOf: Record<string, string> = {};
    if (localFolder) {
      const localCat = await loadCatalogSamples(env, localFolder, type, fileOf);
      if (localCat[id]) return { scope: 'catalog', folder: localFolder, record: localCat[id], file: fileOf[id] };
    }
    if (globalFolder) {
      const globalCat = await loadCatalogSamples(env, globalFolder, type, fileOf);
      if (globalCat[id]) return { scope: 'catalog', folder: globalFolder, record: globalCat[id], file: fileOf[id] };
    }
  }

  return undefined;
}

/**
 * Every registered sample `docPath` can see, as `ID | alias | scope` picker
 * items for the `Open sample definition` command (#121): the note's Local
 * samples then the Global ones, or only the Global ones without a note.
 */
export async function listSampleDefinitions(
  env: SampleEnv,
  docPath: string | undefined,
): Promise<PickItem<{ type: string; id: string; resolved: ResolvedSampleDefinition }>[]> {
  const globalFolder = env.globalFolder();
  const local = docPath ? noteLabsamplesFolder(docPath, globalFolder) : undefined;
  const scopes: Array<{ scope: 'local' | 'global'; folder: string }> = [];
  if (local && !isSameSampleFolder(local, globalFolder)) scopes.push({ scope: 'local', folder: local });
  if (globalFolder) scopes.push({ scope: 'global', folder: globalFolder });

  const types = getSampleDisplayMeta(env.settings().customSampleTypes).types;
  const items: PickItem<{ type: string; id: string; resolved: ResolvedSampleDefinition }>[] = [];
  for (const { scope, folder } of scopes) {
    const alive: typeof items = [];
    const discarded: typeof items = [];
    for (const type of types) {
      const records = await loadSamplesByType(env.fs, folder, type);
      const ids = Object.keys(records).sort((a, b) =>
        compareSamples({ id: a, alias: records[a].alias }, { id: b, alias: records[b].alias }),
      );
      for (const [id, record] of ids.map((id) => [id, records[id]] as const)) {
        const where = scope === 'local' ? env.t('Local {0} sample', type) : env.t('Global {0} sample', type);
        const label = [id, record.alias ?? '-', where].join(' | ');
        // A discarded sample goes after the ones in use of its scope, dimmed (#448).
        (record.discarded ? discarded : alive).push({
          label: record.discarded ? `${label} ${env.t('(discarded)')}` : label,
          // Searched ahead of the description (#386).
          description: record.location ?? undefined,
          detail: record.descriptions?.length ? record.descriptions.join('; ') : undefined,
          dimmed: !!record.discarded,
          value: { type, id, resolved: { scope, folder, record } },
        });
      }
    }
    items.push(...alive, ...discarded);
  }
  return items;
}

/**
 * Collect the notes that still reference `(type, id)`, scoped to the sample's
 * experiment for a Local sample and to the whole vault for a Global one (its
 * folder is outside any experiment). Prefers the live editor text of an open
 * note so just-typed, unsaved references still count.
 */
export async function notesReferencingSample(
  env: SampleEnv,
  folder: string,
  type: string,
  id: string,
  opts: { maskSampleLists?: boolean } = {},
): Promise<string[]> {
  const { notes: docs } = await notesForSample(env, { folder, type, id });
  return findSampleUsages(docs, type, id, env.settings().customSampleTypes, {
    includeAiCallouts: true,
    sampleListHeaders: opts.maskSampleLists ? sampleListHeaders(env) : undefined,
  });
}

/**
 * The notes that use the sample `(type, id)` of `folder`, for "View usages"
 * and the MCP `get_sample` (#130, #131). Like {@link notesReferencingSample},
 * but a Global sample leaves out experiments with a Local record of the same
 * id, since their notes use that one (as {@link rewriteStaleAliases} does).
 * Deleting keeps the stricter check.
 */
export async function notesUsingSample(env: SampleEnv, folder: string, type: string, id: string): Promise<ScopedNote[]> {
  const { notes: docs } = await notesForSample(env, { folder, type, id });
  const paths = new Set(
    findSampleUsages(docs, type, id, env.settings().customSampleTypes, { sampleListHeaders: sampleListHeaders(env) }),
  );
  const using = docs.filter((doc) => paths.has(doc.path));
  if (getExperimentDir(folder)) return using;
  const shadowed = new Map<string, boolean>();
  const used: ScopedNote[] = [];
  for (const doc of using) {
    const local = noteLabsamplesFolder(doc.path, env.globalFolder());
    if (!isSameSampleFolder(local, folder)) {
      if (!shadowed.has(local)) {
        shadowed.set(local, Boolean((await loadSamplesByType(env.fs, local, type))[id]));
      }
      if (shadowed.get(local)) continue;
    }
    used.push(doc);
  }
  return used;
}

/** {@link notesUsingSample} as vault paths. */
export async function sampleUsages(env: SampleEnv, folder: string, type: string, id: string): Promise<string[]> {
  return (await notesUsingSample(env, folder, type, id)).map((doc) => doc.path);
}

/**
 * Each line of {@link notesUsingSample} that uses the sample, with its section
 * (#291). A note whose reference the line scan misses still gets one spot, at
 * its top, so the list never drops a note the path list has.
 */
export async function sampleUsageSpots(env: SampleEnv, folder: string, type: string, id: string): Promise<SampleUsageSpot[]> {
  return (await notesUsingSample(env, folder, type, id)).flatMap((doc) => {
    const spots = findSampleUsageSpots([doc], type, id, sampleListHeaders(env));
    return spots.length > 0 ? spots : [{ path: doc.path, line: 0, ch: 0, heading: '' }];
  });
}

/** Where in its note a usage is, for the usage list: the section and the 1-based line. */
export function usageSpotLabel(translate: Translator, spot: SampleUsageSpot): string {
  const line = String(spot.line + 1);
  return spot.heading ? translate('{0} · line {1}', spot.heading, line) : translate('Line {0}', line);
}

/**
 * The notes that may use sample `(type, id)` of `folder` (see
 * {@link notesInSampleScope}). For a Local sample these include the notes
 * outside every experiment, such as a daily note, whose own registry and the
 * Global one lack the ID, so it can only mean this sample (#423). With
 * `write`, those are `held` instead when another experiment's registry has
 * the same ID (#173): which one they mean is not known, so they are counted
 * but not changed.
 */
export async function notesForSample(
  env: SampleEnv,
  sample: { folder: string; type: string; id: string },
  opts: { write?: boolean } = {},
): Promise<{ notes: ScopedNote[]; held: ScopedNote[] }> {
  const { folder, type, id } = sample;
  if (!getExperimentDir(folder)) return { notes: await notesInSampleScope(env, folder), held: [] };
  const all = await notesInSampleScope(env, folder, { outsideExperiments: true });
  const globalFolder = env.globalFolder();
  const holds = new Map<string, boolean>();
  const has = async (registry: string): Promise<boolean> => {
    if (!holds.has(registry)) holds.set(registry, Boolean((await loadSamplesByType(env.fs, registry, type))[id]));
    return holds.get(registry)!;
  };
  const inside: ScopedNote[] = [];
  const outside: ScopedNote[] = [];
  for (const doc of all) {
    if (getExperimentDir(doc.path)) inside.push(doc);
    else if (!(await has(noteLabsamplesFolder(doc.path, globalFolder))) && !(globalFolder && (await has(globalFolder)))) {
      outside.push(doc);
    }
  }
  if (outside.length > 0 && opts.write && (await otherExperimentsWithSample(env, folder, type, id)).length > 0) {
    return { notes: inside, held: outside };
  }
  return { notes: [...inside, ...outside], held: [] };
}

/** The sentence for notes {@link notesForSample} held back from a change. */
export function heldNotesSentence(env: Pick<SampleEnv, 't'>, held: number): string {
  return env.t(
    'Another experiment has a sample with the same ID, so {0} note(s) outside experiments are left as they are.',
    String(held),
  );
}
