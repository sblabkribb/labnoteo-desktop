// Ported from app/vendor/labnoteo/src/sampleActions.ts:304-413 sha256:6033c8282f547cb1
// labnoteO 0.138.0, Apache-2.0.
// Changes: App/LabnotePlugin → SampleEnv (D5); processNoteThroughVault → env.processNote; plugin.fs → env.fs; plugin.settings.globalSampleFolder → env.globalFolder(). The open-editor branch of updateSampleListTables is folded into env.processNote, which applies the change to an open note's buffer as one minimal edit (openNotes.ts), so ScopedNote has no editor. sampleListRow, updateSampleListTables and listSome are exported for the create, sync, edit and delete ports.
import { buildSampleReferenceText, planSampleListRowUpdate } from '@labnoteo/core/lib/sampleUtils';
import {
  isSameSampleFolder,
  loadSamplesByType,
  noteLabsamplesFolder,
  type SampleInfo,
  type SampleRecord,
} from '@labnoteo/core/lib/sampleStorage';
import obsidianKo from '../../../vendor/labnoteo/src/l10n.ko';
import type { SampleEnv } from '../../samples/env';
import { notesInSampleScope, type SampleScope } from './sampleScope';

const SAMPLE_LIST_HEADERS = ['ID', 'Alias', 'Description', 'Location', 'Scope', 'Discarded'];

/**
 * The header of a sample list table in the UI language, then in Korean and
 * English, so a table inserted before the UI language changed is still known.
 */
export function sampleListHeaders(env: Pick<SampleEnv, 't'>): string[][] {
  const sets = [
    SAMPLE_LIST_HEADERS.map((h) => env.t(h)),
    SAMPLE_LIST_HEADERS.map((h) => (obsidianKo as Record<string, string>)[h] ?? h),
    SAMPLE_LIST_HEADERS,
  ];
  return sets.filter((set, i) => sets.findIndex((other) => other.join('\u0000') === set.join('\u0000')) === i);
}

/**
 * A sample's storage location as shown to the researcher: the stored one, or
 * the one emptied when it was discarded (#458), marked as such.
 */
export function sampleLocationText(env: Pick<SampleEnv, 't'>, rec: SampleRecord): string {
  if (rec.location) return rec.location;
  return rec.discardedLocation ? env.t('(emptied, was {0})', rec.discardedLocation) : '';
}

/** A sample's row in a sample list table, in {@link SAMPLE_LIST_HEADERS} order. */
export function sampleListRow(env: Pick<SampleEnv, 't'>, id: string, rec: SampleRecord, scope: SampleScope): string[] {
  return [
    id,
    rec.alias ?? '',
    // A location splits its cell with ` / `, so descriptions use `; ` (#462).
    (rec.descriptions ?? []).join('; '),
    sampleLocationText(env, rec),
    env.t(scope === 'local' ? 'Local' : 'Global'),
    rec.discarded ?? '',
  ];
}

/**
 * Bring the rows of sample `(type, id)` of `folder` in the sample list tables
 * of its notes up to the registry (#336): the table is written from it, so it
 * follows it like a definition does. A Global sample is skipped in experiments
 * with a Local record of the same id, which the table lists instead.
 * `notesOf` is the folder whose notes are read, `folder` by default. Returns
 * how many notes changed.
 */
export async function updateSampleListTables(
  env: SampleEnv,
  opts: { folder: string; type: string; id: string; notesOf?: string },
): Promise<number> {
  const { folder, type, id } = opts;
  const record = (await loadSamplesByType(env.fs, folder, type))[id];
  if (!record) return 0;
  const isGlobal = isSameSampleFolder(folder, env.globalFolder());
  const cells = sampleListRow(env, id, record, isGlobal ? 'global' : 'local');
  const headers = sampleListHeaders(env);
  const shadowed = new Map<string, boolean>();
  let updated = 0;
  for (const note of await notesInSampleScope(env, opts.notesOf ?? folder)) {
    if (planSampleListRowUpdate(note.text, headers, id, cells).length === 0) continue;
    if (isGlobal) {
      const local = noteLabsamplesFolder(note.path, env.globalFolder());
      if (!isSameSampleFolder(local, folder)) {
        if (!shadowed.has(local)) {
          shadowed.set(local, Boolean((await loadSamplesByType(env.fs, local, type))[id]));
        }
        if (shadowed.get(local)) continue;
      }
    }
    if (
      await env.processNote(note.path, (content) =>
        planSampleListRowUpdate(content, headers, id, cells).reduceRight(
          (out, e) => out.slice(0, e.start) + e.text + out.slice(e.end),
          content,
        ),
      )
    ) {
      updated++;
    }
  }
  return updated;
}

/**
 * The references of `references` whose ID is not in `known` (lower-cased),
 * once each, as `ID;alias` (#238).
 */
export function unregisteredReferences(references: readonly SampleInfo[], known: ReadonlySet<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of references) {
    const key = s.id.toLowerCase();
    if (known.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(buildSampleReferenceText(s.id, s.alias));
  }
  return out;
}

export function listSome(items: readonly string[], max = 5): string {
  return items.length > max ? `${items.slice(0, max).join(', ')}, …` : items.join(', ');
}
