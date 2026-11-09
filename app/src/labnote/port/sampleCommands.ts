// Ported from app/vendor/labnoteo/src/main.ts:792-822 sha256:06b20607dbe60741
// Ported from app/vendor/labnoteo/src/main.ts:855-895 sha256:5da76ea9350fbbf6
// Ported from app/vendor/labnoteo/src/main.ts:897-951 sha256:537e34938effb9d9
// Ported from app/vendor/labnoteo/src/sampleDefinitionModal.ts:31-59 sha256:8f0e42fc6e91eed7
// labnoteO 0.140.2, Apache-2.0.
// Changes: main.ts:785-815 is an excerpt from inside the `editor-menu` closure (the one exception to the D4 range rule): it becomes sampleEditorMenuItems, which returns the two items as MenuActions with the app keys 'samples.menu.goToDefinition' / 'samples.menu.addSample' (labelKey, the plugin's 'Go to definition' / 'Add sample' text) instead of menu.addItem, reads the line and column from the open note's CodeMirror state instead of editor.getCursor/getLine, and leaves this.run to ContextMenu's runCommand. App/LabnotePlugin → SampleEnv (D5); plugin.t → env.t; new Notice(m) → env.host.notify('info', m); pickModal(app, items, opts) → env.host.pick(items, opts); this.host.editTarget() → env.editTarget(); this.fs → env.fs; this.settings.x → env.settings().x (globalSampleFolder → env.globalFolder()); this.sampleTrackingFor → env.trackingFor; this.hasLocalScope/localSampleFolder → env.hasLocalScope/localFolder. openSampleDefinitionCommand reads the reference under the cursor through the edit target (getText/getCursorOffset) instead of MarkdownView.editor; the tracking-off sentence names the app command t('cmd.sampleSettings') where the plugin names its settings path. openSampleDefinition (sampleDefinitionModal.ts:31-59) is ported here as the resolve-or-notice step; `new SampleDefinitionModal(…).open()` becomes runSampleDefinition (samples/definitionFlow.ts), which opens the dialog and runs the chosen flow. addSampleFromEditor reads the caret before the type picker (caretBeforeModal, #544) and hands it to the port's insertSampleReference (port/sampleInsert.ts), which takes the same optional caret as the plugin's; a table cell being edited still takes the reference itself (D20), so the caret only steers the note-level insert.
import { findSampleReferenceAt } from '@labnoteo/core';
import { caretBeforeModal } from '@labnoteo/core/lib/caret';
import { getSampleDisplayMeta, isCatalogSampleType } from '@labnoteo/core/lib/sampleUtils';
import { hasReferenceCatalog, noteLabsamplesFolder } from '@labnoteo/core/lib/sampleStorage';
import type { EditorState } from '@codemirror/state';
import { t } from '../../i18n/t';
import { runSampleDefinition } from '../../samples/definitionFlow';
import type { SampleEnv } from '../../samples/env';
import type { MenuAction } from '../ui/menuStore';
import { createSampleInteractive, pickCatalogReference } from './sampleCreate';
import { insertSampleReference } from './sampleInsert';
import { listSampleDefinitions, resolveSampleDefinition, type ResolvedSampleDefinition } from './sampleQuery';

/**
 * Resolve `(type, id)` then show the definition popup (or a Notice if absent).
 * `resolved` skips the lookup when the caller already knows the record.
 * `localFolder` stands in for `docPath` when there is no note to derive the
 * Local folder from, as when the Samples sidebar opens the window.
 */
export async function openSampleDefinition(
  env: SampleEnv,
  opts: {
    type: string;
    id: string;
    docPath: string;
    resolved?: ResolvedSampleDefinition;
    localFolder?: string;
  },
): Promise<void> {
  const resolved = opts.resolved ?? (await resolveSampleDefinition(env, opts));
  if (!resolved) {
    env.host.notify(
      'info',
      env.t(
        'No definition found for {0}. It is not in the sample registry: it may have been deleted or moved to another experiment, or the Global sample folder setting changed.',
        opts.id,
      ),
    );
    return;
  }
  await runSampleDefinition(env, { ...resolved, type: opts.type, id: opts.id }, { docPath: opts.docPath || undefined, localFolder: opts.localFolder });
}

/** The line holding `pos` and the column in it, as Obsidian's editor.getCursor()/getLine() give them. */
function lineAt(state: EditorState, pos: number): { text: string; ch: number } {
  const line = state.doc.lineAt(pos);
  return { text: line.text, ch: pos - line.from };
}

/**
 * The editor menu's sample items (main.ts `editor-menu`): Go to definition when
 * the cursor sits on a reference, and Add sample always, both only where sample
 * tracking is on. Go to definition works in ANY markdown note (references may
 * appear outside `.labnote.md`).
 */
export function sampleEditorMenuItems(env: SampleEnv, path: string, state: EditorState | undefined): MenuAction[] {
  const items: MenuAction[] = [];
  if (env.trackingFor(path)) {
    const cur = state ? lineAt(state, state.selection.main.head) : undefined;
    const types = getSampleDisplayMeta(env.settings().customSampleTypes).types;
    const hit = cur ? findSampleReferenceAt(cur.text, cur.ch, types) : undefined;
    if (hit) {
      items.push({
        labelKey: 'samples.menu.goToDefinition',
        run: () =>
          openSampleDefinition(env, {
            type: hit.type,
            id: hit.id,
            docPath: path,
          }),
      });
    }

    // Always offer adding a sample from the editor (not just when the
    // cursor sits on an existing reference), so a sample can be created
    // and referenced without leaving the note for the sidebar.
    items.push({ labelKey: 'samples.menu.addSample', run: () => addSampleFromEditor(env) });
  }
  return items;
}

/**
 * The definition window from the command palette (#121), which the editor's
 * context menu and the Samples sidebar only offered to the mouse: the
 * reference under the cursor, else a sample picked from the Local and Global
 * ones.
 */
export async function openSampleDefinitionCommand(env: SampleEnv): Promise<void> {
  const target = env.editTarget();
  const path = target?.path ?? env.activePath();
  if (!env.trackingFor(path)) {
    // Name the cause: the setting, or this experiment's README (#407).
    env.host.notify(
      'info',
      env.settings().sampleTracking
        ? env.t("Sample tracking is off for this experiment: its README sets sample_tracking: 'no'.")
        : env.t('Sample tracking is turned off in {0}.', t('cmd.sampleSettings')),
    );
    return;
  }
  const types = getSampleDisplayMeta(env.settings().customSampleTypes).types;
  if (target?.getCursorOffset) {
    const text = await target.getText();
    const cursor = await target.getCursorOffset();
    const from = text.lastIndexOf('\n', cursor - 1) + 1;
    const end = text.indexOf('\n', cursor);
    const hit = findSampleReferenceAt(text.slice(from, end < 0 ? undefined : end), cursor - from, types);
    if (hit) {
      await openSampleDefinition(env, { type: hit.type, id: hit.id, docPath: target.path });
      return;
    }
  }

  const items = await listSampleDefinitions(env, path);
  if (items.length === 0) {
    env.host.notify('info', env.t('No samples are registered yet.'));
    return;
  }
  const chosen = await env.host.pick(items, {
    title: env.t('Open sample definition'),
    placeholder: env.t('Search by ID, alias or location'),
  });
  if (!chosen) return;
  await openSampleDefinition(env, { ...chosen, docPath: path ?? '' });
}

/**
 * Editor context-menu "Add sample": pick a type, then create (authored types)
 * or search the product catalog (Reagent/Labware/Equip), and insert the
 * resulting reference at the cursor. Mirrors the autocomplete create flow so
 * the two entry points behave identically.
 */
export async function addSampleFromEditor(env: SampleEnv): Promise<void> {
  const target = env.editTarget();
  if (!target) {
    env.host.notify('info', env.t('Open a note to insert into.'));
    return;
  }
  if (!env.hasLocalScope()) {
    env.host.notify('info', env.t('Open a note first to add a local sample.'));
    return;
  }

  // Read before the type picker opens: it takes the focus, and the
  // Source-mode editor then reports the cursor at the start of the note (#544).
  const caret = await caretBeforeModal(target);

  const types = getSampleDisplayMeta(env.settings().customSampleTypes).types;
  const type = await env.host.pick(
    types.map((t) => ({ label: t, value: t })),
    { title: env.t('Select sample type'), placeholder: env.t('Select sample type') },
  );
  if (!type) return;

  // A type with a product catalog is curated: search the read-only catalog
  // first; without one, a generated id is registered instead.
  let referenceText: string | undefined;
  const localFolder = noteLabsamplesFolder(target.path, env.globalFolder());
  const knownTypes = getSampleDisplayMeta(env.settings().customSampleTypes).types;
  if (
    isCatalogSampleType(type) &&
    ((await hasReferenceCatalog(env.fs, localFolder, type, knownTypes)) ||
      (await hasReferenceCatalog(env.fs, env.globalFolder(), type, knownTypes)))
  ) {
    referenceText = await pickCatalogReference(env, {
      type,
      docPath: target.path,
    });
  } else {
    const created = await createSampleInteractive(env, {
      type,
      folder: env.localFolder(),
      mode: 'generate',
      scope: 'local',
    });
    referenceText = created?.referenceText;
  }
  if (!referenceText) return;
  await insertSampleReference(env, target, referenceText, caret);
}
