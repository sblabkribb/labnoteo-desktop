// Ported from app/vendor/labnoteo/src/sampleActions.ts:415-897 sha256:851b8d2ce7b19901
// labnoteO 0.138.0, Apache-2.0.
// Changes: App/LabnotePlugin → SampleEnv (D5); Notice → host.notify; modals → host dialogs. In detail: plugin.t → env.t; new Notice(m[, ms]) → env.host.notify('info' | 'warn', m) without the duration (warn for the refused folder, the alias twins and the discarded notices); promptModal/pickModal/confirmModal(app, …, label) → env.host.prompt/pick/confirm(…, { confirmLabel: label }); pickModal's initialQuery is dropped because the app's pick dialog has no initial query (it still pre-fills the create fallback); plugin.fs → env.fs; plugin.settings.globalSampleFolder → env.globalFolder(); plugin.settings.customSampleTypes → env.settings().customSampleTypes; plugin.refreshSampleViews() → env.changed([written registry]); an unreadable (conflicted) target registry is refused with RegistryUnreadableError before the first prompt; validateAlias/validateDescription/loadCatalogSamples take env. confirmAliasClash, confirmLocationClash, aliasSiblingLabel, globalSamplesWithAlias and findRegisteredSample are exported for the edit and move ports.
import type { PickItem } from '@labnoteo/core';
import { invalidVaultFolderReason } from '@labnoteo/core/lib/regexUtils';
import {
  buildSampleDefinitionText,
  buildSampleReferenceText,
  generateSampleId,
  getSampleDisplayMeta,
  normalizeSampleId,
} from '@labnoteo/core/lib/sampleUtils';
import {
  isSameSampleFolder,
  isStorageSlot,
  loadSampleLocations,
  loadSamplesByType,
  mergeSampleRecord,
  noteLabsamplesFolder,
  samplesAtLocation,
  samplesWithAliasIn,
  upsertSampleRecord,
  type SampleRecord,
} from '@labnoteo/core/lib/sampleStorage';
import { assertRegistryReadable, type SampleEnv } from '../../samples/env';
import { invalidFolderText } from './customSampleTypes';
import { updateSampleListTables } from './sampleListTable';
import { clean, loadCatalogSamples, validateAlias, validateDescription, type SampleScope } from './sampleScope';

/** The registry file a write of `type` into `folder` touched, for {@link SampleEnv.changed}. */
const registryOf = (folder: string, type: string) => [`${folder}/${type}.json`];

export interface CreatedSample {
  id: string;
  alias: string | null;
  description: string | null;
  /** `@type;id;alias;desc` — optional, for the "insert definition" action. */
  definitionText: string;
  /** `id;alias` (or bare `id`) — the registry-first document insert form. */
  referenceText: string;
  /** An existing same-alias sample picked instead of creating one (#248). */
  reused?: boolean;
}

/**
 * The alias as the samples that have it are registered (#507): matched apart
 * from case and spaces, the typed one read as a different alias.
 */
export function storedAlias(
  records: Readonly<Record<string, SampleRecord | undefined>>,
  ids: readonly string[],
  typed: string,
): string {
  return ids.map((id) => records[id]?.alias?.trim()).find(Boolean) ?? typed;
}

/**
 * Before a new `type` sample with `alias` is written to `folder`: when the
 * folder already has samples with that alias, ask whether to use one of them.
 * A twin in the same folder is worse than a Global one (#125): autocomplete
 * shows the two with identical text and no Local/Global tag to tell them
 * apart. Asked before the sample is written (#248), on every path that makes
 * one, partbank included (#504). Every one is listed (#274): when two already
 * share the alias, offering only the first hides the one the user may have
 * meant.
 *
 * Resolves the sample picked, `null` to create a new one (or when there is no
 * such sample), and undefined when the user cancelled.
 */
export async function pickAliasSibling(
  env: SampleEnv,
  folder: string,
  type: string,
  typed: string,
): Promise<{ id: string; record: SampleRecord | undefined } | null | undefined> {
  const siblings = await samplesWithAliasIn(env.fs, folder, type, typed);
  if (siblings.length === 0) return null;
  const records = await loadSamplesByType(env.fs, folder, type);
  const alias = storedAlias(records, siblings, typed);
  const inGlobal = isSameSampleFolder(folder, env.globalFolder());
  const labels = siblings.map((s) => aliasSiblingLabel(env, s, records[s]));
  // Discarded ones go below "Create a new sample anyway", so Enter on the
  // first item does not take a tube that is gone (#419), as in autocomplete.
  const reuseItem = (sibling: string) => {
    const discarded = records[sibling]?.discarded;
    return {
      label: `${env.t('Use the existing sample {0}', sibling)}${discarded ? ` ${env.t('(discarded)')}` : ''}`,
      value: sibling,
      description:
        [discarded && env.t('Marked discarded on {0}', discarded), records[sibling]?.descriptions?.[0], records[sibling]?.location]
          .filter(Boolean)
          .join(' · ') || env.t('Nothing is registered; its ID goes where this one would have.'),
    };
  };
  const live = siblings.filter((s) => !records[s]?.discarded);
  const reuse = await env.host.pick<string | null>(
    [
      ...live.map(reuseItem),
      {
        label: env.t('Create a new sample anyway'),
        value: null,
        description: env.t('Both keep the alias, and only their descriptions tell them apart.'),
      },
      ...siblings.filter((s) => records[s]?.discarded).map(reuseItem),
    ],
    {
      title:
        live.length === 0
          ? env.t('Only discarded samples have the alias {0} ({1}).', alias, siblings.join(', '))
          : siblings.length === 1
            ? env.t(
                inGlobal ? 'Global samples already have the alias {0} ({1}).' : 'This experiment already has the alias {0} ({1}).',
                alias,
                labels[0],
              )
            : env.t(
                inGlobal
                  ? '{0} Global samples already have the alias {1} ({2}).'
                  : '{0} samples in this experiment already have the alias {1} ({2}).',
                String(siblings.length),
                alias,
                labels.join(', '),
              ),
    },
  );
  if (reuse === undefined) return undefined;
  return reuse === null ? null : { id: reuse, record: records[reuse] };
}

/**
 * Interactively create a sample (generate a new id or enter one manually),
 * persist it, and return the created record + its `@type;id;...` definition
 * text. Returns undefined, registering nothing, when any step is cancelled
 * (Escape / closing the prompt); alias/description/location are optional, so
 * submitting a prompt empty leaves that field blank.
 */
export async function createSampleInteractive(
  env: SampleEnv,
  opts: {
    type: string;
    folder: string;
    mode: 'generate' | 'manual';
    scope?: SampleScope;
    /**
     * What was typed after `@type;` (#142): an ID of the type's form fills the
     * ID prompt of manual entry, anything else the alias prompt.
     */
    initial?: string;
  },
): Promise<CreatedSample | undefined> {
  const { type, folder, mode } = opts;
  // Checked before the prompts, so what would be typed into them is not lost (#328).
  const badFolder = invalidVaultFolderReason(folder);
  if (badFolder) {
    const why = env.t('Samples cannot be saved in "{0}": {1}', folder, invalidFolderText(env.t, badFolder));
    const fix = isSameSampleFolder(folder, env.globalFolder()) ? env.t('Change the Global sample folder in Settings.') : '';
    env.host.notify('warn', [why, fix].filter(Boolean).join(' '));
    return undefined;
  }
  // A conflicted registry would refuse the write only after every prompt; refuse it before them instead.
  await assertRegistryReadable(env.fs, registryOf(folder, type)[0]);
  const initial = opts.initial?.trim() ?? '';
  const initialId = initial && normalizeSampleId(type, initial) ? initial : undefined;
  const initialAlias = initial && !initialId ? initial : '';

  let id: string;
  let existing: { folder: string; record: SampleRecord } | undefined;
  if (mode === 'generate') {
    id = generateSampleId(type);
  } else {
    const entered = await env.host.prompt({
      title: env.t('Enter the {0} sample ID', type),
      value: initialId ?? `${type}-`,
      placeholder: env.t('e.g. {0}-12345', type),
      validate: (v) => (normalizeSampleId(type, v) ? null : env.t('Invalid ID. Expected {0}-<number>.', type)),
    });
    if (entered === undefined) return undefined;
    id = normalizeSampleId(type, entered) ?? entered.trim();
    // Re-entering a known id adds to its record instead of replacing it (#84).
    existing = await findRegisteredSample(env, type, id, folder);
    if (existing) {
      env.host.notify(
        'info',
        env.t('{0} already exists. Its current values are filled in, and a new description is added before the earlier ones.', id),
      );
    }
  }

  const aliasRaw = await env.host.prompt({
    title: existing ? env.t('Enter a new alias') : env.t('Enter an alias for the new {0} sample (optional)', type),
    value: existing?.record.alias ?? initialAlias,
    placeholder: env.t('e.g. Sample-A'),
    validate: validateAlias(env),
  });
  if (aliasRaw === undefined) return undefined;
  const alias = clean(aliasRaw);
  // Re-entering a known id changes its alias as editing does (#403).
  if (existing && !(await confirmAliasClash(env, { folder: existing.folder, type, id, alias, before: existing.record.alias }))) {
    return undefined;
  }

  // Re-entering a known id is the merge flow, which stays.
  const sibling = alias && !existing ? await pickAliasSibling(env, folder, type, alias) : null;
  if (sibling === undefined) return undefined;
  if (sibling !== null) {
    const { id: reuse, record } = sibling;
    const reusedAlias = record?.alias ?? null;
    const reusedDesc = record?.descriptions?.[0] ?? null;
    env.host.notify('info', env.t('Using the existing sample {0} instead of creating one.', reuse));
    if (record?.discarded) env.host.notify('warn', env.t('{0} was marked discarded on {1}.', reuse, record.discarded));
    return {
      id: reuse,
      alias: reusedAlias,
      description: reusedDesc,
      definitionText: buildSampleDefinitionText(type, reuse, reusedAlias, reusedDesc),
      referenceText: buildSampleReferenceText(reuse, reusedAlias),
      reused: true,
    };
  }

  const descRaw = await env.host.prompt({
    title: env.t('Enter a description (optional)'),
    value: existing?.record.descriptions?.[0] ?? '',
    placeholder: env.t('e.g. Sample used in experiment 1'),
    validate: validateDescription(env),
  });
  if (descRaw === undefined) return undefined;
  const locationRaw = await env.host.prompt({
    title: env.t('Enter a storage location (optional)'),
    value: existing?.record.location ?? '',
    placeholder: env.t('e.g. Freezer-2 / Box-3 / A1'),
  });
  if (locationRaw === undefined) return undefined;
  const description = clean(descRaw);
  const location = clean(locationRaw);
  if (
    !(await confirmLocationClash(env, {
      folder: existing?.folder ?? folder,
      id,
      location,
      before: existing?.record.location,
    }))
  ) {
    return undefined;
  }

  if (existing) {
    // A blank field keeps the stored value, as in the note sync (#73); clearing
    // or rewriting one is what "Edit sample" is for.
    const { discarded } = await mergeSampleRecord(env.fs, existing.folder, type, id, {
      alias: alias ?? undefined,
      description: description ?? undefined,
      location: location ?? undefined,
    });
    env.changed(registryOf(existing.folder, type));
    const merged = (await loadSamplesByType(env.fs, existing.folder, type))[id];
    const mergedAlias = merged?.alias ?? null;
    const mergedDesc = merged?.descriptions?.[0] ?? null;
    // The sample list tables follow the registry as after "Edit sample" (#463).
    const changed =
      (existing.record.alias ?? null) !== mergedAlias ||
      (existing.record.descriptions ?? []).join('\u0000') !== (merged?.descriptions ?? []).join('\u0000') ||
      (existing.record.location ?? null) !== (merged?.location ?? null);
    const tables = changed ? await updateSampleListTables(env, { folder: existing.folder, type, id }) : 0;
    const tablesNote = tables > 0 ? env.t('Updated the sample list table in {0} note(s).', String(tables)) : undefined;
    env.host.notify('info', [env.t('Sample updated: {0}', id), tablesNote].filter(Boolean).join(' '));
    if (discarded) env.host.notify('warn', env.t('{0} was marked discarded on {1}.', id, discarded));
    return {
      id,
      alias: mergedAlias,
      description: mergedDesc,
      definitionText: buildSampleDefinitionText(type, id, mergedAlias, mergedDesc),
      referenceText: buildSampleReferenceText(id, mergedAlias),
    };
  }

  // Only Global holds the alias: the two are told apart by the Local/Global
  // tag in autocomplete, so a notice is enough (#109).
  const twins =
    alias && (await samplesWithAliasIn(env.fs, folder, type, alias)).length === 0
      ? await globalSamplesWithAlias(env, type, folder, alias)
      : [];
  if (twins.length > 0) {
    env.host.notify(
      'warn',
      env.t(
        'Global samples already have the alias {0} ({1}). Autocomplete will show both, marked Local and Global.',
        alias!,
        twins.join(', '),
      ),
    );
  }

  // `sources` is omitted so the record keeps whatever documents already
  // reference it; a tree-created sample legitimately starts with none.
  await upsertSampleRecord(env.fs, folder, type, id, { alias, description, location });
  env.changed(registryOf(folder, type));
  // A vault-root note's "local" folder is the global one (#64): say where it went.
  const landedInGlobal = opts.scope === 'local' && isSameSampleFolder(folder, env.globalFolder());
  env.host.notify(
    'info',
    landedInGlobal
      ? env.t('{0} was added to Global samples because this note is outside an experiment folder.', id)
      : env.t('Sample added: {0}', id),
  );

  return {
    id,
    alias,
    description,
    definitionText: buildSampleDefinitionText(type, id, alias, description),
    referenceText: buildSampleReferenceText(id, alias),
  };
}

/**
 * Ask before sample `id` of `folder` takes an alias another sample already has
 * (#403), as creating one does: the two would look alike in autocomplete. Only
 * Global holding it is told in a notice. True when the alias may be saved:
 * also when it is empty or did not change (spaces and case aside).
 */
export async function confirmAliasClash(
  env: SampleEnv,
  opts: { folder: string; type: string; id: string; alias: string | null; before?: string | null },
): Promise<boolean> {
  const { folder, type, id, alias } = opts;
  if (!alias || alias.trim().toLowerCase() === (opts.before ?? '').trim().toLowerCase()) return true;
  const siblings = (await samplesWithAliasIn(env.fs, folder, type, alias)).filter((s) => s !== id);
  if (siblings.length === 0) {
    const twins = (await globalSamplesWithAlias(env, type, folder, alias)).filter((s) => s !== id);
    if (twins.length > 0) {
      env.host.notify(
        'warn',
        env.t(
          'Global samples already have the alias {0} ({1}). Autocomplete will show both, marked Local and Global.',
          alias,
          twins.join(', '),
        ),
      );
    }
    return true;
  }
  const inGlobal = isSameSampleFolder(folder, env.globalFolder());
  const records = await loadSamplesByType(env.fs, folder, type);
  const labels = siblings.map((s) => aliasSiblingLabel(env, s, records[s]));
  const shown = storedAlias(records, siblings, alias);
  const taken =
    siblings.length === 1
      ? env.t(
          inGlobal ? 'Global samples already have the alias {0} ({1}).' : 'This experiment already has the alias {0} ({1}).',
          shown,
          labels[0],
        )
      : env.t(
          inGlobal
            ? '{0} Global samples already have the alias {1} ({2}).'
            : '{0} samples in this experiment already have the alias {1} ({2}).',
          String(siblings.length),
          shown,
          labels.join(', '),
        );
  return env.host.confirm(`${taken} ${env.t('Save {0} anyway?', id)}`, { confirmLabel: env.t('Save anyway') });
}

/**
 * Ask before a sample takes a storage slot another sample is in (#512). A slot
 * holds one tube whatever the sample's type is, so every type of this folder
 * and of Global is read. True when the location may be saved: also when it is
 * empty, names something wider than a slot, or did not change.
 */
export async function confirmLocationClash(
  env: SampleEnv,
  opts: { folder: string; id: string; location: string | null; before?: string | null },
): Promise<boolean> {
  const { folder, id, location } = opts;
  if (!location || !isStorageSlot(location)) return true;
  if (location.trim().toLowerCase() === (opts.before ?? '').trim().toLowerCase()) return true;
  const globalFolder = env.globalFolder();
  // A freezer slot is a physical place: a Local sample and a Global one cannot
  // both be in it, so both registries are read.
  const scopes: Array<{ folder: string; global: boolean }> = [
    { folder, global: isSameSampleFolder(folder, globalFolder) },
    ...(globalFolder && !isSameSampleFolder(folder, globalFolder) ? [{ folder: globalFolder, global: true }] : []),
  ];
  const taken: string[] = [];
  for (const scope of scopes) {
    for (const type of getSampleDisplayMeta(env.settings().customSampleTypes).types) {
      const entries = await loadSampleLocations(env.fs, scope.folder, type);
      for (const other of samplesAtLocation(entries, location)) {
        if (other === id && scope.folder === folder) continue;
        const where = scope.global ? env.t('Global {0} sample', type) : env.t('Local {0} sample', type);
        taken.push(`${other} (${where})`);
      }
    }
  }
  if (taken.length === 0) return true;
  const held =
    taken.length === 1
      ? env.t('{0} is already stored at {1}.', taken[0], location)
      : env.t('{0} samples are already stored at {1}: {2}.', String(taken.length), location, taken.join(', '));
  return env.host.confirm(`${held} ${env.t('Save {0} anyway?', id)}`, { confirmLabel: env.t('Save anyway') });
}

/** A sample sharing an alias, as an alias question names it: its ID, marked when discarded (#419). */
export function aliasSiblingLabel(env: Pick<SampleEnv, 't'>, id: string, record: SampleRecord | undefined): string {
  return record?.discarded ? `${id} ${env.t('(discarded)')}` : id;
}

/**
 * The IDs of the Global `type` samples with `alias` (trimmed, case ignored)
 * when a sample is being added to the Local `folder`: they would look alike in
 * autocomplete (#109). Empty for a Global folder or no such sample.
 */
export async function globalSamplesWithAlias(env: SampleEnv, type: string, folder: string, alias: string): Promise<string[]> {
  const globalFolder = env.globalFolder();
  if (!globalFolder || isSameSampleFolder(folder, globalFolder)) return [];
  return samplesWithAliasIn(env.fs, globalFolder, type, alias);
}

/**
 * The registry record for `id` in `folder`, else in the Global folder, with the
 * folder it was found in so an update lands there (no Local shadow of a Global
 * sample).
 */
export async function findRegisteredSample(
  env: SampleEnv,
  type: string,
  id: string,
  folder: string,
): Promise<{ folder: string; record: SampleRecord } | undefined> {
  const globalFolder = env.globalFolder();
  const folders = [folder];
  if (globalFolder && !isSameSampleFolder(folder, globalFolder)) folders.push(globalFolder);
  for (const f of folders) {
    const record = (await loadSamplesByType(env.fs, f, type))[id];
    if (record) return { folder: f, record };
  }
  return undefined;
}

/**
 * Search the read-only product catalog (`{Type}_*.json`) for a catalog type
 * (Reagent/Labware/Equip) and return the chosen entry's reference text
 * (`id;alias`). Merges the document's local catalog with the vault-global one
 * (local wins). When the catalog has no entries, offers to register a sample
 * with a generated id instead, as the sample view does (returning its
 * reference).
 */
export async function pickCatalogReference(
  env: SampleEnv,
  opts: { type: string; docPath: string; initialQuery?: string },
): Promise<string | undefined> {
  const { type, docPath, initialQuery } = opts;
  const localFolder = noteLabsamplesFolder(docPath, env.globalFolder());
  const globalFolder = env.globalFolder();

  const local = await loadCatalogSamples(env, localFolder, type);
  const global = globalFolder ? await loadCatalogSamples(env, globalFolder, type) : {};
  const merged: Record<string, SampleRecord> = { ...global, ...local };

  const items: PickItem<string>[] = Object.entries(merged).map(([id, rec]) => ({
    label: rec.alias ? `${id} — ${rec.alias}` : id,
    value: id,
    description: rec.descriptions?.[0],
  }));

  if (items.length === 0) {
    // The action is listed only when a catalog file exists (#99), so this is
    // an empty file or one removed since; ask before switching to creation.
    const ok = await env.host.confirm(
      env.t('No {0} catalog entries found (resources/labsamples/{0}_*.json). Create a new {0} sample instead?', type),
      { confirmLabel: env.t('Create sample') },
    );
    if (!ok) return undefined;
    const created = await createSampleInteractive(env, {
      type,
      folder: localFolder,
      mode: 'generate',
      scope: 'local',
      initial: initialQuery,
    });
    return created?.referenceText;
  }

  const chosen = await env.host.pick(items, {
    title: env.t('Search {0} catalog', type),
    placeholder: env.t('Search catalog'),
  });
  if (chosen === undefined) return undefined;
  return buildSampleReferenceText(chosen, merged[chosen]?.alias);
}
