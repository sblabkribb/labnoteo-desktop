// Ported from app/vendor/labnoteo/src/partbank/partbankCatalog.ts:34-245 sha256:757b45fc424e926f
// labnoteO 0.140.2, Apache-2.0.
// Changes: LabnotePlugin becomes (env, feature, store): downloadPartbankCatalog(env, feature, store) and knownCatalogIds(env, …) take a SampleEnv, the PartbankFeature and the app-data PartbankCatalogStore. The catalog is written with store.write(catalogFileName(type, kind), text) into app data (D13) instead of plugin.fs.write into the Global folder; the previous catalog is still read through env.fs (the D15 overlay) at the same virtual path, so knownCatalogIds is unchanged. plugin.partbank.defaultClient/notifyNotConfigured/notifyError(err, kind) → feature.defaultClient/notifyNotConfigured/notifyError(err, client); plugin.settings.globalSampleFolder → env.globalFolder(), and its missing-folder Notice ('Set the Global sample folder in the plugin settings before downloading a catalog.') → overrideOr('partbank.globalFolderFirst'), which names Sample settings; plugin.settings.customSampleTypes → env.settings().customSampleTypes; plugin.fs → env.fs; plugin.t → env.t; new Notice(m, ms) → env.host.notify('info', m); plugin.samplesChanged() → env.changed([the written virtual paths]). The persistent "Downloading…" Notice becomes withProgress(env.t('Downloading the partbank catalog…'), …, { cancellable: true }): Cancel (or a vault switch) gives up at once, the answer of a page still on its way is ignored, no further page is requested (listAll's onPage callback throws once a signal aborts), and nothing is written; a cancelled download shows no error. A vaultGuard() is taken at the start and guard.check() runs before each store.write (D11). Listing and sorting are split: the progress dialog lists every type first and closes, and only then are items sorted into sample types, because the app's dialogs queue and the strain-type question could not show while the progress dialog is up. The strain question is asked once, for the first strain, and its answer, yes or no, stands for the rest of the download (the vendor asked again for every strain after a no, against its own doc comment); resolveSampleType gets the guard. App only (real-server check, 2026-11-11): when the listing itself returned no item, the notice is the app key partbank.catalogEmptyWorkspace (the key owner's own workspace is empty; shared or public library items are not downloaded) instead of the vendor's 'partbank returned nothing to put in a catalog.', which read like a failure; the vendor sentence stays for items that were listed but none went into a catalog.
/**
 * Downloading a partbank workspace into read-only `{Type}_partbank-*.json`
 * catalogs beside the sample registry.
 *
 * A catalog is not the registry: nothing is written to it from a note, and
 * references to its ids seed local records on sync. That makes it safe to
 * rewrite the whole file on each download — as long as an item keeps the id it
 * had, which is what {@link planCatalogFile} is for. An id that changed would
 * orphan every reference already written in a note.
 *
 * In the app the files live in app data, not in the vault (D13); the sample
 * flows read them through the catalog overlay as if they were in the Global
 * folder (D15).
 *
 * (Unrelated to the `Update catalogs` command, which updates the bundled
 * *workflow* catalogs.)
 */
import {
  aliasForItem,
  descriptionForItem,
  sampleTypeForItem,
  sourceForItem,
  PARTBANK_TYPES,
  type PartbankItem,
  type PartbankType,
  type SampleSource,
} from '@labnoteo/core';
import { generateSampleId, getSampleDisplayMeta } from '@labnoteo/core/lib/sampleUtils';
import { loadSamplesByType, type SampleRecord } from '@labnoteo/core/lib/sampleStorage';
import * as posix from '@labnoteo/core/posix';
import { t } from '../../i18n/t';
import { NetError, type VaultGuard } from '../../integrations/netIpc';
import { withProgress } from '../../integrations/progressStore';
import type { PartbankCatalogStore } from '../../partbank/catalogOverlay';
import type { SampleEnv } from '../../samples/env';
import { overrideOr } from '../i18n';
import type { PartbankFeature } from './partbankFeature';
import { resolveSampleType, strainTypeOf } from './partbankRegister';
import { loadCatalogSamples } from './sampleScope';

/** `{Type}_partbank-web.json`: one file per sample type and connection. */
export function catalogFileName(type: string, connection: 'desktop' | 'web'): string {
  return `${type}_partbank-${connection}.json`;
}

/** An item with the labnoteo type it was sorted into. */
export interface TypedPartbankItem {
  item: PartbankItem;
  sampleType: string;
}

/**
 * The contents of one `{Type}_partbank-*.json`.
 *
 * Sorted by KID so a re-download produces a small diff, and keyed by the
 * id the item already had wherever one is known — a reference written in a
 * note months ago must keep resolving.
 */
export function planCatalogFile(
  sampleType: string,
  items: readonly PartbankItem[],
  connection: 'desktop' | 'web',
  origin: string,
  knownIds: ReadonlyMap<string, string>,
  newId: (type: string) => string = generateSampleId,
): Record<string, SampleRecord> {
  const sorted = [...items].sort((a, b) => (a.kid ?? a.id).localeCompare(b.kid ?? b.id, 'en'));
  // Two items may share a name; an unqualified alias would show the same label
  // twice in autocomplete, with no way to tell which is which.
  const nameCounts = new Map<string, number>();
  for (const item of sorted) {
    const alias = aliasForItem(item);
    if (alias) nameCounts.set(alias, (nameCounts.get(alias) ?? 0) + 1);
  }

  const out: Record<string, SampleRecord> = {};
  for (const item of sorted) {
    const source = sourceForItem(item, connection, origin);
    const id = knownIds.get(sourceKey(source)) ?? newId(sampleType);
    const plain = aliasForItem(item);
    out[id] = {
      type: sampleType,
      alias: aliasForItem(item, { disambiguate: Boolean(plain && nameCounts.get(plain)! > 1) }),
      descriptions: [descriptionForItem(item)].filter((d): d is string => Boolean(d)),
      sources: [],
      location: null,
      source,
    };
  }
  return out;
}

/** A link reduced to the fields that identify it, for a Map key. */
function sourceKey(source: SampleSource): string {
  const origin = source.connection === 'desktop' ? 'desktop' : source.origin.toLowerCase();
  return `${origin}\u0000${source.type}\u0000${source.id}`;
}

/**
 * The ids already standing for partbank items of `sampleType`: from the
 * catalog being replaced, and from the global registry, where an item
 * registered through the `@` search lives. Without the second one, an item
 * would get a different id in the catalog than the one a note already uses.
 */
export async function knownCatalogIds(
  env: SampleEnv,
  folder: string,
  sampleType: string,
  records: readonly Record<string, SampleRecord>[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const all = [await loadCatalogSamples(env, folder, sampleType), ...records];
  for (const set of all) {
    for (const [id, record] of Object.entries(set)) {
      if (record.source) out.set(sourceKey(record.source), id);
    }
  }
  return out;
}

/**
 * The partbank items a Global sample of a type other than `sampleType` already
 * stands for. A sample whose type was changed keeps its link (#301); an entry
 * in this type's catalog would give the item a second id.
 */
export function heldByOtherTypes(
  globalRecords: ReadonlyMap<string, Record<string, SampleRecord>>,
  sampleType: string,
): Set<string> {
  const out = new Set<string>();
  for (const [type, records] of globalRecords) {
    if (type === sampleType) continue;
    for (const record of Object.values(records)) if (record.source) out.add(sourceKey(record.source));
  }
  return out;
}

/** The {@link heldByOtherTypes} key of an item fetched over `client`. */
export function itemSourceKey(item: PartbankItem, connection: 'desktop' | 'web', origin: string): string {
  return sourceKey(sourceForItem(item, connection, origin));
}

/** What one download produced, per sample type. */
export type CatalogCounts = Map<string, number>;

const isCancelled = (err: unknown): boolean => err instanceof NetError && err.kind === 'cancelled';
const cancelled = () => new NetError('cancelled', 'cancelled');

/**
 * `work`, or a `cancelled` rejection as soon as one of `signals` aborts. The
 * partbank call in flight runs on in Rust (it has a 15 s timeout); its answer is
 * ignored. `work` must stop itself from starting further calls (see the onPage
 * check in downloadPartbankCatalog).
 */
function untilAborted<T>(signals: readonly AbortSignal[], work: Promise<T>): Promise<T> {
  if (signals.some((s) => s.aborted)) return Promise.reject(cancelled());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      done();
      reject(cancelled());
    };
    const done = () => signals.forEach((s) => s.removeEventListener('abort', onAbort));
    signals.forEach((s) => s.addEventListener('abort', onAbort));
    work.then(
      (v) => {
        done();
        resolve(v);
      },
      (e: unknown) => {
        done();
        reject(e);
      },
    );
  });
}

/**
 * Download every item in the key owner's own workspace and write it out as
 * catalogs. Items other people share with their groups are not included.
 */
export async function downloadPartbankCatalog(
  env: SampleEnv,
  feature: PartbankFeature,
  store: PartbankCatalogStore,
): Promise<void> {
  const client = feature.defaultClient();
  if (!client) {
    feature.notifyNotConfigured();
    return;
  }
  const folder = env.globalFolder();
  if (!folder) {
    // plugin: 'Set the Global sample folder in the plugin settings before downloading a catalog.'
    env.host.notify('info', overrideOr('partbank.globalFolderFirst'));
    return;
  }

  // The catalogs belong to the vault the download started in (D11).
  const guard = await client.vaultGuard();
  const listed = new Map<PartbankType, PartbankItem[]>();
  try {
    await withProgress(
      env.t('Downloading the partbank catalog…'),
      async (progress) => {
        const signals = [progress.signal, guard.signal];
        for (const partbankType of PARTBANK_TYPES) {
          // The page check stops listAll from asking for the next page once
          // cancelled; untilAborted stops the wait on the page in flight.
          const stopIfAborted = () => {
            if (signals.some((s) => s.aborted)) throw cancelled();
          };
          listed.set(partbankType, await untilAborted(signals, client.listAll(partbankType, stopIfAborted)));
        }
      },
      { cancellable: true },
    );
  } catch (err) {
    // Cancel, or a vault switch: the user knows, and nothing was written.
    if (isCancelled(err) || guard.signal.aborted) return;
    feature.notifyError(err, client);
    return;
  }

  if ([...listed.values()].every((items) => items.length === 0)) {
    // Not a failure: the account's own workspace has nothing in it (shared and public items are not downloaded).
    env.host.notify('info', t('partbank.catalogEmptyWorkspace'));
    return;
  }

  const byType = new Map<string, PartbankItem[]>();
  let skippedStrains = 0;
  const strainType = strainTypeAsker(env, guard);
  try {
    for (const partbankType of PARTBANK_TYPES) {
      for (const item of listed.get(partbankType) ?? []) {
        const sampleType = partbankType === 'strain' ? await strainType(item) : sampleTypeForItem(item);
        if (!sampleType) {
          if (partbankType === 'strain') skippedStrains++;
          continue;
        }
        const list = byType.get(sampleType) ?? [];
        list.push(item);
        byType.set(sampleType, list);
      }
    }

    const types = getSampleDisplayMeta(env.settings().customSampleTypes).types;
    const globalRecords = await loadGlobalRecords(env, folder, [...new Set([...types, ...byType.keys()])]);
    const counts: CatalogCounts = new Map();
    const written: string[] = [];
    try {
      for (const [sampleType, items] of byType) {
        const knownIds = await knownCatalogIds(env, folder, sampleType, [globalRecords.get(sampleType) ?? {}]);
        const elsewhere = heldByOtherTypes(globalRecords, sampleType);
        // An id this catalog already gave the item stays, so notes using it still resolve.
        const kept = items.filter((item) => {
          const key = itemSourceKey(item, client.kind, client.origin);
          return !elsewhere.has(key) || knownIds.has(key);
        });
        const records = planCatalogFile(sampleType, kept, client.kind, client.origin, knownIds);
        const name = catalogFileName(sampleType, client.kind);
        await guard.check();
        await store.write(name, `${JSON.stringify(records, null, 2)}\n`);
        written.push(posix.join(folder, name));
        counts.set(sampleType, Object.keys(records).length);
      }
    } finally {
      if (written.length > 0 && !guard.signal.aborted) env.changed(written);
    }
    env.host.notify('info', summarize(env, counts, skippedStrains));
  } catch (err) {
    if (isCancelled(err) || guard.signal.aborted) return;
    throw err;
  }
}

/**
 * The sample type for catalog strains. Asking about a strain type here would
 * interrupt a long download, so the question is asked once, for the first
 * strain; afterwards the answer stands.
 */
function strainTypeAsker(
  env: SampleEnv,
  guard: VaultGuard,
): (item: PartbankItem) => Promise<string | undefined> {
  let answer: Promise<string | undefined> | undefined;
  return (item) => {
    const existing = strainTypeOf(env);
    if (existing) return Promise.resolve(existing);
    // `resolveSampleType` asks, and adds the type when the answer is yes.
    answer ??= resolveSampleType(env, item, { guard });
    return answer;
  };
}

/** The global registry per type, read once for the id-stability lookup. */
async function loadGlobalRecords(
  env: SampleEnv,
  folder: string,
  types: readonly string[],
): Promise<Map<string, Record<string, SampleRecord>>> {
  const out = new Map<string, Record<string, SampleRecord>>();
  for (const type of types) out.set(type, await loadSamplesByType(env.fs, folder, type));
  return out;
}

function summarize(env: SampleEnv, counts: CatalogCounts, skippedStrains: number): string {
  if (counts.size === 0) return env.t('partbank returned nothing to put in a catalog.');
  const parts = [...counts]
    .sort((a, b) => a[0].localeCompare(b[0], 'en'))
    .map(([type, n]) => `${type} ${n}`)
    .join(', ');
  const main = env.t('Downloaded the partbank catalog: {0}.', parts);
  return skippedStrains > 0 ? `${main} ${env.t('{0} strain(s) were left out.', String(skippedStrains))}` : main;
}
