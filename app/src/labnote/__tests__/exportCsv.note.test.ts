// @vitest-environment jsdom
import type { NotifyKind } from '@labnoteo/core';
import { act } from '@testing-library/react';
import { setLang } from '../../i18n/lang';
import { exportTablesToCsv } from '../port/exportCsv';
import { createTestHost, type TestHost } from './testHost';

const DIR = 'exp/labnote/001_A';
const NOTE = `${DIR}/001_X.labnote.md`;
const csvOf = (n: number | string, dir = DIR) => `${dir}/001_X.labnote_table${n}.csv`;
const BOM = '﻿';

/** A Markdown table: header row, then the body rows. */
function table(rows: string[][]): string {
  const line = (r: string[]) => `| ${r.join(' | ')} |`;
  return [line(rows[0]), line(rows[0].map(() => '---')), ...rows.slice(1).map(line)].join('\n');
}

/** A note with each table after a blank line. */
function note(...tables: string[][][]): string {
  return ['# X', ...tables.map(table)].join('\n\n') + '\n';
}

interface Setup {
  th: TestHost;
  calls: Array<{ kind: NotifyKind; message: string; opts?: { ms?: number } }>;
  writes: () => string[];
  renames: () => Array<{ from: unknown; to: unknown }>;
}

function setup(files: Record<string, string>): Setup {
  const th = createTestHost(files);
  const calls: Setup['calls'] = [];
  th.host.notify = (kind, message, opts) => void calls.push({ kind, message, ...(opts ? { opts } : {}) });
  return {
    th,
    calls,
    writes: () => th.vault.log.filter((l) => l.cmd === 'vault_write').map((l) => l.args.path as string),
    renames: () => th.vault.log.filter((l) => l.cmd === 'vault_rename').map((l) => ({ from: l.args.from, to: l.args.to })),
  };
}

beforeEach(() => setLang('en'));
afterEach(() => setLang('ko'));

describe('exportTablesToCsv (one note)', () => {
  it('writes one BOM, LF CSV per table, named after the note', async () => {
    const { th, calls } = setup({
      [NOTE]: note(
        [
          ['a', 'b'],
          ['1', '2'],
        ],
        [['c'], ['x']],
      ),
    });
    await exportTablesToCsv(th.ctx, NOTE);
    const files = th.vault.files();
    expect(files[csvOf(1)]).toBe(`${BOM}a,b\n1,2\n`);
    expect(files[csvOf(2)]).toBe(`${BOM}c\nx\n`);
    expect(th.asked.confirm).toHaveLength(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].kind).toBe('info');
    expect(calls[0].opts).toBeUndefined();
    expect(calls[0].message).toContain('Exported 2 CSV file(s).');
    expect(calls[0].message).toContain(`Saved in ${DIR}/: 001_X.labnote_table1.csv, 001_X.labnote_table2.csv.`);
    expect(calls[0].message).not.toContain('Show all file types');
    expect(th.refreshes()).toBeGreaterThan(0);
  });

  it('pads numbers to sort with 11 tables and renames an old _table1.csv first', async () => {
    const tables = Array.from({ length: 11 }, (_, i) => [['h'], [String(i + 1)]]);
    const { th, calls, renames } = setup({
      [NOTE]: note(...tables),
      [csvOf(1)]: `${BOM}h\n1\n`,
    });
    await exportTablesToCsv(th.ctx, NOTE);
    expect(renames()).toEqual([{ from: csvOf(1), to: csvOf('01') }]);
    const files = th.vault.files();
    expect(files[csvOf(1)]).toBeUndefined();
    for (let i = 1; i <= 11; i++) expect(files[csvOf(String(i).padStart(2, '0'))]).toBe(`${BOM}h\n${i}\n`);
    expect(calls[0].message).toContain('001_X.labnote_table1.csv → 001_X.labnote_table01.csv');
  });

  it('leaves identical CSVs alone, also when Excel re-saved them with CRLF', async () => {
    const { th, calls, writes } = setup({
      [NOTE]: note(
        [
          ['a', 'b'],
          ['1', '2'],
        ],
        [['c'], ['x']],
      ),
      [csvOf(1)]: `${BOM}a,b\n1,2\n`,
      [csvOf(2)]: 'c\r\nx\r\n',
    });
    await exportTablesToCsv(th.ctx, NOTE);
    expect(writes()).toEqual([]);
    expect(th.asked.confirm).toHaveLength(0);
    expect(calls[0].message).toContain('The CSV files are already up to date (2).');
  });

  it('asks once about a changed header; declining writes and renames nothing', async () => {
    const { th, calls, writes, renames } = setup({
      [NOTE]: note([
        ['a', 'c'],
        ['3', '4'],
      ]),
      [csvOf(1)]: `${BOM}a,b\n1,2\n`,
    });
    th.answer.confirm(false);
    await exportTablesToCsv(th.ctx, NOTE);
    expect(th.asked.confirm).toHaveLength(1);
    expect(th.asked.confirm[0].message).toContain('The header of these CSV files changed.');
    expect(th.asked.confirm[0].message).toContain('- 001_X.labnote_table1.csv: a,b → a,c');
    expect(th.asked.confirm[0].opts).toMatchObject({ confirmLabel: 'Overwrite', destructive: true });
    expect(writes()).toEqual([]);
    expect(renames()).toEqual([]);
    expect(th.vault.files()[csvOf(1)]).toBe(`${BOM}a,b\n1,2\n`);
    expect(calls.map((c) => c.message)).toEqual(['No changes made.']);
  });

  it('accepting the header prompt overwrites the CSV', async () => {
    const { th } = setup({
      [NOTE]: note([
        ['a', 'c'],
        ['3', '4'],
      ]),
      [csvOf(1)]: `${BOM}a,b\n1,2\n`,
    });
    th.answer.confirm(true);
    await exportTablesToCsv(th.ctx, NOTE);
    expect(th.vault.files()[csvOf(1)]).toBe(`${BOM}a,c\n3,4\n`);
  });

  it('offers to trash a stale CSV; accepting moves it to the recycle bin', async () => {
    const { th, calls } = setup({
      [NOTE]: note([['a'], ['1']], [['b'], ['2']]),
      [csvOf(1)]: `${BOM}a\n1\n`,
      [csvOf(2)]: `${BOM}b\n2\n`,
      [csvOf(3)]: `${BOM}z\n9\n`,
    });
    th.answer.confirm(true);
    await exportTablesToCsv(th.ctx, NOTE);
    expect(th.asked.confirm).toHaveLength(1);
    expect(th.asked.confirm[0].message).toContain('no longer match a table in the note');
    expect(th.asked.confirm[0].message).toContain('001_X.labnote_table3.csv');
    expect(th.asked.confirm[0].opts).toMatchObject({ confirmLabel: 'Move to trash', destructive: true });
    expect(th.vault.recycleBin.map((e) => e.path)).toEqual([csvOf(3)]);
    expect(th.vault.files()[csvOf(3)]).toBeUndefined();
    expect(calls[0].message).toContain('1 CSV file(s) moved to the trash.');
  });

  it('declining the cleanup keeps the stale CSV', async () => {
    const { th, calls } = setup({
      [NOTE]: note([['a'], ['1']], [['b'], ['2']]),
      [csvOf(1)]: `${BOM}a\n1\n`,
      [csvOf(2)]: `${BOM}b\n2\n`,
      [csvOf(3)]: `${BOM}z\n9\n`,
    });
    th.answer.confirm(false);
    await exportTablesToCsv(th.ctx, NOTE);
    expect(th.vault.recycleBin).toEqual([]);
    expect(th.vault.files()[csvOf(3)]).toBe(`${BOM}z\n9\n`);
    expect(calls[0].message).toContain('1 old CSV file(s) kept.');
  });

  it('skips a locked CSV, names it first and holds a warning for 15 s', async () => {
    const { th, calls } = setup({
      [NOTE]: note([['a'], ['1']], [['b'], ['2']]),
    });
    th.vault.failNext('vault_write', 'locked');
    await exportTablesToCsv(th.ctx, NOTE);
    const files = th.vault.files();
    expect(files[csvOf(1)]).toBeUndefined();
    expect(files[csvOf(2)]).toBe(`${BOM}b\n2\n`);
    expect(calls).toHaveLength(1);
    expect(calls[0].kind).toBe('warn');
    expect(calls[0].opts).toEqual({ ms: 15000 });
    const msg = calls[0].message;
    expect(msg.startsWith('Could not write 1 CSV file(s) because another program (such as Excel)')).toBe(true);
    expect(msg).toContain('001_X.labnote_table1.csv');
    expect(msg.indexOf('Could not write')).toBeLessThan(msg.indexOf('Exported 1 CSV file(s).'));
  });

  it('a write error that is not a lock still throws', async () => {
    const { th } = setup({ [NOTE]: note([['a'], ['1']]) });
    th.vault.failNext('vault_write', 'io');
    await expect(exportTablesToCsv(th.ctx, NOTE)).rejects.toMatchObject({ kind: 'io' });
  });

  it('guards a formula cell and names the column Excel would change', async () => {
    const { th, calls } = setup({
      [NOTE]: note([
        ['F', 'Lot'],
        ['=1+1', '007'],
      ]),
    });
    await exportTablesToCsv(th.ctx, NOTE);
    expect(th.vault.files()[csvOf(1)]).toContain('"\t=1+1"');
    expect(calls[0].message).toContain('Excel would change cells when it opens the CSV');
    expect(calls[0].message).toContain('001_X.labnote_table1.csv, column(s) Lot: 007 lose their leading zeros');
  });

  it('writes the CSV and says so when its path is too long for Excel', async () => {
    const dir = `exp/labnote/001_${'x'.repeat(200)}`;
    const path = `${dir}/001_X.labnote.md`;
    const { th, calls } = setup({ [path]: note([['a'], ['1']]) });
    await exportTablesToCsv(th.ctx, path);
    expect(th.vault.files()[csvOf(1, dir)]).toBe(`${BOM}a\n1\n`);
    expect(calls[0].message).toContain('Excel cannot open a file whose path is longer than 218 characters');
    expect(calls[0].message).toContain('001_X.labnote_table1.csv is');
  });

  it('does not export a table with no blank line above it', async () => {
    const { th, calls, writes } = setup({
      [NOTE]: `# X\ntext\n${table([['a'], ['1']])}\n`,
    });
    await exportTablesToCsv(th.ctx, NOTE);
    expect(writes()).toEqual([]);
    expect(calls[0].message).toContain('No tables found in this note.');
    expect(calls[0].message).toContain('1 table(s) were not exported: with no blank line above');
  });

  it('reads the open buffer, unsaved edits included (A-R1)', async () => {
    const { th } = setup({ [NOTE]: note([['a'], ['1']]) });
    try {
      const m = await th.mount(NOTE);
      const view = m.view();
      act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: `\n${table([['b'], ['2']])}\n` } }));
      expect(th.vault.files()[NOTE]).not.toContain('| b |');
      await exportTablesToCsv(th.ctx, NOTE);
      expect(th.vault.files()[csvOf(2)]).toBe(`${BOM}b\n2\n`);
    } finally {
      th.cleanup();
    }
  });
});
