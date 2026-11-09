// Ported from app/vendor/labnoteo/src/partbank/partbankRegister.ts:50-432 sha256:a529a74c9b309e25
// Ported from app/vendor/labnoteo/src/partbank/partbankLocation.ts:117-141 sha256:6c0312941ecd7f68
// labnoteO 0.140.2, Apache-2.0.
// Changes: LabnotePlugin becomes SampleEnv plus PartbankFeature: registerPartbankItem, resolveSampleType, addStrainType, collectLinkedCandidates, catalogSeedNote and noticeForRegistration take env in place of plugin, and pickPartbankReference takes (env, feature, opts) (registerPartbankItem needs no feature: its client is passed in). plugin.t → env.t; plugin.fs → env.fs; plugin.settings.globalSampleFolder → env.globalFolder(); plugin.settings.customSampleTypes → env.settings().customSampleTypes; confirmModal(app, message, label) → env.host.confirm(message, { confirmLabel: label }); new Notice(m) → env.host.notify('info', m), and 'warn' for the alias clash; searchPartbankModal(app, client, entities, {…}) → searchPartbankDialog({ type, initialQuery, client, entities, onError }), whose placeholder and empty text the dialog builds itself; plugin.partbank.notifyError(err, client.kind) → feature.notifyError(err, client); addStrainType's settings write + saveSettings → env.updateSettings({ customSampleTypes: [...] }), and refreshSampleViews → env.changed(); plugin.samplesChanged() → env.changed([the written registry]); plugin.localSampleFolder() → env.localFolder(); plugin.sampleTrackingFor → env.trackingFor; plugin.host.editTarget()?.path → env.editTarget()?.path, falling back to env.activePath(); loadCatalogSamples and pickAliasSibling come from the sample ports (sampleScope, sampleCreate). A vault switch is checked for (D11): pickPartbankReference and registerPartbankItem take a VaultGuard at the start (client.vaultGuard(), or opts.guard), guard.check() runs before upsertSampleRecord and before addStrainType's settings write, a cancelled item refetch or stock lookup is not taken for an item without detail or stock, and a cancelled registration returns undefined and writes nothing; resolveSampleType takes opts.guard for that. registerPartbankItem refuses an unreadable (conflicted) target registry with RegistryUnreadableError (assertRegistryReadable) before the alias-sibling question and the stock lookup, as sampleCreate does; the caller routes it through runCommand-style handling. vaultSampleFolders and linkedSamplesIn (partbankLocation.ts:117-141) are ported here as private helpers ahead of the storage-location port (Task 22), which register-or-reuse needs for #446.
/**
 * Registering a partbank item as a sample: deciding its type, finding the
 * sample that already stands for it, and writing the record.
 *
 * The rule that shapes this file: one partbank item gets one labnoteo id. A
 * second id would split a note's references between two records that nothing
 * ties together, so an item already in the registry (or in a downloaded
 * catalog) is reused rather than registered again.
 */
import {
  aliasForItem,
  descriptionForItem,
  findLinkedSample,
  formatStockLocation,
  isSameSampleSource,
  sampleTypeForItem,
  searchEntitiesForSampleType,
  sourceForItem,
  STRAIN_SAMPLE_TYPE,
  type LinkedSample,
  type PartbankItem,
  type SampleSource,
} from '@labnoteo/core';
import {
  buildSampleReferenceText,
  canonicalSampleType,
  generateSampleId,
  getSampleDisplayMeta,
} from '@labnoteo/core/lib/sampleUtils';
import {
  isSameSampleFolder,
  listExperimentSampleFolders,
  loadSamplesByType,
  noteLabsamplesFolder,
  upsertSampleRecord,
  type SampleRecord,
} from '@labnoteo/core/lib/sampleStorage';
import { getExperimentDir } from '@labnoteo/core/lib/labnoteStructure';
import * as posix from '@labnoteo/core/posix';
import { NetError, type VaultGuard } from '../../integrations/netIpc';
import { searchPartbankDialog } from '../../partbank/PartbankSearchDialog';
import { assertRegistryReadable, type SampleEnv } from '../../samples/env';
import type { PartbankClient } from './partbankClient';
import type { PartbankFeature } from './partbankFeature';
import { pickAliasSibling } from './sampleCreate';
import { loadCatalogSamples } from './sampleScope';

/** What a registration produced, for the caller to insert or copy. */
export interface RegisteredPartbankSample {
  type: string;
  id: string;
  alias: string | null;
  /** `id;alias`, the registry-first form a note carries. */
  referenceText: string;
  folder: string;
  /** The sample already stood for this item, so nothing new was written. */
  reused: boolean;
  /** For a reused sample: which registry or catalog it came from. */
  foundIn?: LinkedSample['scope'];
  /** For a reused sample of another type than the one asked for (#301): the type asked for. */
  requestedType?: string;
  /** For a reused sample marked used up (#387): the date it was marked. */
  discarded?: string;
  /** For a reused sample: picked because it has the item's alias, not linked to the item (#504). */
  sameAlias?: boolean;
  /** For a new sample: other experiments' samples for the same item (#446). */
  elsewhere?: Array<{ folder: string; id: string }>;
}

/** The registry file a write of `type` into `folder` touched, for {@link SampleEnv.changed}. */
const registryOf = (folder: string, type: string) => [`${folder}/${type}.json`];

/** A request or guard check given up because the vault was switched (D11). */
const isCancelled = (err: unknown): boolean => err instanceof NetError && err.kind === 'cancelled';

/** The vault's strain type, when it has one: partbank strains need it. */
export function strainTypeOf(env: SampleEnv): string | undefined {
  return canonicalSampleType(STRAIN_SAMPLE_TYPE, getSampleDisplayMeta(env.settings().customSampleTypes).types);
}

/**
 * The labnoteo type for an item, asking to add a strain type when partbank
 * hands over a strain and the vault has none. Undefined means the user said no
 * and the item is left alone.
 */
export async function resolveSampleType(
  env: SampleEnv,
  item: PartbankItem,
  opts: { silent?: boolean; guard?: VaultGuard } = {},
): Promise<string | undefined> {
  const strainType = strainTypeOf(env);
  const type = sampleTypeForItem(item, { strainType });
  if (type) return type;
  if (item.type !== 'strain') return undefined;
  if (opts.silent) return undefined;
  const ok = await env.host.confirm(
    env.t('partbank keeps strains, but this vault has no sample type for them. Add the custom sample type "{0}"?', STRAIN_SAMPLE_TYPE),
    { confirmLabel: env.t('Add {0}', STRAIN_SAMPLE_TYPE) },
  );
  if (!ok) return undefined;
  // The settings belong to the vault the item was fetched for (D11).
  await opts.guard?.check();
  await addStrainType(env);
  return STRAIN_SAMPLE_TYPE;
}

/** Add the strain type the way the settings screen does, and refresh the views. */
export async function addStrainType(env: SampleEnv): Promise<void> {
  const now = env.settings().customSampleTypes;
  if (!now.some((t) => t.toLowerCase() === STRAIN_SAMPLE_TYPE.toLowerCase())) {
    await env.updateSettings({ customSampleTypes: [...now, STRAIN_SAMPLE_TYPE] });
  }
  env.changed();
}

/**
 * Every sample that could already stand for a partbank item: this note's
 * registry, the global one, and the catalogs both of those hold. Every type
 * is read, `type` first: a sample whose type was changed keeps its partbank
 * link and still stands for the item (#301).
 */
export async function collectLinkedCandidates(env: SampleEnv, type: string, localFolder: string): Promise<LinkedSample[]> {
  const globalFolder = env.globalFolder();
  const readGlobal = Boolean(globalFolder) && !isSameSampleFolder(localFolder, globalFolder);
  const types = getSampleDisplayMeta(env.settings().customSampleTypes).types;
  const out: LinkedSample[] = [];
  for (const t of [type, ...types.filter((other) => other !== type)]) {
    const add = (records: Record<string, SampleRecord>, scope: LinkedSample['scope'], folder: string): void => {
      for (const [id, record] of Object.entries(records)) out.push({ type: t, id, record, scope, folder });
    };
    add(await loadSamplesByType(env.fs, localFolder, t), 'local', localFolder);
    add(await loadCatalogSamples(env, localFolder, t), 'catalog', localFolder);
    if (readGlobal) {
      add(await loadSamplesByType(env.fs, globalFolder, t), 'global', globalFolder);
      add(await loadCatalogSamples(env, globalFolder, t), 'catalog', globalFolder);
    }
  }
  return out;
}

/**
 * Register `item` as a sample in `folder`, or reuse the sample that already
 * stands for it. The storage location is read in the same pass, so a freshly
 * registered sample shows where it is kept without a second command.
 *
 * `lookIn` is the experiment's own sample folder, searched (with Global and
 * the catalogs) for the item even when `folder` is Global: writing to Global
 * must not register a second ID for an item this experiment already has
 * (#270). It defaults to `folder`. A reused sample reports where it was found.
 */
export async function registerPartbankItem(
  env: SampleEnv,
  client: PartbankClient,
  item: PartbankItem,
  opts: { folder: string; type?: string; lookIn?: string; guard?: VaultGuard } = { folder: '' },
): Promise<RegisteredPartbankSample | undefined> {
  const guard = opts.guard ?? (await client.vaultGuard());
  try {
    return await registerWithGuard(env, client, item, opts, guard);
  } catch (err) {
    // The vault was switched while partbank answered: nothing was written (D11).
    if (isCancelled(err)) return undefined;
    throw err;
  }
}

async function registerWithGuard(
  env: SampleEnv,
  client: PartbankClient,
  item: PartbankItem,
  opts: { folder: string; type?: string; lookIn?: string },
  guard: VaultGuard,
): Promise<RegisteredPartbankSample | undefined> {
  const type = opts.type ?? (await resolveSampleType(env, item, { guard }));
  if (!type) return undefined;
  const folder = opts.folder;
  const lookIn = opts.lookIn ?? folder;
  const source = sourceForItem(item, client.kind, client.origin);

  const existing = findLinkedSample(source, await collectLinkedCandidates(env, type, lookIn));
  if (existing) {
    return {
      type: existing.type,
      id: existing.id,
      alias: existing.record.alias,
      referenceText: buildSampleReferenceText(existing.id, existing.record.alias),
      folder: existing.folder ?? folder,
      reused: true,
      foundIn: existing.scope,
      ...(existing.type !== type ? { requestedType: type } : {}),
      ...(existing.record.discarded ? { discarded: existing.record.discarded } : {}),
    };
  }

  // A conflicted registry would refuse the write only after the questions; refuse it before them instead.
  await assertRegistryReadable(env.fs, registryOf(folder, type)[0]);
  const alias = aliasForItem(item);
  const sibling = alias ? await pickAliasSibling(env, folder, type, alias) : null;
  if (sibling === undefined) return undefined;
  if (sibling !== null) {
    const siblingAlias = sibling.record?.alias ?? null;
    return {
      type,
      id: sibling.id,
      alias: siblingAlias,
      referenceText: buildSampleReferenceText(sibling.id, siblingAlias),
      folder,
      reused: true,
      sameAlias: true,
      foundIn: isSameSampleFolder(folder, env.globalFolder()) ? 'global' : 'local',
      ...(sibling.record?.discarded ? { discarded: sibling.record.discarded } : {}),
    };
  }
  const id = generateSampleId(type);
  // Best-effort: an item with no visible stock, or a lookup that fails, simply
  // leaves the location empty rather than failing the registration. A lookup
  // cancelled by a vault switch is not one of those: it ends the registration.
  let location: string | null = null;
  try {
    location = formatStockLocation(await client.getStocks(item.type, item.id)) || null;
  } catch (err) {
    if (isCancelled(err) || guard.signal.aborted) throw err;
    location = null;
  }
  const others = await samplesInOtherExperiments(env, source, [folder, lookIn]);
  if (!location) location = await offerLocationFrom(env, others);
  await guard.check();
  await upsertSampleRecord(env.fs, folder, type, id, {
    alias,
    description: descriptionForItem(item),
    location,
    source,
  });
  env.changed(registryOf(folder, type));
  return {
    type,
    id,
    alias,
    referenceText: buildSampleReferenceText(id, alias),
    folder,
    reused: false,
    ...(others.length > 0 ? { elsewhere: others.map((o) => ({ folder: o.folder, id: o.id })) } : {}),
  };
}

type LinkedRecord = { type: string; id: string; folder: string; record: SampleRecord };

/**
 * Every experiment's Local registry, then the Global one: the whole vault, so
 * the result does not depend on which note is open (#437).
 */
async function vaultSampleFolders(env: SampleEnv): Promise<string[]> {
  const folders = await listExperimentSampleFolders(env.fs, '');
  const global = env.globalFolder();
  if (global && !folders.some((folder) => isSameSampleFolder(folder, global))) folders.push(global);
  return folders;
}

/** Every sample in `folders` that carries a partbank link. */
async function linkedSamplesIn(env: SampleEnv, folders: readonly string[]): Promise<LinkedRecord[]> {
  const types = getSampleDisplayMeta(env.settings().customSampleTypes).types;
  const out: LinkedRecord[] = [];
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

/**
 * Samples for the same partbank item in other experiments (#446): not used
 * (one experiment does not use another's samples), but worth knowing, as a
 * tube may already be recorded there. `skip` and Global are left out.
 */
async function samplesInOtherExperiments(env: SampleEnv, source: SampleSource, skip: readonly string[]): Promise<LinkedRecord[]> {
  const left = [...skip, env.globalFolder()].filter(Boolean);
  const folders = (await vaultSampleFolders(env)).filter((f) => !left.some((s) => isSameSampleFolder(f, s)));
  return (await linkedSamplesIn(env, folders)).filter((s) => s.record.source && isSameSampleSource(s.record.source, source));
}

/**
 * The storage location the `others` record, if the user wants it for the new
 * sample (#446). Asked only when they agree on one: with several, which tube
 * is meant cannot be told. A discarded sample's location may be stale.
 */
async function offerLocationFrom(env: SampleEnv, others: readonly LinkedRecord[]): Promise<string | null> {
  const kept = others.filter((o) => !o.record.discarded && o.record.location?.trim());
  const locations = new Set(kept.map((o) => o.record.location!.trim()));
  if (locations.size !== 1) return null;
  const [location] = locations;
  const ok = await env.host.confirm(
    env.t(
      "{1} of the experiment {0} has this partbank item, kept at '{2}'. Write that storage location for this sample too?",
      experimentOf(kept[0].folder),
      kept[0].id,
      location,
    ),
    { confirmLabel: env.t('Use this location') },
  );
  return ok ? location : null;
}

/** `001_Exp` for an experiment's samples folder. */
function experimentOf(folder: string): string {
  return posix.basename(getExperimentDir(folder) ?? folder);
}

/**
 * The "Search partbank" autocomplete action end to end: search, register (or
 * reuse), and hand back the `id;alias` to insert. `type` is the type the user
 * typed, or null for `@sample`, where the item decides.
 */
export async function pickPartbankReference(
  env: SampleEnv,
  feature: PartbankFeature,
  opts: { type: string | null; initialQuery: string; guard?: VaultGuard },
): Promise<string | undefined> {
  const client = feature.defaultClient();
  if (!client) {
    feature.notifyNotConfigured();
    return undefined;
  }
  const guard = opts.guard ?? (await client.vaultGuard());
  try {
    return await pickWithGuard(env, feature, client, opts, guard);
  } catch (err) {
    // The vault was switched while partbank answered: nothing was written (D11).
    if (isCancelled(err)) return undefined;
    throw err;
  }
}

async function pickWithGuard(
  env: SampleEnv,
  feature: PartbankFeature,
  client: PartbankClient,
  opts: { type: string | null; initialQuery: string },
  guard: VaultGuard,
): Promise<string | undefined> {
  const entities = searchEntitiesForSampleType(opts.type, { strainType: strainTypeOf(env) });
  if (entities.length === 0) return undefined;

  const hit = await searchPartbankDialog({
    type: opts.type,
    initialQuery: opts.initialQuery,
    client,
    entities,
    onError: (err) => void feature.notifyError(err, client),
  });
  if (!hit) return undefined;

  // The search rows carry no `molecule_type`, which is what decides whether a
  // molecule is a protein, an RNA or a reagent, so the detail is fetched.
  let item: PartbankItem = hit;
  try {
    item = await client.getItem(hit.type, hit.id);
  } catch (err) {
    if (isCancelled(err) || guard.signal.aborted) return undefined;
    if (hit.type === 'molecule' && opts.type === null) {
      feature.notifyError(err, client);
      return undefined;
    }
  }

  const type = opts.type ?? (await resolveSampleType(env, item, { guard }));
  if (!type) return undefined;
  const folder = env.localFolder();
  const result = await registerPartbankItem(env, client, item, { folder, type, guard });
  if (!result) return undefined;
  // Only a new sample can clash; a reused one is the very sample (#387).
  if (!result.reused && result.alias) await warnOnAliasClash(env, type, folder, result.alias, result.id);
  // The autocomplete puts the returned reference into the note being edited.
  const notePath = env.editTarget()?.path ?? env.activePath();
  noticeForRegistration(env, result, undefined, catalogSeedNote(env, result, notePath));
  return result.referenceText;
}

/**
 * Tell the user when the alias is already taken. Not a refusal: partbank is
 * the authority on the name, and two samples may legitimately share one.
 */
async function warnOnAliasClash(env: SampleEnv, type: string, folder: string, alias: string, self: string): Promise<void> {
  const globalFolder = env.globalFolder();
  const folders = [folder];
  if (globalFolder && !isSameSampleFolder(folder, globalFolder)) folders.push(globalFolder);
  const wanted = alias.trim().toLowerCase();
  for (const f of folders) {
    const records = await loadSamplesByType(env.fs, f, type);
    const clash = Object.keys(records).find((id) => id !== self && records[id].alias?.trim().toLowerCase() === wanted);
    if (clash) {
      env.host.notify('warn', env.t('"{0}" is already the alias of {1}.', alias, clash));
      return;
    }
  }
}

/**
 * The sentence for a sample reused from a catalog once its reference went into
 * `notePath`: saving that note copies it into the experiment's registry (the
 * sample sync seeds catalog references). Empty when no copy follows: not from
 * a catalog, a note whose samples are not tracked, or one outside an
 * experiment, whose registry is the global one.
 */
export function catalogSeedNote(env: SampleEnv, result: RegisteredPartbankSample, notePath: string | undefined): string {
  if (result.foundIn !== 'catalog' || !notePath || !env.trackingFor(notePath)) return '';
  const globalFolder = env.globalFolder();
  if (!getExperimentDir(notePath) || isSameSampleFolder(noteLabsamplesFolder(notePath, globalFolder), globalFolder)) {
    return '';
  }
  return env.t("Saving the note adds it to this experiment's samples as well.");
}

/**
 * Say what happened, including when the sample landed in Global (#64).
 * `chosenFolder` is the folder the user picked, when they picked one: Global
 * chosen is then told apart from Global by default, and a sample reused from
 * elsewhere says where it is (#270): a catalog (#295), another folder, or
 * under another type than the one asked for (#301). `extra` is appended.
 */
export function noticeForRegistration(
  env: SampleEnv,
  result: RegisteredPartbankSample,
  chosenFolder?: string,
  extra = '',
): void {
  const show = (text: string): void => {
    env.host.notify('info', extra ? `${text} ${extra}` : text);
  };
  if (result.reused) {
    const elsewhere = result.foundIn === 'global' || (chosenFolder !== undefined && !isSameSampleFolder(result.folder, chosenFolder));
    const main = result.sameAlias
      ? env.t('Using the existing sample {0} instead of creating one.', result.id)
      : result.foundIn === 'catalog'
        ? env.t('Used {0} from the partbank catalog ({1}).', result.id, result.folder)
        : elsewhere
          ? env.t(
              '{0} in {1} already stands for this partbank item, so it was used instead of registering a second one.',
              result.id,
              result.folder,
            )
          : env.t('{0} already stands for this partbank item.', result.id);
    show(
      [
        main,
        result.requestedType ? env.t('It is registered as {0}, not {1}.', result.type, result.requestedType) : '',
        result.discarded ? env.t('{0} was marked discarded on {1}.', result.id, result.discarded) : '',
      ]
        .filter(Boolean)
        .join(' '),
    );
    return;
  }
  const landedInGlobal = isSameSampleFolder(result.folder, env.globalFolder());
  const added = !landedInGlobal
    ? env.t('Sample added: {0}', result.id)
    : chosenFolder !== undefined
      ? env.t('Sample added to Global samples: {0}', result.id)
      : env.t('{0} was added to Global samples because this note is outside an experiment folder.', result.id);
  const elsewhere = result.elsewhere?.length
    ? env.t(
        'Other experiments have this partbank item too: {0}.',
        result.elsewhere.map((o) => `${o.id} (${experimentOf(o.folder)})`).join(', '),
      )
    : '';
  show([added, elsewhere].filter(Boolean).join(' '));
}
