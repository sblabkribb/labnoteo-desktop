// Ported from app/vendor/labnoteo/src/settings.ts:160-282 sha256:099bf36883043c7c
// labnoteO 0.138.0, Apache-2.0.
// Changes: none beyond imports from @labnoteo/core, and invalidFolderText's parameter `t` is renamed `translate` (as in bilingualName.ts) so the app's i18n catalog test does not take the plugin's l10n keys for app catalog keys.
import type { Translator } from '@labnoteo/core';
import type { InvalidFolderReason } from '@labnoteo/core/lib/regexUtils';
import {
  isValidSampleTypeName,
  SAMPLE_TYPES,
  suggestSampleTypeName,
  underscoreTurnsItalic,
} from '@labnoteo/core/lib/sampleUtils';

/** Why a folder path was refused (#328), as one sentence. */
export function invalidFolderText(translate: Translator, reason: InvalidFolderReason): string {
  switch (reason.kind) {
    case 'empty':
      return translate('The folder path is empty.');
    case 'chars':
      return translate('Folder names cannot contain {0}.', reason.chars);
    case 'parent':
      return translate('A folder path cannot have an empty part (//), or a . or .. part.');
    case 'trailing':
      return translate('"{0}" ends in a dot or a space, which Windows does not allow.', reason.part);
    case 'reserved':
      return translate('"{0}" is a name Windows keeps for devices.', reason.part);
  }
}

/** {@link partitionCustomSampleTypes} result. */
export interface CustomSampleTypesInput {
  /** What to store: valid names, plus invalid ones that were already stored. */
  save: string[];
  /** Newly typed names autocompletion cannot read, with a name that works. */
  rejected: { name: string; suggestion: string }[];
  /** Invalid names kept from before, so their `{Type}.json` and ids stay linked. */
  legacyInvalid: string[];
  /** Newly typed names whose `_` the reading view turns into italics (#252). */
  italic: { name: string; suggestion: string }[];
  /** Such names kept from before, so their samples stay linked. */
  legacyItalic: string[];
  /** Newly typed names that differ from a built-in or earlier type only in case. */
  caseDuplicates: { name: string; clashesWith: string }[];
  /** Such names kept from before, so their samples stay linked. */
  legacyCaseDuplicates: { name: string; clashesWith: string }[];
  /** Stored names typed again in another letter case; the stored spelling is kept (#497). */
  caseRenamed: { name: string; stored: string }[];
}

/**
 * Split the comma-separated "Custom sample types" field (#81). A name that
 * autocompletion cannot read is not stored when newly typed; one stored by an
 * older release is kept, because renaming it would orphan its `{Type}.json`
 * and every id written with it.
 *
 * Names that differ only in case (`dna` next to the built-in `DNA`) are
 * refused the same way (#222): on a case-insensitive file system both types
 * read and write the one `dna.json`, and their samples mix. So is a name
 * whose `_` the reading view turns into italics (#252). A stored name typed in
 * another case (`CellLine` → `cellline`) keeps its stored spelling (#497): its
 * samples and the ids already written in notes carry that spelling.
 */
export function partitionCustomSampleTypes(
  input: string,
  previouslySaved: readonly string[]
): CustomSampleTypesInput {
  const out: CustomSampleTypesInput = {
    save: [],
    rejected: [],
    legacyInvalid: [],
    italic: [],
    legacyItalic: [],
    caseDuplicates: [],
    legacyCaseDuplicates: [],
    caseRenamed: [],
  };
  const taken = new Map<string, string>(SAMPLE_TYPES.map(t => [t.toLowerCase(), t]));
  const names = input
    .split(',')
    .map(x => x.trim())
    .filter(Boolean);
  for (const typed of names) {
    const stored = previouslySaved.includes(typed)
      ? undefined
      : previouslySaved.find(p => p.toLowerCase() === typed.toLowerCase());
    if (stored !== undefined) out.caseRenamed.push({ name: typed, stored });
    const name = stored ?? typed;
    if (stored !== undefined && out.save.includes(stored)) continue;
    const clashesWith = taken.get(name.toLowerCase());
    if (clashesWith !== undefined && clashesWith !== name) {
      const clash = { name, clashesWith };
      if (previouslySaved.includes(name)) {
        out.save.push(name);
        out.legacyCaseDuplicates.push(clash);
      } else {
        out.caseDuplicates.push(clash);
      }
      continue;
    }
    taken.set(name.toLowerCase(), name);
    const readable = isValidSampleTypeName(name);
    if (readable && !underscoreTurnsItalic(name)) {
      out.save.push(name);
    } else if (previouslySaved.includes(name)) {
      out.save.push(name);
      (readable ? out.legacyItalic : out.legacyInvalid).push(name);
    } else {
      (readable ? out.italic : out.rejected).push({ name, suggestion: suggestSampleTypeName(name) });
    }
  }
  return out;
}

/**
 * Custom sample types in `before` that `after` dropped (#137): the samples of
 * such a type stop showing. A change of case and a built-in name do not count,
 * since those types stay shown.
 */
export function removedCustomSampleTypes(before: readonly string[], after: readonly string[]): string[] {
  const kept = new Set([...after, ...SAMPLE_TYPES].map(t => t.toLowerCase()));
  return [...new Set(before)].filter(t => !kept.has(t.toLowerCase()));
}

/** Samples in the given `{Type}.json` texts (#137); an empty or broken file counts as none. */
export function countSampleRecords(jsonTexts: readonly string[]): number {
  let count = 0;
  for (const text of jsonTexts) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) count += Object.keys(parsed).length;
    } catch {
      // Not counted.
    }
  }
  return count;
}
