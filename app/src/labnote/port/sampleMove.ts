// Ported from app/vendor/labnoteo/src/sampleActions.ts:1617-1812 sha256:137eabce6c61d0e2
// labnoteO 0.138.0, Apache-2.0.
// Changes: App/LabnotePlugin → SampleEnv (D5); plugin.t → env.t; new Notice(m[, ms]) → env.host.notify('info', m) without the duration ('warn' for 'Sample not found' and the two move refusals); pickModal(app, items, opts) → env.host.pick(items, opts); confirmModal(app, m, label, opts) → env.host.confirm(m, { confirmLabel: label, ...opts }); plugin.fs → env.fs (safeRegistryFs, D13); plugin.settings.customSampleTypes → env.settings().customSampleTypes; plugin.settings.globalSampleFolder → env.globalFolder(); plugin.refreshSampleViews() → env.changed([written registries]); processNoteThroughVault → env.processNote. Both flows refuse an unreadable (conflicted) registry with RegistryUnreadableError: the source registry before the first question, the destination registry (folder/newType.json, or toFolder/type.json) before the confirmation, so no note is rewritten and no record is deleted for a write that would be refused. The open-editor branch of changeSampleTypeInteractive is folded into env.processNote, which re-plans on an open note's live buffer and applies the change as one transaction (one undo step per note); ScopedNote has no editor (sampleScope.ts). planNotesInScope comes from sampleDelete.ts and storedAlias from sampleCreate.ts. changeSampleTypeInteractive skips a note whose env.processNote rejects with NoteBusyError (an open note that is saving or composing), rewrites the rest, names the skipped notes in the final notice (app key samples.busySkipped), and calls env.changed in a finally, so the views refresh even when the loop stops.
import { generateSampleId, getSampleDisplayMeta } from '@labnoteo/core/lib/sampleUtils';
import {
  applyAliasRewrite,
  deleteSampleRecord,
  isSameSampleFolder,
  loadSamplesByType,
  noteLabsamplesFolder,
  planSampleIdRewrite,
  putSampleRecord,
  sampleIdForType,
  samplesWithAliasIn,
  type AliasRewriteEdit,
} from '@labnoteo/core/lib/sampleStorage';
import { getExperimentDir } from '@labnoteo/core/lib/labnoteStructure';
import { t as appT } from '../../i18n/t';
import { NoteBusyError } from '../noteErrors';
import { assertRegistryReadable, type SampleEnv } from '../../samples/env';
import { storedAlias } from './sampleCreate';
import { planNotesInScope } from './sampleDelete';
import { updateSampleListTables } from './sampleListTable';
import { heldNotesSentence, notesReferencingSample } from './sampleQuery';
import type { SampleScope } from './sampleScope';

/**
 * Change a sample's type (#116): pick the new type, give the record the same
 * numbers under the new prefix (a new id when that one is taken), and rewrite
 * the notes that use it. One confirmation covers both, and declining changes
 * nothing: a note left with the old id would bring the old record back the
 * next time it is saved. Returns false when cancelled.
 */
export async function changeSampleTypeInteractive(
  env: SampleEnv,
  opts: { folder: string; type: string; id: string },
): Promise<boolean> {
  const { folder, type, id } = opts;
  // 읽히지 않는 대장은 묻기 전에 멈춘다(D13).
  await assertRegistryReadable(env.fs, `${folder}/${type}.json`);
  const record = (await loadSamplesByType(env.fs, folder, type))[id];
  if (!record) {
    env.host.notify('warn', env.t('Sample not found: {0}', id));
    return false;
  }
  const types = getSampleDisplayMeta(env.settings().customSampleTypes).types.filter((t) => t !== type);
  const newType = await env.host.pick(
    types.map((t) => ({ label: t, value: t })),
    { title: env.t('Change the type of {0}', id), placeholder: env.t('Pick the new type') },
  );
  if (newType === undefined) return false;
  // 새 종류의 대장이 읽히지 않으면 확인 전에 멈춘다: 노트를 고친 뒤 기록을 못 쓰는 일이 없게.
  await assertRegistryReadable(env.fs, `${folder}/${newType}.json`);

  const globalFolder = env.globalFolder();
  const taken = async (candidate: string): Promise<boolean> => {
    for (const f of [folder, globalFolder]) {
      if (f && (await loadSamplesByType(env.fs, f, newType))[candidate]) return true;
    }
    return false;
  };
  let newId = sampleIdForType(type, id, newType) ?? generateSampleId(newType);
  while (await taken(newId)) newId = generateSampleId(newType);

  const plan = (text: string): AliasRewriteEdit[] => planSampleIdRewrite(text, type, id, newType, newId);
  const { planned, held } = await planNotesInScope(env, opts, plan);
  const shownMax = 8;
  const lines = planned.slice(0, shownMax).map((n) => {
    const defs = n.edits.filter((e) => e.kind === 'definition').length;
    return `- ${n.path} (${env.t('{0} definition(s), {1} reference(s)', String(defs), String(n.edits.length - defs))})`;
  });
  if (planned.length > shownMax) lines.push(`(+${planned.length - shownMax})`);
  let message = env.t('Change {0} to {1}? Its record moves from {2}.json to {3}.json.', id, newId, type, newType);
  // The new type may already have a sample of this alias (#403).
  const twins = record.alias ? await samplesWithAliasIn(env.fs, folder, newType, record.alias) : [];
  if (twins.length > 0) {
    message += `\n\n${env.t('{0} samples already have the alias {1} ({2}).', newType, record.alias!, twins.join(', '))}`;
  }
  if (planned.length > 0) {
    message += `\n\n${env.t('The notes that use it change too ({0}):', String(planned.length))}\n${lines.join('\n')}`;
  }
  if (held > 0) message += `\n\n${heldNotesSentence(env, held)}`;
  if (!(await env.host.confirm(message, { confirmLabel: env.t('Change type') }))) return false;

  let updated = 0;
  const busy: string[] = [];
  try {
    await putSampleRecord(env.fs, folder, newType, newId, { ...record, type: newType });
    await deleteSampleRecord(env.fs, folder, type, id);
    for (const note of planned) {
      // Re-planned on the live text (an open note's buffer), as one transaction so one undo reverts the note.
      // A busy open note is skipped, not fatal: the record has already moved, so the other notes still need the new id.
      try {
        if (await env.processNote(note.path, (content) => applyAliasRewrite(content, plan(content)))) updated++;
      } catch (err) {
        if (!(err instanceof NoteBusyError)) throw err;
        busy.push(note.path);
      }
    }
  } finally {
    env.changed([`${folder}/${newType}.json`, `${folder}/${type}.json`]);
  }
  const done = env.t('Changed {0} to {1}.', id, newId);
  // Ctrl+Z reverts a note but not the record, leaving the old id unregistered (#151).
  const undo = env.t('Ctrl+Z only reverts the note, not the sample record. To undo, change the type again.');
  const skipped = busy.length > 0 ? appT('samples.busySkipped', String(busy.length), busy.join(', ')) : '';
  env.host.notify(
    'info',
    planned.length > 0
      ? [done, env.t('{0} note(s) updated.', String(updated)), skipped, undo].filter(Boolean).join(' ')
      : done,
  );
  return true;
}

/**
 * Move a sample record between the Local and Global scopes, preserving it
 * verbatim (all descriptions/sources). Writes the destination first, then
 * deletes the source, so a mid-way failure leaves a recoverable duplicate
 * rather than losing data. Returns false when nothing was moved (cancelled,
 * missing record, or same folder). Returns undefined never — always resolves.
 *
 * The source/target folders are passed in by the caller (the Samples sidebar
 * hands over exactly the folders its tree is currently showing) rather than
 * re-derived here from the active file. Deriving them again would let a change
 * of the active note between render and click send the sample into a different
 * experiment than the one the user is looking at.
 */
export async function moveSampleInteractive(
  env: SampleEnv,
  opts: { fromScope: SampleScope; fromFolder: string; toFolder: string; type: string; id: string },
): Promise<boolean> {
  const { fromScope, fromFolder: src, toFolder: tgt, type, id } = opts;

  // Empty-folder guard: an unresolved scope (no experiment rendered yet) yields
  // '' which would normalize to the vault root. Refuse rather than read/write
  // sample JSON at the root.
  if (!src || !tgt) {
    env.host.notify('warn', env.t('Open an experiment note first to move samples.'));
    return false;
  }

  // Same-folder guard (e.g. no experiment open so Local === Global): moving
  // would delete then re-create in place, or worse, silently no-op.
  if (isSameSampleFolder(src, tgt)) {
    env.host.notify(
      'warn',
      env.t('The open note is outside an experiment. Open a note of the experiment to move it to, then try again.'),
    );
    return false;
  }

  // 읽히지 않는 대장(원본, 목적지)은 묻기 전에 멈춘다(D13): 목적지를 못 쓰면 원본도 지우지 않는다.
  await assertRegistryReadable(env.fs, `${src}/${type}.json`);
  await assertRegistryReadable(env.fs, `${tgt}/${type}.json`);

  const srcDb = await loadSamplesByType(env.fs, src, type);
  const record = srcDb[id];
  if (!record) {
    env.host.notify('warn', env.t('Sample not found: {0}', id));
    return false;
  }

  // A Global sample may be used anywhere; notes that resolve their samples
  // from another folder lose it once it is Local to one experiment (#78).
  if (fromScope === 'global') {
    const outside = (await notesReferencingSample(env, src, type, id, { maskSampleLists: true })).filter(
      (p) => !isSameSampleFolder(noteLabsamplesFolder(p, env.globalFolder()), tgt),
    );
    if (outside.length > 0) {
      const shown = outside.slice(0, 3).join(', ');
      const list = outside.length > 3 ? env.t('{0} (+{1} more)', shown, String(outside.length - 3)) : shown;
      const ok = await env.host.confirm(
        env.t(
          '{0} is used in notes outside this experiment ({1}). Those notes will no longer find it after the move. Move anyway?',
          id,
          list,
        ),
        { confirmLabel: env.t('Move anyway'), destructive: true },
      );
      if (!ok) return false;
    }
  }

  // Confirm before clobbering a record that already exists in the destination.
  const tgtDb = await loadSamplesByType(env.fs, tgt, type);
  if (tgtDb[id]) {
    const ok = await env.host.confirm(env.t('{0} already exists in the destination. Overwrite it?', id), {
      confirmLabel: env.t('Overwrite'),
      destructive: true,
    });
    if (!ok) return false;
  }

  // Two samples with one alias show the same text in autocomplete (#299). Asked, not refused.
  const twins = record.alias
    ? (await samplesWithAliasIn(env.fs, tgt, type, record.alias)).filter((other) => other !== id)
    : [];
  if (twins.length > 0) {
    const toGlobal = isSameSampleFolder(tgt, env.globalFolder());
    const ok = await env.host.confirm(
      `${env.t(
        toGlobal ? 'Global samples already have the alias {0} ({1}).' : 'This experiment already has the alias {0} ({1}).',
        storedAlias(tgtDb, twins, record.alias!),
        twins.join(', '),
      )} ${env.t('Move {0} there anyway?', id)}`,
      { confirmLabel: env.t('Move anyway') },
    );
    if (!ok) return false;
  }

  await putSampleRecord(env.fs, tgt, type, id, record);
  await deleteSampleRecord(env.fs, src, type, id);
  env.changed([`${tgt}/${type}.json`, `${src}/${type}.json`]);
  // The experiment's tables list it with the other scope now.
  const experiment = getExperimentDir(tgt) ? tgt : src;
  const tables = await updateSampleListTables(env, { folder: tgt, type, id, notesOf: experiment });
  env.host.notify(
    'info',
    [
      env.t('Sample moved: {0}', id),
      tables > 0 ? env.t('Updated the sample list table in {0} note(s).', String(tables)) : '',
    ]
      .filter(Boolean)
      .join(' '),
  );
  return true;
}
