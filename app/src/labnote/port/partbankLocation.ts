// Ported from app/vendor/labnoteo/src/partbank/partbankLocation.ts:33-312 sha256:224c1c106a48a2ef
// labnoteO 0.140.2, Apache-2.0.
// Changes: LabnotePlugin becomes SampleEnv plus PartbankFeature: locationRefreshNotice, vaultSampleFolders, linkedSamplesIn, applyLocationChanges, describeChange and registryName take env, and refreshOneLocation and refreshLocationsIn take (env, feature, …). plugin.t → env.t; plugin.fs → env.fs; plugin.settings.globalSampleFolder → env.globalFolder(); plugin.settings.customSampleTypes → env.settings().customSampleTypes; vaultSampleFolders still walks the vault through core listExperimentSampleFolders over env.fs (fs.list and fs.exists), not env.markdownFiles(), so an experiment registry with no note open is found as in the plugin; new Notice(m) → env.host.notify('info', m); plugin.partbank.notifyError(err, kind) → feature.notifyError(err, client), and a cancelled lookup (NetError 'cancelled') shows nothing; plugin.samplesChanged() → env.changed([the written registry files]); confirmModal(app, message, label) → env.host.confirm(message, { confirmLabel: env.t('Store') }); pickManyModal(app, items, { title }) → env.host.pickMany(items, { title }). The single sample in the args is exported as PartbankSampleRef. The persistent "Reading storage locations…" Notice becomes withProgress(env.t('Reading storage locations from partbank…'), …, { cancellable: true }) with one progress line per sample (its label and the change, or the error sentence); Cancel (or a vault switch) gives up at once, the answer of a lookup still on its way is ignored, no further sample is asked for, nothing is offered or written and no notice is shown. A 429 still stops the run and the results gathered so far are still offered, but the samples it left unread (the refused one included) are now counted with the ones that could not be read, so the closing notice says how many were not refreshed. A vaultGuard() is taken at the start of both refreshes (D11): guard.check() runs before applyLocationChanges writes (which takes the guard and checks before each record), and a vault that changed in the meantime writes nothing.
/**
 * Reading storage locations back from partbank.
 *
 * Deliberately *not* resolved while drawing: the sample tree, search, the
 * definition dialog, the sample table and the MCP tools all read
 * `record.location`, so a refresh writes there instead. That keeps every one
 * of them working unchanged, keeps the last known location readable offline,
 * and keeps the drawing code from firing a request per row.
 */
import {
  formatStockLocation,
  LocalSampleLocationProvider,
  type SampleLocationProvider,
  type SampleLocationQuery,
  type SampleSource,
} from '@labnoteo/core';
import {
  isSameSampleFolder,
  listExperimentSampleFolders,
  loadSamplesByType,
  upsertSampleRecord,
  type SampleRecord,
} from '@labnoteo/core/lib/sampleStorage';
import { getSampleDisplayMeta } from '@labnoteo/core/lib/sampleUtils';
import { getExperimentDir } from '@labnoteo/core/lib/labnoteStructure';
import * as posix from '@labnoteo/core/posix';
import { NetError, type VaultGuard } from '../../integrations/netIpc';
import { withProgress } from '../../integrations/progressStore';
import type { SampleEnv } from '../../samples/env';
import { PartbankError, type PartbankClient } from './partbankClient';
import type { PartbankFeature } from './partbankFeature';

/**
 * Resolves a linked sample's location from partbank, falling back to the
 * stored one. Implements the seam `LocalSampleLocationProvider` defines, so a
 * caller can swap providers without knowing partbank exists.
 */
export class PartbankLocationProvider implements SampleLocationProvider {
  private readonly local = new LocalSampleLocationProvider();

  constructor(private readonly partbank: PartbankFeature) {}

  async getLocation(query: SampleLocationQuery): Promise<string | null> {
    const source = query.record?.source;
    if (!source) return this.local.getLocation(query);
    try {
      const fresh = await this.fetch(source);
      return fresh ?? this.local.getLocation(query);
    } catch {
      // Offline, or the item is gone: the last known location is still the
      // best answer available.
      return this.local.getLocation(query);
    }
  }

  /** The location partbank reports, or null when it shows no visible stock. */
  async fetch(source: SampleSource): Promise<string | null> {
    const client = this.partbank.clientForSource(source);
    if (!client) throw new PartbankError('notFound', undefined, 'no connection for this link');
    return formatStockLocation(await client.getStocks(source.type, source.id)) || null;
  }
}

/** One sample whose location would change. */
export interface LocationChange {
  type: string;
  id: string;
  alias: string | null;
  folder: string;
  before: string | null;
  after: string | null;
}

/** One linked sample: where its record is and the record itself. */
export interface PartbankSampleRef {
  type: string;
  id: string;
  folder: string;
  record: SampleRecord;
}

/**
 * The changes worth showing. A refresh that found the same text is not a
 * change, and an unlinked sample is never touched.
 */
export function locationChangesOf(
  results: readonly { type: string; id: string; alias: string | null; folder: string; before: string | null; after: string | null }[],
): LocationChange[] {
  return results.filter((r) => (r.before ?? '') !== (r.after ?? ''));
}

/**
 * The changes to offer, and how many locations partbank would empty. Those are
 * kept without asking, as {@link refreshOneLocation} keeps one (#294): partbank
 * showing no stock is often a sharing boundary rather than a move, and the
 * text may have been typed by hand.
 */
export function storableChanges(changes: readonly LocationChange[]): { offer: LocationChange[] } {
  return { offer: changes.filter((c) => c.after) };
}

/**
 * How many of `results` partbank has no stock for. Counted over every result,
 * not over the changes: a sample with no location stored and none to read is
 * no change, and used to be left out of the tally altogether (#552).
 */
export function noStockCount(results: readonly { after: string | null }[]): number {
  return results.filter((r) => !r.after).length;
}

/** `main`, then how many kept their location for lack of stock and how many could not be read. */
export function locationRefreshNotice(env: SampleEnv, main: string, noStock: number, failed: number): string {
  const parts = [main];
  if (noStock > 0) {
    parts.push(env.t('{0} sample(s) with no stock in partbank keep their current location.', String(noStock)));
  }
  if (failed > 0) parts.push(env.t('{0} sample(s) could not be read from partbank.', String(failed)));
  return parts.join(' ');
}

/**
 * Every experiment's Local registry, then the Global one: the whole vault, so
 * the result does not depend on which note is open (#437).
 */
export async function vaultSampleFolders(env: SampleEnv): Promise<string[]> {
  const folders = await listExperimentSampleFolders(env.fs, '');
  const global = env.globalFolder();
  if (global && !folders.some((folder) => isSameSampleFolder(folder, global))) folders.push(global);
  return folders;
}

/** Every sample in `folders` that carries a partbank link. */
export async function linkedSamplesIn(env: SampleEnv, folders: readonly string[]): Promise<PartbankSampleRef[]> {
  const types = getSampleDisplayMeta(env.settings().customSampleTypes).types;
  const out: PartbankSampleRef[] = [];
  for (const folder of folders) {
    if (!folder) continue;
    for (const type of types) {
      const records = await loadSamplesByType(env.fs, folder, type);
      for (const [id, record] of Object.entries(records)) {
        if (record.source) out.push({ type, id, folder, record });
      }
    }
  }
  return out;
}

/** Write the picked changes back to the registry. With a guard, nothing is written once the vault changed (D11). */
export async function applyLocationChanges(
  env: SampleEnv,
  changes: readonly LocationChange[],
  guard?: VaultGuard,
): Promise<void> {
  const written = new Set<string>();
  try {
    for (const change of changes) {
      const record = (await loadSamplesByType(env.fs, change.folder, change.type))[change.id];
      if (!record) continue;
      await guard?.check();
      await upsertSampleRecord(env.fs, change.folder, change.type, change.id, {
        alias: record.alias,
        description: record.descriptions?.[0] ?? null,
        location: change.after,
      });
      written.add(posix.join(change.folder, `${change.type}.json`));
    }
  } finally {
    if (written.size > 0) env.changed([...written]);
  }
}

/** The experiment folder a Local registry belongs to, or Global. */
function registryName(folder: string, env: SampleEnv): string {
  const dir = getExperimentDir(folder);
  return dir ? posix.basename(dir) : env.t('Global');
}

/** `old → new`, as the confirmation list shows a change. */
export function describeChange(change: LocationChange, env: SampleEnv): string {
  const empty = env.t('(none)');
  return `${change.before || empty} → ${change.after || empty}`;
}

const isCancelled = (err: unknown): boolean => err instanceof NetError && err.kind === 'cancelled';
const cancelled = () => new NetError('cancelled', 'cancelled');

/**
 * `work`, or a `cancelled` rejection as soon as one of `signals` aborts. The
 * lookup in flight runs on in Rust (it has a 15 s timeout); its answer is ignored.
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
 * Refresh one sample's location, asking before it is written. Returns whether
 * anything was stored. When partbank shows no stock the stored location is
 * kept without asking: a single Enter on that prompt used to erase a
 * hand-typed location (#269).
 */
export async function refreshOneLocation(env: SampleEnv, feature: PartbankFeature, args: PartbankSampleRef): Promise<boolean> {
  const source = args.record.source;
  if (!source) {
    env.host.notify('info', env.t('This sample is not linked to partbank.'));
    return false;
  }
  const client = feature.clientForSource(source);
  const provider = new PartbankLocationProvider(feature);
  let after: string | null;
  let guard: VaultGuard | undefined;
  try {
    // The location belongs to the vault the refresh started in (D11).
    guard = client ? await client.vaultGuard() : undefined;
    after = await provider.fetch(source);
  } catch (err) {
    if (!isCancelled(err)) feature.notifyError(err, client);
    return false;
  }
  const before = args.record.location ?? null;
  // Ahead of the "unchanged" answer: a sample with no location stored and no
  // stock in partbank matched it, and "unchanged" read as a confirmed empty
  // location rather than as nothing to read (#552).
  if (!after) {
    env.host.notify(
      'info',
      before
        ? env.t(
            'partbank shows no stock for {0}, so the current location is kept. To clear it, empty the location in Edit sample.',
            args.id,
          )
        : env.t(
            'partbank has no stock for {0}, so there is no storage location to read. Register the stock in partbank, then refresh again.',
            args.id,
          ),
    );
    return false;
  }
  if ((before ?? '') === (after ?? '')) {
    env.host.notify('info', env.t('The storage location is unchanged.'));
    return false;
  }
  const change: LocationChange = {
    type: args.type,
    id: args.id,
    alias: args.record.alias,
    folder: args.folder,
    before,
    after,
  };
  const ok = await env.host.confirm(
    env.t('Store the storage location of {0} as read from partbank?\n{1}', args.id, describeChange(change, env)),
    { confirmLabel: env.t('Store') },
  );
  if (!ok) return false;
  try {
    await guard?.check();
    await applyLocationChanges(env, [change], guard);
  } catch (err) {
    if (isCancelled(err)) return false;
    throw err;
  }
  return true;
}

/** How a sample is named in the pick list and the progress lines. */
const sampleLabel = (id: string, alias: string | null): string => `${id}${alias ? `;${alias}` : ''}`;

/**
 * Refresh every linked sample in `folders`, then let the user pick which of
 * the changes to keep.
 *
 * Paced rather than parallel: the web server allows 100 calls a minute per IP
 * and the client spaces them out, and a 429 stops the run so the results
 * gathered so far are still offered.
 */
export async function refreshLocationsIn(env: SampleEnv, feature: PartbankFeature, folders: readonly string[]): Promise<void> {
  // A discarded sample's location is left as the researcher set it (#458).
  const linked = (await linkedSamplesIn(env, folders)).filter((s) => !s.record.discarded);
  if (linked.length === 0) {
    env.host.notify('info', env.t('No sample in this vault is linked to partbank.'));
    return;
  }
  const provider = new PartbankLocationProvider(feature);
  const first = linked.map((s) => s.record.source && feature.clientForSource(s.record.source)).find(Boolean);
  const guard = await (first ?? feature.defaultClient())?.vaultGuard();
  const results: LocationChange[] = [];
  let stopped: { err: unknown; client: PartbankClient | undefined } | undefined;
  let failed = 0;
  try {
    await withProgress(
      env.t('Reading storage locations from partbank…'),
      async (progress) => {
        const signals = guard ? [progress.signal, guard.signal] : [progress.signal];
        for (const [index, sample] of linked.entries()) {
          const source = sample.record.source;
          if (!source) continue;
          if (signals.some((s) => s.aborted)) throw cancelled();
          const label = sampleLabel(sample.id, sample.record.alias);
          const client = feature.clientForSource(source);
          try {
            const result: LocationChange = {
              type: sample.type,
              id: sample.id,
              alias: sample.record.alias,
              folder: sample.folder,
              before: sample.record.location ?? null,
              after: await untilAborted(signals, provider.fetch(source)),
            };
            results.push(result);
            progress.line(`${label}: ${describeChange(result, env)}`);
          } catch (err) {
            if (isCancelled(err) || signals.some((s) => s.aborted)) throw cancelled();
            progress.line(`${label}: ${feature.describeError(err, client)}`);
            // One missing item should not end the run; a refusal to serve should.
            if (err instanceof PartbankError && err.kind === 'rateLimited') {
              stopped = { err, client };
              // The refused sample and every one after it were not read.
              failed += linked.length - index;
              break;
            }
            failed++;
          }
        }
      },
      { cancellable: true },
    );
  } catch (err) {
    // Cancel, or a vault switch: the user knows, and nothing was written.
    if (isCancelled(err) || guard?.signal.aborted) return;
    throw err;
  }

  const { offer } = storableChanges(locationChangesOf(results));
  const noStock = noStockCount(results);
  if (stopped) feature.notifyError(stopped.err, stopped.client);
  const finish = (main: string): void => {
    env.host.notify('info', locationRefreshNotice(env, main, noStock, failed));
  };
  if (offer.length === 0) {
    finish(env.t('Checked {0} linked sample(s); no storage location changed.', String(results.length)));
    return;
  }
  const picked = await env.host.pickMany(
    offer.map((change) => ({
      label: sampleLabel(change.id, change.alias),
      description: `${describeChange(change, env)} · ${registryName(change.folder, env)}`,
      checked: true,
      value: change,
    })),
    {
      title: env.t('Storage locations to store ({0} changed)', String(offer.length)),
    },
  );
  if (picked.length === 0) {
    finish(env.t('No storage location was stored.'));
    return;
  }
  try {
    await guard?.check();
    await applyLocationChanges(env, picked, guard);
  } catch (err) {
    if (isCancelled(err)) return;
    throw err;
  }
  finish(env.t('Stored {0} storage location(s).', String(picked.length)));
}
