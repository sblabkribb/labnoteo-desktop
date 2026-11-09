// Ported from app/vendor/labnoteo/src/sampleSuggest.ts:146-213 sha256:ffe8c1689dc4d910
// labnoteO 0.140.2, Apache-2.0.
// Changes: returns rows instead of SuggestEntry; partbank branch removed (SP6 registers a SampleCandidateSource); plugin → SampleEnv. getSuggestions is split into existingRows (record merge, sort, existing/discarded split) and actionKinds (the create actions); the record loader and catalog check are injected (cached in samples/sources.ts); the trigger comes parsed in the SampleQuery, and the Local folder is the query note's (noteLabsamplesFolder(q.notePath), which equals plugin.localSampleFolder() for the active .md note).
import { buildSampleCompletionEntries, type SampleCandidate, type SampleTrigger } from '@labnoteo/core';
import { compareSamples, isCatalogSampleType, sampleSuggestActions } from '@labnoteo/core/lib/sampleUtils';
import { isSameSampleFolder, noteLabsamplesFolder, type SampleRecord } from '@labnoteo/core/lib/sampleStorage';
import type { SampleEnv } from '../../samples/env';
import type { SampleExistingRow, SampleQuery } from '../../samples/sources';

export async function existingRows(
  env: SampleEnv,
  q: SampleQuery,
  load: (folder: string, type: string) => Promise<Record<string, SampleRecord>>,
): Promise<SampleExistingRow[]> {
  const trigger = q.trigger;

  const globalFolder = env.globalFolder();
  const localFolder = noteLabsamplesFolder(q.notePath, globalFolder);

  const recordsByType: Record<string, SampleCandidate[]> = {};
  // A vault-root note's local folder is the global one: read it once.
  const readGlobal = Boolean(globalFolder) && !isSameSampleFolder(localFolder, globalFolder);
  // Outside an experiment the local folder is the global one, so its records are Global (#109).
  const localScope = readGlobal || !globalFolder ? 'local' : 'global';
  for (const type of trigger.typesToSearch) {
    const local = await load(localFolder, type);
    const global = readGlobal ? await load(globalFolder, type) : {};
    // Local definitions win over global on id collision.
    const merged: Record<string, { rec: SampleRecord; scope: 'local' | 'global' }> = {};
    for (const [id, rec] of Object.entries(global)) merged[id] = { rec, scope: 'global' };
    for (const [id, rec] of Object.entries(local)) merged[id] = { rec, scope: localScope };
    // One order for Local and Global, Local first on a tie (#410).
    recordsByType[type] = Object.entries(merged)
      .map(([id, { rec, scope }]) => ({
        id,
        alias: rec.alias,
        // The others are counted, so a sample with several is told apart (#462).
        description:
          rec.descriptions.length > 1 ? `${rec.descriptions[0]} (+${rec.descriptions.length - 1})` : rec.descriptions[0],
        scope,
        discarded: rec.discarded,
      }))
      .sort((a, b) => compareSamples(a, b) || (a.scope === b.scope ? 0 : a.scope === 'local' ? -1 : 1));
  }

  const entries = buildSampleCompletionEntries(trigger, recordsByType);
  const existing: SampleExistingRow[] = entries
    .filter((entry) => !entry.discarded)
    .map((entry) => ({ kind: 'existing', entry }));
  // A discarded sample comes after the create actions, so Enter on a lone
  // match makes a new ID rather than reusing a tube already thrown out (#330).
  const discarded: SampleExistingRow[] = entries
    .filter((entry) => entry.discarded)
    .map((entry) => ({ kind: 'existing', entry }));
  return [...existing, ...discarded];
}

/** The synthetic create actions for a trigger, in the plugin's order (catalog, generate, manual). */
export async function actionKinds(
  trigger: SampleTrigger,
  catalogExists: (type: string) => Promise<boolean>,
): Promise<Array<{ kind: 'catalog' | 'generate' | 'manual'; type: string }>> {
  // Append synthetic create actions for a concrete type (never for @sample);
  // this also guarantees a non-empty list so the popup shows even with no
  // existing samples — the root cause of "autocomplete does nothing".
  const actions: Array<{ kind: 'catalog' | 'generate' | 'manual'; type: string }> = [];
  if (trigger.typesToSearch.length === 1) {
    const type = trigger.typesToSearch[0];
    const catalogAvailable = isCatalogSampleType(type) ? await catalogExists(type) : false;
    const flags = sampleSuggestActions(trigger, { catalogAvailable });
    // A curated product is the preferred pick for catalog types, so it leads.
    if (flags.catalog) actions.push({ kind: 'catalog', type });
    if (flags.generate) actions.push({ kind: 'generate', type });
    if (flags.manual) actions.push({ kind: 'manual', type });
  }
  return actions;
}
