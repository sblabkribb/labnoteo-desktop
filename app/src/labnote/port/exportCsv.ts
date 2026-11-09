// Ported from app/vendor/labnoteo/src/exportCsv.ts:32-656 sha256:37885349054c5529
// labnoteO 0.140.2, Apache-2.0.
// Changes: LabnotePlugin → CsvCtx (host, vaultRoot, refresh); TFile → a vault-relative path string (noteLabel and the CSV names use its base name); plugin.t → host.t; plugin.app.vault.read and plugin.fs → host.fs, the editor-aware fs, so an open note's buffer with unsaved edits is what is exported (A-R1); vault.adapter.write → host.fs.write with the BOM-led string (Rust writes it as UTF-8, EF BB BF).
// Changes: fileManager.renameFile → host.fs.rename, without link updates (A-R4); the "not in the vault index" check is gone (a missing CSV fails the rename instead); vault.getFileByPath for the experiment's notes → every `.md` name host.fs.list gives (the app has no file index to check them against).
// Changes: new Notice(text) → host.notify('info', text); new Notice(`⚠️ ${text}`, 15000) → host.notify('warn', text, { ms: 15000 }) (the warn toast marks it, so no ⚠️ prefix, A-R5); confirmModal → host.confirm(msg, { confirmLabel, destructive }); listFileNames / trashTableCsvs from ./tableCsvFiles; windowsPathsOver(app, …) → windowsPathsOver(ctx.vaultRoot, …) from ./experiments.
// Changes: offerStaleCsvCleanup picks between two host.t calls instead of passing a ternary key to one (same text; the ko coverage test reads keys off the call).
// Changes: isFileLocked also accepts FsCommandError.code EBUSY (the Rust `locked` kind); EPERM/EACCES kept.
// Changes: withCaretGuard / CARET_GRACE_MS removed (an Obsidian focus quirk, #470; A-R2); explorerHint removed (the app tree lists .csv files, A-R7).
// Changes: the active file → ctx.activePath(); the vault is re-read (ctx.refresh()) after an export or cleanup that may have changed files.
import * as posix from '@labnoteo/core/posix';
import {
  classifyCsvOverwrites,
  csvRowCount,
  excelRiskCells,
  firstDifferingRow,
  scanMarkdownTables,
  tableToCsv,
  type CsvOverwriteKind,
  type ExcelRiskCell,
  type ExcelRiskKind,
} from '@labnoteo/core/lib/exportTablesCsv';
import { getExperimentDir } from '@labnoteo/core/lib/labnoteStructure';
import { EXCEL_PATH_MAX } from '@labnoteo/core/lib/regexUtils';
import {
  orphanTableCsvs,
  planTableCsvNames,
  siblingTableCsvs,
  staleTableCsvs,
} from '@labnoteo/core/lib/workflowStructure';
import type { CommandContext } from '../commands/context';
import { windowsPathsOver } from './experiments';
import { listFileNames, trashTableCsvs } from './tableCsvFiles';

/** What the export needs from a command context; `host.fs` is the editor-aware fs (A-R1). */
export type CsvCtx = Pick<CommandContext, 'host' | 'vaultRoot' | 'refresh'>;

/** One table's CSV: where it goes, what is written, and the CSV already there (BOM and CRLF dropped). */
interface CsvOutput {
  path: string;
  csv: string;
  fresh: string;
  old?: string;
  /** The table's header row, and the cells Excel would change (#375). */
  header: string[];
  risky: ExcelRiskCell[];
  /** Cells past the header width, left out of the CSV as the note shows them (#510). */
  dropped?: { row: number; cells: string[] }[];
  /** Whether a dropped cell came from a `|` inside a code span. */
  codePipe?: boolean;
  /** Another program (Excel) holds the CSV, or it is read-only: it is left as it is (#476). */
  locked?: boolean;
}

/**
 * A read or write refused because another program has the file open or it is
 * read-only (#476). The app's fs gives a `locked` refusal the code EBUSY.
 */
function isFileLocked(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string') return ['EBUSY', 'EPERM', 'EACCES'].includes(code);
  return /^(EBUSY|EPERM|EACCES)\b/.test(err instanceof Error ? err.message : String(err));
}

/** The CSV at `path` without BOM and CRLF, or `locked` when it cannot be read (#476). */
async function readCsv(ctx: CsvCtx, path: string): Promise<string | { locked: true }> {
  try {
    return normalizeCsv(await ctx.host.fs.read(path));
  } catch (err) {
    if (!isFileLocked(err)) throw err;
    return { locked: true };
  }
}

/** A note's tables as CSVs, worked out before anything is written. */
interface NoteCsvPlan {
  /** The note's vault path. */
  file: string;
  dir: string;
  /** Tables left out: no blank line above them, or inside a comment. */
  notRendered: number;
  hidden: number;
  outputs: CsvOutput[];
  renames: ReadonlyArray<{ from: string; to: string }>;
  /** Overwrite prompt lines: CSVs that would hold another table, and CSVs whose header changed. */
  moved: string[];
  headerChanged: string[];
}

async function planNoteCsvExport(ctx: CsvCtx, file: string): Promise<NoteCsvPlan> {
  const { host } = ctx;
  const content = await host.fs.read(file);
  const { tables, notRendered, hidden } = scanMarkdownTables(content);
  const dir = posix.dirname(file);
  const name = posix.basename(file);
  const plan: NoteCsvPlan = {
    file,
    dir,
    notRendered,
    hidden,
    outputs: [],
    renames: [],
    moved: [],
    headerChanged: [],
  };
  if (tables.length === 0) return plan;

  const siblings = await host.fs.list(dir);
  const names = planTableCsvNames(name, siblings, tables.length);
  const renamedFrom = new Map(names.renames.map(r => [r.to, r.from]));
  const outputs = await Promise.all(
    tables.map(async table => {
      const csvName = names.names[table.index];
      const path = posix.join(dir, csvName);
      // A CSV still to be renamed holds the old content of this table.
      const current = posix.join(dir, renamedFrom.get(csvName) ?? csvName);
      const csv = tableToCsv(table.rows, { bom: true });
      const read = (await host.fs.exists(current)) ? await readCsv(ctx, current) : undefined;
      const output: CsvOutput = {
        path,
        csv,
        fresh: normalizeCsv(csv),
        header: table.rows[0] ?? [],
        risky: excelRiskCells(table.rows),
        ...(table.dropped ? { dropped: table.dropped } : {}),
        ...(table.codePipe ? { codePipe: true } : {}),
      };
      if (typeof read === 'object') output.locked = true;
      else output.old = read;
      return output;
    })
  );
  // `a → a` says nothing when two tables share a header: show what differs (#110).
  const sameHeaderHint = (old: string, fresh: string): string => {
    if (firstLine(old) !== firstLine(fresh)) return '';
    const before = csvRowCount(old);
    const after = csvRowCount(fresh);
    if (before !== after) return ` (${host.t('{0} rows → {1} rows', String(before), String(after))})`;
    const diff = firstDifferingRow(old, fresh);
    return diff
      ? ` (${host.t('row {0}: {1} → {2}', String(diff.row), clip(diff.from), clip(diff.to))})`
      : '';
  };
  const existingCount = Math.max(
    0,
    ...siblingTableCsvs(name, siblings).map(f => Number(/_table(\d+)\.csv$/.exec(f)![1]))
  );
  const staleOld = await Promise.all(
    names.stale.map(async stale => {
      const read = await readCsv(ctx, posix.join(dir, stale));
      return typeof read === 'object' ? '' : read;
    })
  );
  const kinds = classifyCsvOverwrites(outputs, existingCount, staleOld);
  // A locked CSV is not written, so there is nothing to ask about it.
  const linesOf = (kind: CsvOverwriteKind) =>
    outputs
      .filter((o, k) => !o.locked && kinds[k] === kind)
      .map(
        o =>
          `- ${posix.basename(o.path)}: ${firstLine(o.old!)} → ${firstLine(o.fresh)}${sameHeaderHint(o.old!, o.fresh)}`
      );
  return { ...plan, outputs, renames: names.renames, moved: linesOf('moved'), headerChanged: linesOf('headerChanged') };
}

/** Ask once before overwriting CSVs that would change table or header; true when there is nothing to ask. */
async function confirmOverwrites(ctx: CsvCtx, plans: readonly NoteCsvPlan[]): Promise<boolean> {
  const { host } = ctx;
  const sections: string[] = [];
  const moved = plans.flatMap(p => p.moved).join('\n');
  if (moved) {
    sections.push(
      host.t(
        'These CSV files would now hold a different table (a table was added, removed or moved). Overwrite them?\n\n{0}',
        moved
      )
    );
  }
  const headerChanged = plans.flatMap(p => p.headerChanged).join('\n');
  if (headerChanged) {
    sections.push(host.t('The header of these CSV files changed. Overwrite them?\n\n{0}', headerChanged));
  }
  if (sections.length === 0) return true;
  return host.confirm(sections.join('\n\n'), { confirmLabel: host.t('Overwrite'), destructive: true });
}

interface CsvWriteResult {
  /** Paths of the CSVs written. */
  written: string[];
  /** Paths of the CSVs another program held or that were read-only, left as they were (#476). */
  locked: string[];
  renamed: string[];
  notRenamed: number;
}

async function writeNoteCsvExport(ctx: CsvCtx, plan: NoteCsvPlan): Promise<CsvWriteResult> {
  const { fs } = ctx.host;
  // Renamed before writing: the new name must be free when the CSV moves to it.
  const renamed: string[] = [];
  const notRenamed = new Set<string>();
  for (const r of plan.renames) {
    try {
      await fs.rename(posix.join(plan.dir, r.from), posix.join(plan.dir, r.to));
      renamed.push(`${r.from} → ${r.to}`);
    } catch (err) {
      console.warn('[labnoteo] could not rename table CSV:', err);
      notRenamed.add(r.to);
    }
  }

  const written: string[] = [];
  const locked: string[] = [];
  for (const o of plan.outputs) {
    if (o.locked) {
      locked.push(o.path);
      continue;
    }
    if (o.old === o.fresh && !notRenamed.has(posix.basename(o.path))) continue;
    try {
      await fs.write(o.path, o.csv);
      written.push(o.path);
    } catch (err) {
      if (!isFileLocked(err)) throw err;
      locked.push(o.path);
    }
  }
  return { written, locked, renamed, notRenamed: notRenamed.size };
}

/** CSVs named after `file` that no longer match one of its `tableCount` tables (#74). */
async function staleCsvsOf(ctx: CsvCtx, file: string, tableCount: number): Promise<string[]> {
  return staleTableCsvs(posix.basename(file), await ctx.host.fs.list(posix.dirname(file)), tableCount);
}

/** The lab note CSVs in `dir` whose note is gone (#374). */
async function orphanCsvsIn(ctx: CsvCtx, dir: string): Promise<string[]> {
  return orphanTableCsvs(await ctx.host.fs.list(dir));
}

/**
 * Offer to trash the CSVs in `dir` of tables the notes no longer have (#74),
 * and those whose note is gone (#374). `notes` says whether more than one
 * note was exported, for the wording (#370). Returns the feedback to append
 * to the export notice, or '' when there were none.
 */
async function offerStaleCsvCleanup(
  ctx: CsvCtx,
  dir: string,
  stale: readonly string[],
  orphans: readonly string[] = [],
  notes: 'one' | 'many' = 'one'
): Promise<string> {
  const { host } = ctx;
  const total = stale.length + orphans.length;
  if (total === 0) return '';
  const sections = [
    stale.length > 0
      ? notes === 'one'
        ? host.t(
            'These table CSV files no longer match a table in the note. Move them to the trash?\n\n{0}',
            listFileNames(host, stale)
          )
        : host.t(
            'These table CSV files no longer match a table in their notes. Move them to the trash?\n\n{0}',
            listFileNames(host, stale)
          )
      : '',
    orphans.length > 0
      ? host.t(
          'These table CSV files have no note of their name in the folder: the note was deleted, or renamed while a CSV of its new name was there. Move them to the trash?\n\n{0}',
          listFileNames(host, orphans)
        )
      : '',
  ].filter(Boolean);
  const ok = await host.confirm(sections.join('\n\n'), { confirmLabel: host.t('Move to trash'), destructive: true });
  if (!ok) return host.t('{0} old CSV file(s) kept.', String(total));
  const kept = await trashTableCsvs(host, dir, [...stale, ...orphans]);
  const moved = host.t('{0} CSV file(s) moved to the trash.', String(total - kept));
  return kept > 0 ? `${moved} ${host.t('{0} old CSV file(s) kept.', String(kept))}` : moved;
}

/** The name a note goes by in the notices: `001_WT020_A` for `001_WT020_A.labnote.md`. */
function noteLabel(file: string): string {
  return posix.basename(file).replace(/(?:\.labnote)?\.md$/i, '');
}

/**
 * Why some tables were left out, or ''. With `plans` of several notes, each
 * reason names the notes it applies to (#370).
 */
function skippedText(ctx: CsvCtx, plans: readonly NoteCsvPlan[]): string {
  const { host } = ctx;
  const notRendered = plans.reduce((n, p) => n + p.notRendered, 0);
  const hidden = plans.reduce((n, p) => n + p.hidden, 0);
  const where = (count: (p: NoteCsvPlan) => number): string =>
    plans.length > 1
      ? ` ${host.t(
          'In: {0}.',
          plans
            .filter(p => count(p) > 0)
            .map(p => `${noteLabel(p.file)} ${count(p)}`)
            .join(', ')
        )}`
      : '';
  return [
    notRendered > 0
      ? host.t(
          '{0} table(s) were not exported: with no blank line above, the reading view shows them as text. Add a blank line above a table to export it.',
          String(notRendered)
        ) + where(p => p.notRendered)
      : '',
    hidden > 0
      ? host.t(
          '{0} table(s) were not exported: they are inside a comment, so the reading view does not show them at all.',
          String(hidden)
        ) + where(p => p.hidden)
      : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/** The CSVs left unwritten because they were locked, said first in the notice (#476), or ''. */
function lockedText(ctx: CsvCtx, locked: readonly string[]): string {
  if (locked.length === 0) return '';
  return ctx.host.t(
    'Could not write {0} CSV file(s) because another program (such as Excel) has them open or they are read-only: {1}. Close them and export again.',
    String(locked.length),
    listInline(ctx, locked.map(p => posix.basename(p)), 3)
  );
}

/** The export notice, held longer and marked as a warning when a CSV was locked (#476). */
function showExportNotice(ctx: CsvCtx, parts: readonly string[], locked: readonly string[]): void {
  const text = parts.filter(Boolean).join(' ');
  if (locked.length > 0) ctx.host.notify('warn', text, { ms: 15000 });
  else ctx.host.notify('info', text);
}

/** The opening line of the export notice. */
function exportedText(ctx: CsvCtx, result: CsvWriteResult, total: number): string {
  const { host } = ctx;
  const written = result.written.length;
  const unchanged = total - written - result.locked.length;
  if (written === 0 && unchanged === 0) return '';
  return written === 0
    ? host.t('The CSV files are already up to date ({0}).', String(unchanged))
    : unchanged > 0
      ? host.t('Exported {0} CSV file(s) ({1} unchanged file(s) left as they were).', String(written), String(unchanged))
      : host.t('Exported {0} CSV file(s).', String(written));
}

function renameText(ctx: CsvCtx, result: CsvWriteResult): string {
  const { host } = ctx;
  const { renamed, notRenamed } = result;
  return [
    renamed.length > 0
      ? host.t(
          'Renamed {0} CSV file(s) so their numbers sort in table order: {1}. Update these paths in any analysis script.',
          String(renamed.length),
          renamed.length > 1 ? host.t('{0} (+{1} more)', renamed[0], String(renamed.length - 1)) : renamed[0]
        )
      : '',
    notRenamed > 0
      ? host.t('Could not rename {0} old CSV file(s); they keep their old names.', String(notRenamed))
      : '',
  ]
    .filter(Boolean)
    .join(' ');
}

export async function exportTablesToCsv(ctx: CsvCtx, notePath: string): Promise<void> {
  const plan = await planNoteCsvExport(ctx, notePath);
  const skipped = skippedText(ctx, [plan]);
  if (plan.outputs.length === 0) {
    const cleanup = await offerStaleCsvCleanup(
      ctx,
      plan.dir,
      await staleCsvsOf(ctx, notePath, 0),
      await orphanCsvsIn(ctx, plan.dir)
    );
    if (cleanup) ctx.refresh();
    ctx.host.notify('info', [ctx.host.t('No tables found in this note.'), skipped, cleanup].filter(Boolean).join(' '));
    return;
  }
  if (!(await confirmOverwrites(ctx, [plan]))) {
    ctx.host.notify('info', ctx.host.t('No changes made.'));
    return;
  }
  const result = await writeNoteCsvExport(ctx, plan);
  const cleanup = await offerStaleCsvCleanup(
    ctx,
    plan.dir,
    await staleCsvsOf(ctx, notePath, plan.outputs.length),
    await orphanCsvsIn(ctx, plan.dir)
  );
  ctx.refresh();
  const paths = plan.outputs.map(o => o.path);
  showExportNotice(
    ctx,
    [
      lockedText(ctx, result.locked),
      exportedText(ctx, result, plan.outputs.length),
      renameText(ctx, result),
      savedIn(ctx, plan.dir, plan.outputs, result),
      skipped,
      droppedText(ctx, plan.outputs),
      excelHint(ctx, plan.outputs),
      excelPathHint(ctx, paths),
      cleanup,
    ],
    result.locked
  );
}

/**
 * Export the tables of every note in an experiment folder (#347): the README
 * first, then the other notes by name — workflow notes and plain `.md` notes
 * alike, as exporting one of them does (#369). The overwrite and cleanup
 * prompts are asked once for all of them.
 */
export async function exportExperimentTablesToCsv(ctx: CsvCtx, dir: string): Promise<void> {
  const { host } = ctx;
  const names = (await host.fs.list(dir)).filter(n => /\.md$/i.test(n));
  const ordered = [
    ...names.filter(n => n === 'README.labnote.md'),
    ...names.filter(n => n !== 'README.labnote.md').sort((a, b) => a.localeCompare(b)),
  ];
  const plans: NoteCsvPlan[] = [];
  for (const name of ordered) plans.push(await planNoteCsvExport(ctx, posix.join(dir, name)));
  const skipped = skippedText(ctx, plans);
  const staleOf = async () =>
    (await Promise.all(plans.map(p => staleCsvsOf(ctx, p.file, p.outputs.length)))).flat();
  const cleanupAll = async () =>
    offerStaleCsvCleanup(ctx, dir, await staleOf(), await orphanCsvsIn(ctx, dir), 'many');
  const withTables = plans.filter(p => p.outputs.length > 0);
  if (withTables.length === 0) {
    const cleanup = await cleanupAll();
    if (cleanup) ctx.refresh();
    host.notify(
      'info',
      [host.t('No tables found in the notes of {0}.', posix.basename(dir)), skipped, cleanup].filter(Boolean).join(' ')
    );
    return;
  }
  if (!(await confirmOverwrites(ctx, withTables))) {
    host.notify('info', host.t('No changes made.'));
    return;
  }
  const result: CsvWriteResult = { written: [], locked: [], renamed: [], notRenamed: 0 };
  for (const plan of withTables) {
    const r = await writeNoteCsvExport(ctx, plan);
    result.written.push(...r.written);
    result.locked.push(...r.locked);
    result.renamed.push(...r.renamed);
    result.notRenamed += r.notRenamed;
  }
  const cleanup = await cleanupAll();
  ctx.refresh();
  const paths = withTables.flatMap(p => p.outputs.map(o => o.path));
  const perNote = withTables.map(p => `${noteLabel(p.file)} ${p.outputs.length}`);
  const withoutTables = plans.length - withTables.length;
  const outputs = withTables.flatMap(p => p.outputs);
  showExportNotice(
    ctx,
    [
      lockedText(ctx, result.locked),
      exportedText(ctx, result, paths.length),
      host.t('Tables per note: {0}.', listInline(ctx, perNote, 5)),
      withoutTables > 0 ? host.t('{0} note(s) without tables were skipped.', String(withoutTables)) : '',
      renameText(ctx, result),
      savedIn(ctx, dir, outputs, result),
      skipped,
      droppedText(ctx, outputs),
      excelHint(ctx, outputs),
      excelPathHint(ctx, paths),
      cleanup,
    ],
    result.locked
  );
}

/** How Excel would change cells of `kind`, with the examples. */
function excelRiskText(ctx: CsvCtx, kind: ExcelRiskKind, examples: string): string {
  const { host } = ctx;
  switch (kind) {
    case 'dateTime':
      return host.t('{0} become dates or times', examples);
    case 'negative':
      return host.t('{0} become negative numbers', examples);
    case 'precision':
      return host.t('{0} lose the digits past the 15th', examples);
    case 'leadingZero':
      return host.t('{0} lose their leading zeros', examples);
    case 'eNotation':
      return host.t('{0} become numbers in E notation (2E4 → 20000)', examples);
  }
}

/** CSVs the Excel warning names before counting the rest. */
const EXCEL_HINT_FILES = 5;

/**
 * How to open the CSV in Excel without it rewriting cells like `3-1`, `2:1`,
 * `007`, `(1)`, `2E4` or a 16-digit barcode (#256, #272, #343, #345, #346,
 * #376). Each CSV is named with the columns to set to Text, and each kind of
 * change with up to three examples and a count of the rest (#375). The file
 * keeps the text as typed; Excel is what changes it.
 */
function excelHint(ctx: CsvCtx, outputs: readonly CsvOutput[]): string {
  const { host } = ctx;
  const parts = outputs
    .filter(o => o.risky.length > 0)
    .map(o => {
      const byKind = new Map<ExcelRiskKind, string[]>();
      for (const { text, kind } of o.risky) byKind.set(kind, [...(byKind.get(kind) ?? []), text]);
      const changes = [...byKind]
        .map(([kind, texts]) => excelRiskText(ctx, kind, listInline(ctx, texts, 3)))
        .join('; ');
      const columns = [...new Set(o.risky.flatMap(c => c.columns))]
        .sort((a, b) => a - b)
        .map(c => o.header[c]?.trim() || host.t('column {0}', String(c + 1)));
      return host.t('{0}, column(s) {1}: {2}', posix.basename(o.path), columns.join(', '), changes);
    });
  if (parts.length === 0) return '';
  const more = parts.length - EXCEL_HINT_FILES;
  const listed = parts.slice(0, EXCEL_HINT_FILES).join(' / ');
  return host.t(
    'Excel would change cells when it opens the CSV: {0}. Open the CSV with Data → From Text/CSV and set those columns to Text.',
    more > 0 ? `${listed} ${host.t('(+{0} more CSV file(s))', String(more))}` : listed
  );
}

/** CSVs and rows the dropped-cell warning names before counting the rest. */
const DROPPED_HINT_FILES = 5;
const DROPPED_HINT_ROWS = 3;

/**
 * Cells past the header width, which the CSV leaves out the way the note
 * renders the table (#76). Dropping them silently read as lost data (#510), so
 * the notice names the rows and what they lost. A `|` inside a code span is
 * the usual cause: it splits the cell unless it is written `\|`.
 */
function droppedText(ctx: CsvCtx, outputs: readonly CsvOutput[]): string {
  const { host } = ctx;
  const over = outputs.filter(o => o.dropped && o.dropped.length > 0);
  if (over.length === 0) return '';
  const parts = over.map(o => {
    const rows = o.dropped!.map(d => host.t('row {0}: {1}', String(d.row), listInline(ctx, d.cells, 3)));
    return `${posix.basename(o.path)} (${listInline(ctx, rows, DROPPED_HINT_ROWS)})`;
  });
  const more = parts.length - DROPPED_HINT_FILES;
  const listed = parts.slice(0, DROPPED_HINT_FILES).join(' / ');
  return [
    host.t(
      'These rows have more cells than the header row, and the extra ones are left out of the CSV as the note shows them: {0}. Add the missing header columns if those cells belong in the table.',
      more > 0 ? `${listed} ${host.t('(+{0} more CSV file(s))', String(more))}` : listed
    ),
    over.some(o => o.codePipe) ? host.t('A "|" inside a code span splits the cell too: write it as "\\|".') : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * Excel does not open a file whose full path is past {@link EXCEL_PATH_MAX}
 * (#348). The CSVs are still written; the notice says which is too long.
 */
function excelPathHint(ctx: CsvCtx, paths: readonly string[]): string {
  const { host } = ctx;
  const over = windowsPathsOver(ctx.vaultRoot, paths, EXCEL_PATH_MAX);
  if (over.length === 0) return '';
  const name = posix.basename(over[0].path);
  return host.t(
    'Excel cannot open a file whose path is longer than {0} characters, and {1} is {2} characters long including the vault folder. Shorten the note name or move the vault to a shorter folder path.',
    String(EXCEL_PATH_MAX),
    over.length > 1 ? host.t('{0} (+{1} more)', name, String(over.length - 1)) : name,
    String(over[0].length)
  );
}

/**
 * Where the CSVs are, so they can be found outside the app (#140): the folder
 * and the first few names, those just written first (#469). Among unchanged
 * ones, a CSV made by this export is marked new. Locked CSVs are named by
 * {@link lockedText} instead.
 */
function savedIn(ctx: CsvCtx, dir: string, outputs: readonly CsvOutput[], result: CsvWriteResult): string {
  const { host } = ctx;
  const written = outputs.filter(o => result.written.includes(o.path));
  const unchanged = outputs.filter(o => !result.written.includes(o.path) && !result.locked.includes(o.path));
  const names = [
    ...written.map(o =>
      unchanged.length > 0 && o.old === undefined ? `${posix.basename(o.path)} ${host.t('(new)')}` : posix.basename(o.path)
    ),
    ...unchanged.map(o => posix.basename(o.path)),
  ];
  if (names.length === 0) return '';
  return host.t('Saved in {0}: {1}.', dir === '.' ? '/' : `${dir}/`, listInline(ctx, names, 3));
}

/** The first `max` items joined by commas, and a count of the rest. */
function listInline(ctx: CsvCtx, items: readonly string[], max: number): string {
  const shown = items.slice(0, max).join(', ');
  return items.length > max ? ctx.host.t('{0} (+{1} more)', shown, String(items.length - max)) : shown;
}

/** CSV text without the BOM and CRLF a re-save in Excel may add or drop. */
function normalizeCsv(text: string): string {
  return text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
}

/** The header row of a CSV as shown in the overwrite prompt, cut when long. */
function firstLine(csv: string): string {
  return clip(csv.split('\n', 1)[0]);
}

/** A CSV line as shown in the overwrite prompt, cut when long. */
function clip(line: string): string {
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

/** Export tables from the currently active markdown note (command palette). */
export async function exportActiveNoteTablesToCsv(ctx: CommandContext): Promise<void> {
  const file = ctx.activePath();
  if (!file || posix.extname(file) !== '.md') {
    ctx.host.notify('info', ctx.host.t('Open a markdown note first.'));
    return;
  }
  await exportTablesToCsv(ctx, file);
}

/** Export the tables of the experiment the active note belongs to (#347, command palette). */
export async function exportActiveExperimentTablesToCsv(ctx: CommandContext): Promise<void> {
  const file = ctx.activePath();
  const dir = file ? getExperimentDir(file) : undefined;
  if (!dir) {
    ctx.host.notify('info', ctx.host.t('Open a note of an experiment first.'));
    return;
  }
  await exportExperimentTablesToCsv(ctx, dir);
}
