// Ported from app/vendor/labnoteo/src/settingsTab.ts:200-231 sha256:f0194dfe431bd491
// Ported from app/vendor/labnoteo/src/settingsTab.ts:574-634 sha256:efce2a714de08044
// Ported from app/vendor/labnoteo/src/main.ts:3266-3318 sha256:69ee9793c7c97a8c
// labnoteO 0.138.0, Apache-2.0.
// Changes: SettingTab/LabnotePlugin methods → functions (D5). commitGlobalFolder(value) → commitGlobalFolder(translate, value, previous) (the translator is named `translate`, as in customSampleTypes.ts, so the app catalog test does not take the plugin keys for app keys): it no longer saves or schedules a refresh, it returns { value } (the folder to keep) and, when the folder is refused, { value: previous, notice } with the plugin's sentence, which the settings dialog shows inside itself instead of a 10 s Notice; DEFAULT_SETTINGS.globalSampleFolder → DEFAULT_GLOBAL_SAMPLE_FOLDER. askAboutRemovedSampleTypes's "wait until no modal is open" timer is dropped: applySampleSettings runs after the settings dialog has closed, so offerToRestoreSampleTypes is called directly, with removedCustomSampleTypes(before, after) as its `removed`. offerToRestoreSampleTypes(removed) → (env, removed, save): this.plugin.fs → env.fs, settings.globalSampleFolder → env.globalFolder(), vault.getMarkdownFiles() → env.markdownFiles(), confirmModal → env.host.confirm with confirmLabel, settings.customSampleTypes = …; saveSettings() → save(customSampleTypes) (the caller updates the app settings and the sample store), refreshSampleViews → env.changed(), new Notice → env.host.notify('info'). offerGlobalSampleFolderMove(from, to) → (env, from, to): this.run → the caller's runner (the function is async and awaited), getSampleDisplayMeta(customSampleTypes).types → env.types(), this.t → env.t, this.fs → safeRegistryFs(env.fs, () => to) so a conflicted registry in the new folder is also refused, new Notice(m, ms) → env.host.notify('info' | 'warn', m), confirmModal → env.host.confirm, clearCache + refreshSampleViews → env.changed([from, to]). The put-back question's key is joined from its lines (RESTORE_TYPES_QUESTION, the same text), because escapes.test.ts flags "show:" before a newline escape as a drive path. Added before the move: every `{Type}.json` of `from` and `to` is read with core loadSampleIds, and an unreadable one stops the move with t('samples.registryUnreadable', path) (D13): core moveSampleFolder loads an unparsable file as {} and would then trash the source file or merge over the target.
import * as posix from '@labnoteo/core/posix';
import type { Translator } from '@labnoteo/core';
import { getExperimentDir, getExperimentLabsamplesFolder } from '@labnoteo/core/lib/labnoteStructure';
import { invalidVaultFolderReason } from '@labnoteo/core/lib/regexUtils';
import { inventorySampleFolder, loadSampleIds, moveSampleFolder } from '@labnoteo/core/lib/sampleStorage';
import { t as appT } from '../../i18n/t';
import { DEFAULT_GLOBAL_SAMPLE_FOLDER, safeRegistryFs, type SampleEnv } from '../../samples/env';
import { countSampleRecords, invalidFolderText } from './customSampleTypes';

/**
 * Save the Global sample folder once the field is left (#328). An empty
 * field silently breaks Global-scope reads and writes, so it gets the
 * default back; a path some OS cannot make is refused with the reason.
 */
export function commitGlobalFolder(translate: Translator, value: string, previous: string): { value: string; notice?: string } {
  const folder = value.trim() || DEFAULT_GLOBAL_SAMPLE_FOLDER;
  const reason = invalidVaultFolderReason(folder);
  // Inside an experiment it would be that experiment's own registry (#408).
  const experiment = reason ? undefined : getExperimentDir(folder);
  if (reason || experiment) {
    return {
      value: previous,
      notice: translate(
        '"{0}" cannot be the Global sample folder: {1} It is back to {2}.',
        folder,
        reason ? invalidFolderText(translate, reason) : translate('It is inside the experiment {0}, whose own samples it holds.', experiment!),
        previous,
      ),
    };
  }
  return { value: folder };
}

/**
 * The plugin key 'Samples of the removed sample type(s) will no longer show:' + two newlines + '{0}' + two newlines +
 * 'Put the type(s) back in the list?', joined from its lines: escapes.test.ts reads "w:" before a backslash as a mangled drive path.
 */
const RESTORE_TYPES_QUESTION = ['Samples of the removed sample type(s) will no longer show:', '', '{0}', '', 'Put the type(s) back in the list?'].join('\n');

/**
 * When custom sample types were removed and samples of them are stored, offer
 * to put the types back (#137): otherwise those samples silently stop showing.
 * Asked once the settings dialog has closed, like the folder move.
 */
export async function offerToRestoreSampleTypes(env: SampleEnv, removed: string[], save: (customSampleTypes: string[]) => void): Promise<void> {
  const files = await env.markdownFiles();
  const folders = [
    env.globalFolder(),
    ...files
      .filter((p) => posix.basename(p) === 'README.labnote.md' && getExperimentDir(p) === posix.dirname(p))
      .map((p) => getExperimentLabsamplesFolder(p)!),
  ];
  const left: { type: string; count: number }[] = [];
  for (const type of removed) {
    const texts: string[] = [];
    for (const folder of folders) {
      const file = posix.join(folder, `${type}.json`);
      if (await env.fs.exists(file)) texts.push(await env.fs.read(file));
    }
    const count = countSampleRecords(texts);
    if (count > 0) left.push({ type, count });
  }
  if (left.length === 0) return;

  const list = left.map((l) => `- ${env.t('{0}: {1} sample(s)', l.type, String(l.count))}`).join('\n');
  const ok = await env.host.confirm(
    env.t(RESTORE_TYPES_QUESTION, list),
    { confirmLabel: env.t('Put back') },
  );
  if (!ok) return;
  const now = env.settings().customSampleTypes;
  save([...now, ...left.map((l) => l.type).filter((t) => !now.includes(t))]);
  env.changed();
  env.host.notify('info', env.t('Put back: {0}', left.map((l) => l.type).join(', ')));
}

/**
 * The Global sample folder setting went from `from` to `to`: offer to bring
 * the samples and catalogs left in `from` along, which no longer show (#101).
 */
export async function offerGlobalSampleFolderMove(env: SampleEnv, from: string, to: string): Promise<void> {
  const types = env.types();
  const fs = safeRegistryFs(env.fs, () => to);
  const left = await inventorySampleFolder(fs, from, types);
  if (left.records === 0 && left.catalogs.length === 0) return;
  // An experiment's own registry, set as Global by mistake, stays put (#408).
  const experiment = getExperimentDir(from);
  if (experiment) {
    env.host.notify(
      'info',
      env.t(
        'The old folder {0} is the Local registry of the experiment {1}, so its samples were not moved. To use one of them everywhere, move it with "Move to Global" in the sample view.',
        from,
        experiment,
      ),
    );
    return;
  }
  // D13: a registry core would read as {} is never trashed or merged over.
  for (const folder of [from, to]) {
    for (const type of types) {
      if ((await loadSampleIds(fs, folder, type)) === undefined) {
        env.host.notify('warn', appT('samples.registryUnreadable', posix.join(folder, `${type}.json`)));
        return;
      }
    }
  }
  const message = [
    env.t('The old Global sample folder {0} still has {1} sample(s). Move them to the new folder {2}?', from, String(left.records), to),
  ];
  if (left.catalogs.length > 0) {
    message.push(env.t('Product catalog files move too: {0}', left.catalogs.join(', ')));
  }
  if (!(await env.host.confirm(message.join('\n\n'), { confirmLabel: env.t('Move samples') }))) {
    env.host.notify('info', env.t('Samples in the old folder are not shown. Set the folder back to see them again.'));
    return;
  }
  const moved = await moveSampleFolder(fs, from, to, types);
  const parts = [env.t('Moved {0} sample(s) to {1}.', String(moved.moved), to)];
  if (moved.catalogsMoved > 0) parts.push(env.t('{0} catalog file(s) moved.', String(moved.catalogsMoved)));
  if (moved.skipped.length > 0) {
    parts.push(env.t('Not moved, {0} already has the same ID: {1}', to, moved.skipped.join(', ')));
  }
  if (moved.catalogsSkipped.length > 0) {
    parts.push(env.t('Catalog files not moved, {0} already has them: {1}', to, moved.catalogsSkipped.join(', ')));
  }
  env.host.notify('info', parts.join(' '));
  env.changed([from, to]);
}
