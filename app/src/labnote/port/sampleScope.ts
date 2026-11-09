// Ported from app/vendor/labnoteo/src/sampleActions.ts:67-133 sha256:5f0e141122d7bf4d
// Ported from app/vendor/labnoteo/src/sampleActions.ts:1259-1300 sha256:62bfb89151155931
// labnoteO 0.138.0, Apache-2.0.
// Changes: App/LabnotePlugin → SampleEnv (D5); plugin.settings.globalSampleFolder → env.globalFolder(), plugin.localSampleFolder() → env.localFolder(), plugin.fs → env.fs, plugin.settings.customSampleTypes → env.settings().customSampleTypes; validateDescription is exported (the create and edit flows import it). ScopedNote and notesInSampleScope come here, ahead of the rest of their range (Task 18), because updateSampleListTables needs them: they drop the editor map and ScopedNote.editor, since env.fs.read gives an open note's buffer (editorAwareFs) and env.processNote writes through it, and app.vault.getMarkdownFiles()/cachedRead become env.markdownFiles()/env.fs.read.
import { getSampleDisplayMeta, hasSampleDescriptionSeparator, sampleAliasProblem } from '@labnoteo/core/lib/sampleUtils';
import { loadReferenceSamplesByType, type SampleRecord } from '@labnoteo/core/lib/sampleStorage';
import { getExperimentDir } from '@labnoteo/core/lib/labnoteStructure';
import type { SampleEnv } from '../../samples/env';

export type SampleScope = 'local' | 'global';

/**
 * Resolve the vault-relative labsamples folder for a scope. Local is the active
 * note's experiment `resources/labsamples` (via {@link SampleEnv.localFolder},
 * which pins to the last opened experiment); Global is the settings folder.
 */
export function resolveScopeFolder(env: SampleEnv, scope: SampleScope): string {
  if (scope === 'global') return env.globalFolder();
  return env.localFolder();
}

/** Trim to a non-empty string or null. */
export function clean(value: string | undefined): string | null {
  return value && value.trim() ? value.trim() : null;
}

/**
 * Read a type's product catalogs from `folder`.
 *
 * Always goes through the vault's type list: a custom type name may hold `_`,
 * so `DNA_Lib.json` — the registry of the `DNA_Lib` type — would otherwise be
 * read as a `DNA` catalog.
 */
export function loadCatalogSamples(
  env: SampleEnv,
  folder: string,
  type: string,
  fileOf?: Record<string, string>,
): Promise<Record<string, SampleRecord>> {
  return loadReferenceSamplesByType(env.fs, folder, type, getSampleDisplayMeta(env.settings().customSampleTypes).types, fileOf);
}

/**
 * Block the characters that would split the alias in a note (#98) or that
 * Markdown reads as a tag, link, emphasis or code (#168).
 */
export function validateAlias(env: Pick<SampleEnv, 't'>): (value: string) => string | null {
  return (v) => {
    switch (sampleAliasProblem(v)) {
      case 'separator':
        return env.t(
          'An alias cannot contain ";" or ":", which separate the ID, alias and description in a note. Use "-" or "/" instead (e.g. 1-10).',
        );
      case 'markdown':
        return env.t(
          'An alias cannot contain #, [[, ]], ](, *, _ or `, which Markdown reads as a tag, link, emphasis or code. Use "-" or "/" instead.',
        );
      default:
        return null;
    }
  };
}

/** Block the character that would end the description in a note (#98). */
export function validateDescription(env: Pick<SampleEnv, 't'>): (value: string) => string | null {
  return (v) =>
    hasSampleDescriptionSeparator(v)
      ? env.t('A description cannot contain ";", which ends the description in a note. Use "," instead.')
      : null;
}

/** A note's text, from its open editor when it has one. */
export interface ScopedNote {
  path: string;
  text: string;
}

/**
 * The notes a sample in `folder` can be used from: its experiment for a Local
 * folder, the whole vault for the Global one. A note open for editing is read
 * from its editor so just-typed, unsaved text counts.
 */
export async function notesInSampleScope(
  env: SampleEnv,
  folder: string,
  opts: { outsideExperiments?: boolean } = {},
): Promise<ScopedNote[]> {
  const expDir = getExperimentDir(folder);
  const scopePrefix = expDir ? `${expDir}/` : undefined;
  const files = (await env.markdownFiles()).filter(
    (p) => !scopePrefix || p.startsWith(scopePrefix) || (opts.outsideExperiments === true && !getExperimentDir(p)),
  );

  const docs: ScopedNote[] = [];
  for (const path of files) {
    const text = await env.fs.read(path);
    docs.push({ path, text });
  }
  return docs;
}
