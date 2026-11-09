// Ported from app/vendor/labnoteo/src/sampleActions.ts:899-1009 sha256:574feb04650a0f7a
// Ported from app/vendor/labnoteo/src/sampleActions.ts:1029-1075 sha256:0f5f71b2947392f8
// Ported from app/vendor/labnoteo/src/sampleActions.ts:1348-1437 sha256:5a5e731b8052d094
// labnoteO 0.138.0, Apache-2.0.
// Changes: App/LabnotePlugin → SampleEnv (D5); plugin.t → env.t; new Notice(m[, ms]) → env.host.notify('info', m) without the duration ('warn' for 'Sample not found'); promptModal/confirmModal(app, …, label, opts) → env.host.prompt/confirm(…, { confirmLabel: label, ...opts }); plugin.host.pick → env.host.pick; plugin.fs → env.fs; plugin.settings.globalSampleFolder → env.globalFolder(); plugin.refreshSampleViews() → env.changed([written registry]); plugin.host.editTarget() → env.editTarget(); processNoteThroughVault → env.processNote. editSampleInteractive refuses an unreadable (conflicted) registry with RegistryUnreadableError before the first prompt, as the create flow does. The reading-view branch of the definition sync is dropped: the app has no reading view, so the active note's definition is replaced through its edit target (one undo step). rewriteStaleAliases has no open-editor branch: ScopedNote has no editor (sampleScope.ts), and env.processNote re-plans on an open note's live buffer and applies the change as one transaction (one undo step per note). otherExperimentsWithSample (1011-1027) was ported ahead in sampleQuery.ts (Task 18) and is imported from there.
import { buildSampleDefinitionText, sampleAliasProblem } from '@labnoteo/core/lib/sampleUtils';
import {
  applyAliasRewrite,
  findSampleDefinitionMatch,
  isSameSampleFolder,
  loadSamplesByType,
  noteLabsamplesFolder,
  planAliasRewrite,
  setSampleDiscarded,
  upsertSampleRecord,
  type AliasRewriteEdit,
  type SampleRecord,
} from '@labnoteo/core/lib/sampleStorage';
import { getExperimentDir } from '@labnoteo/core/lib/labnoteStructure';
import { getSeoulDateString } from '@labnoteo/core/lib/dateUtils';
import { assertRegistryReadable, type SampleEnv } from '../../samples/env';
import { confirmAliasClash, confirmLocationClash } from './sampleCreate';
import { sampleListHeaders, updateSampleListTables } from './sampleListTable';
import { heldNotesSentence, notesForSample, otherExperimentsWithSample, type ScopedNote } from './sampleQuery';
import { clean, validateAlias, validateDescription } from './sampleScope';

const registryOf = (folder: string, type: string) => [`${folder}/${type}.json`];

/**
 * Interactively edit a sample's alias/description (prefilled), persist to JSON,
 * and best-effort update the `@type;` definition in the active note if present
 * so the document and JSON do not diverge. Returns false when cancelled.
 */
export async function editSampleInteractive(
  env: SampleEnv,
  opts: { folder: string; type: string; id: string; record: SampleRecord },
): Promise<boolean> {
  const { folder, type, id, record } = opts;
  // 고칠 대장이 충돌 표시 등으로 읽히지 않으면 묻기 전에 멈춘다: 친 글이 저장되지 못하고 사라지지 않게(D13).
  await assertRegistryReadable(env.fs, registryOf(folder, type)[0]);

  const aliasRaw = await env.host.prompt({
    title: env.t('Enter a new alias'),
    value: record.alias ?? '',
    placeholder: env.t('e.g. Sample-A'),
    // An alias registered before #168 may keep its Markdown characters.
    validate: (v) =>
      v.trim() === (record.alias ?? '').trim() && sampleAliasProblem(v) === 'markdown' ? null : validateAlias(env)(v),
  });
  if (aliasRaw === undefined) return false;
  if (!(await confirmAliasClash(env, { folder, type, id, alias: clean(aliasRaw), before: record.alias }))) {
    return false;
  }
  const descRaw = await env.host.prompt({
    title: env.t('Enter a new description'),
    value: record.descriptions?.[0] ?? '',
    placeholder: env.t('e.g. Sample used in experiment 1'),
    validate: validateDescription(env),
  });
  if (descRaw === undefined) return false;
  const locationRaw = await env.host.prompt({
    title: env.t('Enter a storage location (optional)'),
    value: record.location ?? '',
    placeholder: env.t('e.g. Freezer-2 / Box-3 / A1'),
  });
  if (locationRaw === undefined) return false;

  const alias = clean(aliasRaw);
  const description = clean(descRaw);
  const location = clean(locationRaw);
  if (!(await confirmLocationClash(env, { folder, id, location, before: record.location }))) return false;
  // An emptied field is easy to submit by accident and nothing brings it back (#471).
  const oldDescription = record.descriptions?.[0]?.trim();
  const clearing = [
    record.alias?.trim() && !alias ? env.t("the alias '{0}'", record.alias.trim()) : '',
    oldDescription && !description ? env.t("the first description '{0}'", oldDescription) : '',
  ].filter(Boolean);
  if (
    clearing.length > 0 &&
    !(await env.host.confirm(
      env.t('Remove {0} of {1}? The sample list tables and the sample view lose it too.', clearing.join(env.t(' and ')), id),
      { confirmLabel: env.t('Remove'), destructive: true },
    ))
  ) {
    return false;
  }
  await upsertSampleRecord(env.fs, folder, type, id, { alias, description, location });
  env.changed(registryOf(folder, type));

  // Best-effort: keep the active note's `@type;` definition in sync (single
  // file only). Plain `id;alias` references are left as written.
  const target = env.editTarget();
  if (target) {
    const text = await target.getText();
    const match = findSampleDefinitionMatch(text, type, id, record.alias ?? null);
    if (match) {
      await target.replaceRange(match.start, match.start + match.length, buildSampleDefinitionText(type, id, alias, description));
    }
  }

  const tables = await updateSampleListTables(env, { folder, type, id });
  const tablesNote = tables > 0 ? env.t('Updated the sample list table in {0} note(s).', String(tables)) : undefined;
  const oldAlias = record.alias?.trim() ?? '';
  // From no alias to one, bare-id references can show it too (#170).
  const rewritten =
    oldAlias !== (alias ?? '')
      ? await rewriteStaleAliases(env, { folder, type, id, oldAlias, newAlias: alias ?? '', tablesNote })
      : undefined;
  const copies = await otherExperimentsWithSample(env, folder, type, id);
  const elsewhere =
    copies.length > 0
      ? env.t('{0} is also registered in other experiments ({1}); only this one changed.', id, copies.join(', '))
      : undefined;
  env.host.notify('info', [env.t('Sample updated: {0}', id), tablesNote, rewritten, elsewhere].filter(Boolean).join(' '));
  return true;
}

/**
 * Mark a sample discarded today, or in use again with `discarded: false`
 * (#158). The record stays, so the notes that use it keep resolving it. A
 * stored location is asked about (#458): emptied, it is kept aside and comes
 * back when the mark is taken off. Dismissing the question keeps it.
 */
export async function setSampleDiscardedInteractive(
  env: SampleEnv,
  opts: { folder: string; type: string; id: string; discarded: boolean },
): Promise<boolean> {
  const { folder, type, id, discarded } = opts;
  const location = discarded ? (await loadSamplesByType(env.fs, folder, type))[id]?.location : undefined;
  // Three answers, so dismissing the question does not discard the sample (#524).
  const clearLocation = location
    ? await env.host.pick<boolean | null>(
        [
          {
            label: env.t('Empty location and mark discarded'),
            value: true,
            description: env.t('The old location is kept and comes back if you unmark it.'),
          },
          { label: env.t('Keep location and mark discarded'), value: false },
          { label: env.t('Cancel'), value: null },
        ],
        { title: env.t('{0} is stored at {1}. Mark it discarded?', id, location) },
      )
    : false;
  if (clearLocation === undefined || clearLocation === null) return false;
  const found = await setSampleDiscarded(env.fs, folder, type, id, discarded ? getSeoulDateString() : null, {
    clearLocation,
  });
  if (!found) {
    env.host.notify('warn', env.t('Sample not found: {0}', id));
    return false;
  }
  env.changed(registryOf(folder, type));
  const tables = await updateSampleListTables(env, { folder, type, id });
  env.host.notify(
    'info',
    [
      discarded ? env.t('Marked {0} as discarded.', id) : env.t('{0} is no longer marked discarded.', id),
      tables > 0 ? env.t('Updated the sample list table in {0} note(s).', String(tables)) : '',
    ]
      .filter(Boolean)
      .join(' '),
  );
  return true;
}

/**
 * After an alias edit, offer to replace `oldAlias` in the notes that still
 * show it (#86), or — when there was none — to add the new alias to the
 * references that are the bare id (#170). A Global sample is skipped in experiments that have a Local
 * record with the same id, since their notes resolve to that one. Returns the
 * sentence to add to the "Sample updated" notice, if any.
 */
async function rewriteStaleAliases(
  env: SampleEnv,
  opts: { folder: string; type: string; id: string; oldAlias: string; newAlias: string; tablesNote?: string },
): Promise<string | undefined> {
  const { folder, type, id, oldAlias, newAlias } = opts;
  const isGlobal = !getExperimentDir(folder);
  const shadowed = new Map<string, boolean>();
  const planned: Array<ScopedNote & { edits: AliasRewriteEdit[] }> = [];
  const { notes, held } = await notesForSample(env, { folder, type, id }, { write: true });
  const heldCount = held.filter(
    (n) => planAliasRewrite(n.text, type, id, oldAlias, newAlias, sampleListHeaders(env)).length > 0,
  ).length;
  const heldNote = heldCount > 0 ? heldNotesSentence(env, heldCount) : '';
  for (const note of notes) {
    const edits = planAliasRewrite(note.text, type, id, oldAlias, newAlias, sampleListHeaders(env));
    if (edits.length === 0) continue;
    if (isGlobal) {
      const local = noteLabsamplesFolder(note.path, env.globalFolder());
      if (!isSameSampleFolder(local, folder)) {
        if (!shadowed.has(local)) {
          shadowed.set(local, Boolean((await loadSamplesByType(env.fs, local, type))[id]));
        }
        if (shadowed.get(local)) continue;
      }
    }
    planned.push({ ...note, edits });
  }
  if (planned.length === 0) return heldNote || undefined;

  const shownMax = 8;
  const lines = planned.slice(0, shownMax).map((n) => {
    const defs = n.edits.filter((e) => e.kind === 'definition').length;
    return `- ${n.path} (${env.t('{0} definition(s), {1} reference(s)', String(defs), String(n.edits.length - defs))})`;
  });
  if (planned.length > shownMax) lines.push(`(+${planned.length - shownMax})`);
  if (opts.tablesNote) lines.push('', opts.tablesNote);
  if (heldNote) lines.push('', heldNote);
  const count = String(planned.length);
  const ok = await env.host.confirm(
    !oldAlias
      ? env.t("Add the alias '{1}' to the references that show only the ID {2} in {0} note(s)?\n\n{3}", count, newAlias, id, lines.join('\n'))
      : newAlias
        ? env.t("Replace the old alias '{1}' with '{2}' in {0} note(s)?\n\n{3}", count, oldAlias, newAlias, lines.join('\n'))
        : env.t("Remove the old alias '{1}' from {0} note(s)?\n\n{2}", count, oldAlias, lines.join('\n')),
    { confirmLabel: env.t('Replace'), destructive: true },
  );
  if (!oldAlias && !ok) return undefined;
  if (!ok) {
    const stale = env.t('{0} note(s) still show the old alias.', count);
    return planned.some((n) => n.edits.some((e) => e.kind === 'definition'))
      ? `${stale} ${env.t('Saving a note that defines it may bring the old alias back.')}`
      : stale;
  }

  let updated = 0;
  for (const note of planned) {
    // Re-planned on the live text (an open note's buffer: the user may have
    // typed meanwhile), as one transaction so a single undo reverts the note.
    if (
      await env.processNote(note.path, (content) =>
        applyAliasRewrite(content, planAliasRewrite(content, type, id, oldAlias, newAlias, sampleListHeaders(env))),
      )
    ) {
      updated++;
    }
  }
  return env.t('{0} note(s) updated.', String(updated));
}
