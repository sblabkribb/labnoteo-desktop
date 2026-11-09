// Ported from app/vendor/labnoteo/src/sampleActions.ts:137-316 sha256:d3da8d7a327b0f49
// labnoteO 0.140.2, Apache-2.0.
// Changes: App/LabnotePlugin → SampleEnv (D5); plugin.t → env.t; new Notice(m) → env.host.notify('info', m); pickModal(app, items, { title }) → env.host.pick(items, { title }); plugin.host.editTarget() → env.editTarget(); plugin.fs → env.fs; plugin.settings.globalSampleFolder → env.globalFolder(); plugin.settings.customSampleTypes → env.settings().customSampleTypes; plugin.markUserEdit removed. insertSampleReference takes `target: EditTarget | undefined` and goes through env.insertAtCursor (cell-aware, D20) when there is no target or a table cell editor is active in the target's note, in place of the vendor's tableCellEditorOf/writeIntoCell (#543); the cell's own text before its cursor decides the space writeIntoCell puts before a reference after an aliased one (endsAliasedReference). insertExperimentSamplesTable reads the caret as the end of the table being edited when a cell editor is active (the vendor's "below the table" rule for a table cursor), and makes every edit inside one env.editTarget().batch (one undo step); the batch re-reads the note's text and the list-table ranges after the picker in the Replace branch too, not only in the Insert-one-more branch.
import { endsAliasedReference, isOffsetBeforeBody, maskAiCallouts, planReferenceInsert, type EditTarget } from '@labnoteo/core';
import { caretBeforeModal, caretIn } from '@labnoteo/core/lib/caret';
import {
  buildMarkdownTable,
  compareSamples,
  findSampleListTableRanges,
  getSampleDisplayMeta,
  isCatalogSampleType,
  maskSampleListTables,
} from '@labnoteo/core/lib/sampleUtils';
import {
  extractSampleInfoFromText,
  isSameSampleFolder,
  loadSamplesByType,
  noteLabsamplesFolder,
  type SampleInfo,
  type SampleRecord,
} from '@labnoteo/core/lib/sampleStorage';
import { getExperimentDir } from '@labnoteo/core/lib/labnoteStructure';
import { activeCell, activeCellView } from '../../editor/table/cellEditor';
import { findTables } from '../../editor/table/field';
import type { SampleEnv } from '../../samples/env';
import { openNote } from '../openNotes';
import { listSome, sampleListHeaders, sampleListRow, unregisteredReferences } from './sampleListTable';
import { loadCatalogSamples, notesInSampleScope, type SampleScope } from './sampleScope';

/**
 * The open editor of `path` when a table cell editor is active in it, else undefined:
 * the end of the table being edited, and the cell's line up to its cursor.
 */
function cellEditing(path: string): { tableEnd: number; lineBefore: string } | undefined {
  const view = openNote(path)?.view();
  const cell = view ? activeCellView(view) : undefined;
  if (!view || !cell) return undefined;
  const ac = view.state.field(activeCell, false);
  const span = ac ? findTables(view.state).find((s) => s.from === ac.tableFrom) : undefined;
  const head = cell.state.selection.main.from;
  const lineBefore = cell.state.sliceDoc(cell.state.doc.lineAt(head).from, head);
  return { tableEnd: span ? span.to : view.state.selection.main.from, lineBefore };
}

/**
 * Insert a sample reference (`id;alias` / bare `id`) into `target` at the place
 * {@link planReferenceInsert} chooses: appended below the last section when the
 * cursor sits in the front matter or above the title, at the end of the line
 * when the cursor is on an existing reference or heading, over the selected
 * text on one line (#302), otherwise at the cursor (padded so it never fuses
 * with a neighbour). Reveals the spot.
 * In the app, a table cell being edited takes the reference itself, pipe-escaped (D20).
 */
export async function insertSampleReference(
  env: SampleEnv,
  target: EditTarget | undefined,
  ref: string,
  caret?: number,
): Promise<void> {
  const types = getSampleDisplayMeta(env.settings().customSampleTypes).types;
  // A reference holds no newline, so a focused table cell takes it (#543): into
  // the cell, not below the table. Only the cell's text is read, so a reference
  // whose alias runs up to whitespace needs a space before this one (#464, #479).
  const cell = target && target.path === env.activePath() ? cellEditing(target.path) : undefined;
  if (!target || cell) {
    env.insertAtCursor(cell && endsAliasedReference(cell.lineBefore, types) ? ` ${ref}` : ref);
    return;
  }
  // Hosts without cursor tracking (none today) fall back to a plain insert.
  if (!target.getCursorOffset) {
    await target.insertAtCursor(ref);
    return;
  }
  const text = await target.getText();
  // `caret` is what a caller read before its own dialog opened, which the
  // Source-mode editor no longer reports correctly (#544).
  const cursor = caret === undefined ? await target.getCursorOffset() : caretIn(caret, text);
  const selection = caret === undefined ? await target.getSelectionRange?.() : undefined;
  const plan = planReferenceInsert(text, cursor, ref, types, selection?.end);
  await target.replaceRange(plan.offset, plan.end ?? plan.offset, plan.text);
  await target.revealOffset?.(plan.offset + plan.text.length);
}

/**
 * "Insert sample list of this experiment" (#152): a Markdown table of every
 * Local sample of the open note's experiment and the Global ones its notes use,
 * inserted at the cursor. Returns false when there is nothing to insert.
 */
export async function insertExperimentSamplesTable(env: SampleEnv): Promise<boolean> {
  const target = env.editTarget();
  if (!target) {
    env.host.notify('info', env.t('Open a note to insert into.'));
    return false;
  }
  const globalFolder = env.globalFolder();
  const local = noteLabsamplesFolder(target.path, globalFolder);
  if (!getExperimentDir(target.path) || isSameSampleFolder(local, globalFolder)) {
    env.host.notify('info', env.t('Open a note of an experiment to list its samples.'));
    return false;
  }

  const customTypes = env.settings().customSampleTypes;
  const types = getSampleDisplayMeta(customTypes).types;
  const used = new Set<string>();
  const references: SampleInfo[] = [];
  const headers = sampleListHeaders(env);
  for (const note of await notesInSampleScope(env, local)) {
    // An earlier table and an AI answer list samples without using them (#385, #318).
    const text = maskSampleListTables(maskAiCallouts(note.text), headers);
    for (const s of extractSampleInfoFromText(text, customTypes)) {
      used.add(`${s.type}\u0000${s.id}`);
      references.push(s);
    }
  }
  // The same sources as the editor's "not in the registry" mark (#238).
  const known = new Set<string>();
  const remember = (db: Record<string, unknown>): void => {
    for (const id of Object.keys(db)) known.add(id.toLowerCase());
  };
  const rows: string[][] = [];
  for (const type of types) {
    const localDb = await loadSamplesByType(env.fs, local, type);
    remember(localDb);
    if (isCatalogSampleType(type)) remember(await loadCatalogSamples(env, local, type));
    const listed: Array<{ id: string; rec: SampleRecord; scope: SampleScope }> = Object.entries(localDb).map(
      ([id, rec]) => ({ id, rec, scope: 'local' }),
    );
    if (globalFolder) {
      const globalDb = await loadSamplesByType(env.fs, globalFolder, type);
      remember(globalDb);
      if (isCatalogSampleType(type)) remember(await loadCatalogSamples(env, globalFolder, type));
      for (const [id, rec] of Object.entries(globalDb)) {
        if (!localDb[id] && used.has(`${type}\u0000${id}`)) listed.push({ id, rec, scope: 'global' });
      }
    }
    // By alias within each type, as the sample view lists them (#410).
    listed.sort(
      (a, b) =>
        compareSamples({ id: a.id, alias: a.rec.alias }, { id: b.id, alias: b.rec.alias }) ||
        (a.scope === b.scope ? 0 : a.scope === 'local' ? -1 : 1),
    );
    for (const { id, rec, scope } of listed) rows.push(sampleListRow(env, id, rec, scope));
  }
  const unregistered = unregisteredReferences(references, known);
  const leftOut =
    unregistered.length === 0
      ? ''
      : ` ${env.t(
          "{0} sample reference(s) in this experiment's notes are not in the sample registry, so they are not in the table: {1}",
          String(unregistered.length),
          listSome(unregistered),
        )}`;
  if (rows.length === 0) {
    env.host.notify('info', `${env.t('This experiment has no samples yet.')}${leftOut}`);
    return false;
  }

  // In the UI language, as the scope cells are, whatever an older table used.
  const table = buildMarkdownTable(headers[0], rows, new Set([0]));
  const before0 = await target.getText();
  // Read before the picker below opens: a picker takes the focus, and in Source
  // mode the editor then reports the cursor at the start of the note (#450).
  // From a table cell, the outer cursor says nothing about the cell: below the table being edited.
  const cell = cellEditing(target.path);
  const caret = cell ? cell.tableEnd : await caretBeforeModal(target);
  const tables0 = findSampleListTableRanges(before0, headers);
  let choice: 'replace' | 'add' | 'cancel' | undefined;
  if (tables0.length > 0) {
    // A second table sat silently under the first (#450).
    choice = await env.host.pick<'replace' | 'add' | 'cancel'>(
      [
        { label: env.t('Replace the existing table(s) with the current samples'), value: 'replace' },
        { label: env.t('Insert one more table'), value: 'add' },
        { label: env.t('Cancel'), value: 'cancel' },
      ],
      {
        title: env.t(
          'This note already has {0} sample list table(s). Replacing them loses rows and order changed by hand.',
          String(tables0.length),
        ),
      },
    );
    if (choice === undefined || choice === 'cancel') return false;
  }

  // The picker may have closed the editor or left it busy: the target is taken again.
  const edit = env.editTarget();
  if (!edit || edit.path !== target.path) {
    env.host.notify('info', env.t('Open a note to insert into.'));
    return false;
  }
  // One undo step for every edit below.
  const atEnd = await edit.batch(async (b) => {
    // Written to from outside (a sync) while the picker was open: the table
    // ranges are read again, but not the cursor, which is kept from before.
    let text = before0;
    let tables = tables0;
    const now = await b.getText();
    if (now !== text) {
      text = now;
      tables = findSampleListTableRanges(text, headers);
    }
    if (choice === 'replace' && tables.length > 0) {
      // From the last table, so the earlier ones keep their offsets.
      for (const range of [...tables].reverse()) await b.replaceRange(range.start, range.end, table);
      const below = tables[0].start + table.length + (text[tables[0].end] === '\n' ? 1 : 0);
      await b.revealOffset?.(below);
      return 'replaced' as const;
    }
    const cursor = caretIn(caret, text);
    // In the front matter or above the title the table would break the
    // properties, so it goes at the end like a sample reference does (#360).
    const end = cursor !== text.length && isOffsetBeforeBody(text, cursor);
    // Inside a sample list table's text, a new table would break it: below it instead.
    const inside = tables.find((range) => cursor > range.start && cursor < range.end);
    const at = end ? text.length : (inside?.end ?? cursor);
    const before = at === 0 || text[at - 1] === '\n' ? (at > 1 && text[at - 2] !== '\n' ? '\n' : '') : '\n\n';
    const after = at >= text.length || text[at] === '\n' ? '\n' : '\n\n';
    await b.replaceRange(at, at, `${before}${table}${after}`);
    // Below the table, not in its last cell, so running the command again does
    // not land inside this table (#196).
    await b.revealOffset?.(at + before.length + table.length + after.length);
    return end;
  });
  if (atEnd === 'replaced') {
    env.host.notify(
      'info',
      `${env.t(
        'Replaced {0} sample list table(s) with the current samples ({1} sample(s)).',
        String(tables0.length),
        String(rows.length),
      )}${leftOut}`,
    );
    return true;
  }
  const where = atEnd ? ` ${env.t('The cursor was in the properties or above the title, so the table is at the end of the note.')}` : '';
  env.host.notify('info', `${env.t('Inserted {0} sample(s).', String(rows.length))}${where}${leftOut}`);
  return true;
}
