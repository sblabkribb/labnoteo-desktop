// Ported from app/vendor/labnoteo/src/sampleActions.ts:1459-1635 sha256:d5636a7fbccdc50f
// labnoteO 0.140.2, Apache-2.0.
// Changes: App/LabnotePlugin → SampleEnv (D5); plugin.t → env.t; new Notice(m[, ms]) → env.host.notify without the duration ('warn' for the refusal); confirmModal(app, m, label, opts) → env.host.confirm(m, { confirmLabel: label, ...opts }); plugin.fs → env.fs (safeRegistryFs over the recycle bin, D13); plugin.settings.globalSampleFolder → env.globalFolder(); plugin.refreshSampleViews() → env.changed([written registry]); processNoteThroughVault → env.processNote. deleteSampleInteractive refuses an unreadable (conflicted) registry with RegistryUnreadableError before the first question, so no table row is removed for a record that cannot be deleted. removeSampleListRows has no open-editor branch: ScopedNote has no editor (sampleScope.ts), and env.processNote re-plans on an open note's live buffer and applies the change as one transaction. planNotesInScope is exported for the change-type flow (Task 22).
import { buildSampleReferenceText, planSampleListRowRemoval } from '@labnoteo/core/lib/sampleUtils';
import {
  deleteSampleRecord,
  isSameSampleFolder,
  loadSamplesByType,
  noteLabsamplesFolder,
  type AliasRewriteEdit,
} from '@labnoteo/core/lib/sampleStorage';
import { getExperimentDir } from '@labnoteo/core/lib/labnoteStructure';
import { assertRegistryReadable, type SampleEnv } from '../../samples/env';
import { setSampleDiscardedInteractive } from './sampleEdit';
import { sampleListHeaders } from './sampleListTable';
import { heldNotesSentence, notesForSample, notesReferencingSample, type ScopedNote } from './sampleQuery';

const registryOf = (folder: string, type: string) => [`${folder}/${type}.json`];

/**
 * Confirm + delete a sample from its `{Type}.json`. Refuses when the body still
 * references the sample (the reference would resurrect a bare record on the next
 * edit); the user must remove it from the note first. Returns false when
 * cancelled or refused.
 */
export async function deleteSampleInteractive(
  env: SampleEnv,
  opts: { folder: string; type: string; id: string },
): Promise<boolean> {
  const { folder, type, id } = opts;
  // 읽히지 않는 대장(충돌 표시 등)은 묻기 전에 멈춘다: 표의 행만 지워지고 기록은 남는 일이 없게(D13).
  await assertRegistryReadable(env.fs, registryOf(folder, type)[0]);

  // A row of a sample list table is no use (#385): the sample can go, with its rows.
  const usages = await notesReferencingSample(env, folder, type, id, { maskSampleLists: true });
  const listedIn = usages.length > 0 ? [] : await notesReferencingSample(env, folder, type, id);
  if (usages.length > 0) {
    // Full vault paths: notes in different experiments often share a name (#66).
    const shown = usages.slice(0, 3).join(', ');
    const list = usages.length > 3 ? env.t('{0} (+{1} more)', shown, String(usages.length - 3)) : shown;
    const refused = env.t('{0} is still used in notes ({1}). Remove it from the note(s) first, then delete.', id, list);
    const record = (await loadSamplesByType(env.fs, folder, type))[id];
    if (!record || record.discarded) {
      env.host.notify('warn', refused);
      return false;
    }
    // A used-up sample those notes still name is better kept and marked (#158).
    const discard = await env.host.confirm(
      `${refused}

${env.t('To keep it for those notes but show it as used up, mark it discarded instead.')}`,
      { confirmLabel: env.t('Mark as discarded') },
    );
    if (discard) await setSampleDiscardedInteractive(env, { folder, type, id, discarded: true });
    return false;
  }

  const listed =
    listedIn.length === 0
      ? ''
      : env.t(
          '{0} is only listed in the sample list tables of notes ({1}). Its rows are removed with it.',
          id,
          listedIn.length > 3
            ? env.t('{0} (+{1} more)', listedIn.slice(0, 3).join(', '), String(listedIn.length - 3))
            : listedIn.join(', '),
        );
  const heldListed =
    listedIn.length === 0
      ? 0
      : (await notesForSample(env, opts, { write: true })).held.filter((n) => listedIn.includes(n.path)).length;
  // Similar samples differ by these, not by their long IDs (#391).
  const record = (await loadSamplesByType(env.fs, folder, type))[id];
  const scope = isSameSampleFolder(folder, env.globalFolder()) ? env.t('Global') : env.t('Local');
  const facts = [
    [env.t('Alias'), record?.alias],
    [env.t('Description'), record?.descriptions?.[0]],
    [env.t('Location'), record?.location],
    [env.t('Scope'), scope],
    [env.t('Discarded'), record?.discarded],
  ]
    .filter(([, v]) => v?.trim())
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  const ok = await env.host.confirm(
    [env.t('Are you sure you want to delete {0}?', id), facts, listed, heldListed > 0 ? heldNotesSentence(env, heldListed) : '']
      .filter(Boolean)
      .join('\n\n'),
    { confirmLabel: env.t('Delete'), destructive: true },
  );
  if (!ok) return false;

  // Rows go first: they are read against the record still in the registry.
  if (listedIn.length > 0) await removeSampleListRows(env, { folder, type, id });
  await deleteSampleRecord(env.fs, folder, type, id);
  env.changed(registryOf(folder, type));
  const deleted = env.t('Sample deleted: {0}', buildSampleReferenceText(id, record?.alias));
  // Ctrl+Z brings the rows back but not the record, leaving an ID the registry lacks (#503).
  const undo = env.t('Ctrl+Z only brings back the table rows, not the sample record. To undo, add the sample again.');
  env.host.notify('info', listedIn.length > 0 ? `${deleted} ${undo}` : deleted);
  return true;
}

/**
 * Delete the rows of sample `(type, id)` of `folder` from the sample list
 * tables of its notes (#385), as {@link updateSampleListTables} goes through
 * them: a Global sample is skipped in experiments with a Local record of the
 * same id. Returns how many notes changed.
 */
async function removeSampleListRows(env: SampleEnv, opts: { folder: string; type: string; id: string }): Promise<number> {
  const { folder, type, id } = opts;
  const headers = sampleListHeaders(env);
  const isGlobal = isSameSampleFolder(folder, env.globalFolder());
  const shadowed = new Map<string, boolean>();
  const apply = (content: string): string =>
    planSampleListRowRemoval(content, headers, id).reduceRight(
      (out, e) => out.slice(0, e.start) + e.text + out.slice(e.end),
      content,
    );
  let removed = 0;
  const { notes } = await notesForSample(env, opts, { write: true });
  for (const note of notes) {
    if (planSampleListRowRemoval(note.text, headers, id).length === 0) continue;
    if (isGlobal) {
      const local = noteLabsamplesFolder(note.path, env.globalFolder());
      if (!isSameSampleFolder(local, folder)) {
        if (!shadowed.has(local)) {
          shadowed.set(local, Boolean((await loadSamplesByType(env.fs, local, type))[id]));
        }
        if (shadowed.get(local)) continue;
      }
    }
    // Re-planned on the live text (an open note's buffer), as one transaction.
    if (await env.processNote(note.path, apply)) removed++;
  }
  return removed;
}

/**
 * The notes in `folder`'s scope that `plan` would change. A Global sample is
 * skipped in experiments with a Local record of the same id, since their notes
 * resolve to that one.
 */
export async function planNotesInScope(
  env: SampleEnv,
  opts: { folder: string; type: string; id: string },
  plan: (text: string) => AliasRewriteEdit[],
): Promise<{ planned: Array<ScopedNote & { edits: AliasRewriteEdit[] }>; held: number }> {
  const { folder, type, id } = opts;
  const isGlobal = !getExperimentDir(folder);
  const shadowed = new Map<string, boolean>();
  const planned: Array<ScopedNote & { edits: AliasRewriteEdit[] }> = [];
  const { notes, held } = await notesForSample(env, opts, { write: true });
  for (const note of notes) {
    const edits = plan(note.text);
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
  return { planned, held: held.filter((n) => plan(n.text).length > 0).length };
}
