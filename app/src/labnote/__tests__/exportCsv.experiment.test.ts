// @vitest-environment jsdom
// Experiment-wide CSV export (#347), after vendor tests/plugin/exportExperimentCsv.test.ts.
import type { NotifyKind } from '@labnoteo/core';
import { setLang } from '../../i18n/lang';
import {
  exportActiveExperimentTablesToCsv,
  exportActiveNoteTablesToCsv,
  exportExperimentTablesToCsv,
} from '../port/exportCsv';
import { createTestHost, type TestHost } from './testHost';

const DIR = 'exp/labnote/001_Test';
const README = `${DIR}/README.labnote.md`;
const WF1 = `${DIR}/001_WT020_A.labnote.md`;
const WF2 = `${DIR}/002_WT030_B.labnote.md`;
const BOM = '﻿';

/** A one-column table: header, divider, then one row per cell. */
const table = (header: string, ...cells: string[]) => `| ${header} |\n|---|\n${cells.map((c) => `| ${c} |\n`).join('')}`;

interface Setup {
  th: TestHost;
  calls: Array<{ kind: NotifyKind; message: string; opts?: { ms?: number } }>;
  last: () => string;
  writes: () => string[];
  reads: () => string[];
}

function setup(files: Record<string, string>, opts: Parameters<typeof createTestHost>[2] = {}): Setup {
  const th = createTestHost(files, {}, opts);
  const calls: Setup['calls'] = [];
  th.host.notify = (kind, message, o) => void calls.push({ kind, message, ...(o ? { opts: o } : {}) });
  const logOf = (cmd: string) => th.vault.log.filter((l) => l.cmd === cmd).map((l) => l.args.path as string);
  return {
    th,
    calls,
    last: () => calls.at(-1)?.message ?? '',
    writes: () => logOf('vault_write'),
    reads: () => logOf('vault_read'),
  };
}

beforeEach(() => setLang('en'));
afterEach(() => setLang('ko'));

describe('exportExperimentTablesToCsv (#347)', () => {
  it('exports the README and every note, with a count per note', async () => {
    const { th, calls, last } = setup({
      [README]: table('요약', '1'),
      [WF1]: `${table('a', '1')}\n${table('b', '2')}`,
      [WF2]: 'no tables',
      [`${DIR}/notes.md`]: table('x', '9'),
    });
    await exportExperimentTablesToCsv(th.ctx, DIR);
    const files = th.vault.files();
    expect(files[`${DIR}/README.labnote_table1.csv`]).toBe(`${BOM}요약\n1\n`);
    expect(files[`${DIR}/001_WT020_A.labnote_table1.csv`]).toBe(`${BOM}a\n1\n`);
    expect(files[`${DIR}/001_WT020_A.labnote_table2.csv`]).toBe(`${BOM}b\n2\n`);
    // #369: a plain note in the folder too, as exporting it alone does.
    expect(files[`${DIR}/notes_table1.csv`]).toBe(`${BOM}x\n9\n`);
    expect(calls).toHaveLength(1);
    expect(calls[0].kind).toBe('info');
    expect(last()).toContain('Exported 4 CSV file(s).');
    expect(last()).toContain('Tables per note: README 1, 001_WT020_A 2, notes 1.');
    expect(last()).toContain('1 note(s) without tables were skipped.');
    expect(th.asked.confirm).toHaveLength(0);
    expect(th.refreshes()).toBeGreaterThan(0);
  });

  it('reads the README first, then the other notes by localeCompare', async () => {
    const { th, reads, last } = setup({
      [`${DIR}/b.md`]: table('b', '1'),
      [`${DIR}/A.md`]: table('a', '1'),
      [WF2]: table('w2', '1'),
      [WF1]: table('w1', '1'),
      [README]: table('r', '1'),
      [`${DIR}/data.csv`]: 'not a note\n',
    });
    await exportExperimentTablesToCsv(th.ctx, DIR);
    const noteReads = reads().filter((p) => p.endsWith('.md'));
    const rest = ['b.md', 'A.md', '002_WT030_B.labnote.md', '001_WT020_A.labnote.md'].sort((a, b) => a.localeCompare(b));
    expect(noteReads).toEqual([README, ...rest.map((n) => `${DIR}/${n}`)]);
    expect(last()).toContain(
      `Tables per note: README 1, ${rest.map((n) => `${n.replace(/(?:\.labnote)?\.md$/, '')} 1`).slice(0, 4).join(', ')}`,
    );
  });

  it('asks once to overwrite across all notes; declining writes nothing', async () => {
    const { th, writes, last } = setup({
      [WF1]: `${table('a', '1')}\n${table('b', '2')}`,
      [`${DIR}/001_WT020_A.labnote_table1.csv`]: `${BOM}b\n2\n`,
      [WF2]: table('c', '3'),
      // Header and data both differ: a header change, not an update (classifyCsvOverwrites).
      [`${DIR}/002_WT030_B.labnote_table1.csv`]: `${BOM}z\n9\n`,
    });
    th.answer.confirm(false);
    await exportExperimentTablesToCsv(th.ctx, DIR);
    expect(th.asked.confirm).toHaveLength(1);
    const msg = th.asked.confirm[0].message;
    expect(msg).toContain('would now hold a different table');
    expect(msg).toContain('- 001_WT020_A.labnote_table1.csv: b → a');
    expect(msg).toContain('- 002_WT030_B.labnote_table1.csv: z → c');
    expect(msg).toContain('The header of these CSV files changed.');
    expect(writes()).toEqual([]);
    expect(th.vault.files()[`${DIR}/001_WT020_A.labnote_table1.csv`]).toBe(`${BOM}b\n2\n`);
    expect(th.vault.files()[`${DIR}/002_WT030_B.labnote_table1.csv`]).toBe(`${BOM}z\n9\n`);
    expect(last()).toBe('No changes made.');
  });

  it('asks once about the CSVs of removed tables across all notes', async () => {
    const { th, last } = setup({
      [README]: 'no tables',
      [WF1]: table('a', '1'),
      [`${DIR}/README.labnote_table1.csv`]: `${BOM}old\n`,
      [`${DIR}/001_WT020_A.labnote_table1.csv`]: `${BOM}a\n1\n`,
      [`${DIR}/001_WT020_A.labnote_table2.csv`]: `${BOM}old\n`,
    });
    th.answer.confirm(true);
    await exportExperimentTablesToCsv(th.ctx, DIR);
    expect(th.asked.confirm).toHaveLength(1);
    expect(th.asked.confirm[0].message).toContain('no longer match a table in their notes');
    expect(th.asked.confirm[0].message).toContain('README.labnote_table1.csv\n001_WT020_A.labnote_table2.csv');
    expect(th.vault.recycleBin.map((e) => e.path).sort()).toEqual(
      [`${DIR}/001_WT020_A.labnote_table2.csv`, `${DIR}/README.labnote_table1.csv`].sort(),
    );
    expect(th.vault.files()[`${DIR}/001_WT020_A.labnote_table1.csv`]).toBe(`${BOM}a\n1\n`);
    expect(last()).toContain('2 CSV file(s) moved to the trash.');
  });

  it('offers orphan CSVs (no note of their name) together with the stale ones', async () => {
    const orphan = `${DIR}/004_WT020_A.labnote_table1.csv`;
    const stale = `${DIR}/001_WT020_A.labnote_table2.csv`;
    const { th, last } = setup({
      [WF1]: table('a', '1'),
      [stale]: `${BOM}old\n`,
      [orphan]: `${BOM}b\n2\n`,
    });
    th.answer.confirm(true);
    await exportExperimentTablesToCsv(th.ctx, DIR);
    expect(th.asked.confirm).toHaveLength(1);
    const msg = th.asked.confirm[0].message;
    expect(msg).toContain('no longer match a table in their notes');
    expect(msg).toContain('These table CSV files have no note of their name in the folder');
    expect(msg).toContain('004_WT020_A.labnote_table1.csv');
    expect(msg).toContain('001_WT020_A.labnote_table2.csv');
    expect(th.vault.recycleBin.map((e) => e.path).sort()).toEqual([orphan, stale].sort());
    expect(th.vault.files()[`${DIR}/001_WT020_A.labnote_table1.csv`]).toBe(`${BOM}a\n1\n`);
    expect(last()).toContain('2 CSV file(s) moved to the trash.');
  });

  it('says so when no note has a table', async () => {
    const { th, writes, last } = setup({ [README]: 'none', [WF1]: 'none' });
    await exportExperimentTablesToCsv(th.ctx, DIR);
    expect(writes()).toEqual([]);
    expect(last()).toBe('No tables found in the notes of 001_Test.');
  });

  it('names the notes of the tables left out (#370)', async () => {
    const { th, last } = setup({
      [README]: `${table('요약', '1')}\n%%\n${table('숨김', '2')}%%\n`,
      [WF1]: 'no tables',
      [`${DIR}/001_WT020_A.labnote_table1.csv`]: `${BOM}old\n`,
    });
    th.answer.confirm(false);
    await exportExperimentTablesToCsv(th.ctx, DIR);
    expect(last()).toContain('1 table(s) were not exported: they are inside a comment');
    expect(last()).toContain('In: README 1.');
    expect(th.asked.confirm.at(-1)?.message).toContain('no longer match a table in their notes');
    expect(last()).toContain('1 old CSV file(s) kept.');
  });

  it('adds up the locked CSVs of every note and holds the warning 15 s', async () => {
    const { th, calls, last } = setup(
      { [README]: table('요약', '1'), [WF1]: table('a', '1') },
      {
        invoke: (base) => async (cmd, args) => {
          if (cmd === 'vault_write' && String((args as { path?: string })?.path).endsWith('_table1.csv')) {
            throw { kind: 'locked', message: 'injected lock' };
          }
          return base(cmd, args);
        },
      },
    );
    await exportExperimentTablesToCsv(th.ctx, DIR);
    expect(calls).toHaveLength(1);
    expect(calls[0].kind).toBe('warn');
    expect(calls[0].opts).toEqual({ ms: 15000 });
    expect(last()).toContain(
      'Could not write 2 CSV file(s) because another program (such as Excel) has them open or they are read-only: README.labnote_table1.csv, 001_WT020_A.labnote_table1.csv.',
    );
    expect(last()).not.toContain('Exported');
    expect(last()).not.toContain('Saved in');
    expect(th.vault.files()[`${DIR}/README.labnote_table1.csv`]).toBeUndefined();
  });
});

describe('palette commands on the active note', () => {
  it('experiment export with a non-experiment active note asks to open one', async () => {
    const { th, writes, last } = setup({ 'notes/plain.md': table('a', '1') });
    th.setActive('notes/plain.md');
    await exportActiveExperimentTablesToCsv(th.ctx);
    expect(last()).toBe('Open a note of an experiment first.');
    expect(writes()).toEqual([]);
  });

  it('experiment export with no active note asks to open one', async () => {
    const { th, last } = setup({});
    th.setActive(undefined);
    await exportActiveExperimentTablesToCsv(th.ctx);
    expect(last()).toBe('Open a note of an experiment first.');
  });

  it('experiment export from a note inside the experiment exports the whole folder', async () => {
    const { th, last } = setup({ [README]: table('r', '1'), [WF1]: table('a', '1') });
    th.setActive(WF1);
    await exportActiveExperimentTablesToCsv(th.ctx);
    expect(Object.keys(th.vault.files()).filter((p) => p.endsWith('.csv')).sort()).toEqual(
      [`${DIR}/001_WT020_A.labnote_table1.csv`, `${DIR}/README.labnote_table1.csv`].sort(),
    );
    expect(last()).toContain('Tables per note: README 1, 001_WT020_A 1.');
  });

  it('single-note export with no active .md asks for a markdown note', async () => {
    const { th, writes, last } = setup({ [`${DIR}/data.csv`]: 'x\n' });
    th.setActive(undefined);
    await exportActiveNoteTablesToCsv(th.ctx);
    expect(last()).toBe('Open a markdown note first.');
    th.setActive(`${DIR}/data.csv`);
    await exportActiveNoteTablesToCsv(th.ctx);
    expect(last()).toBe('Open a markdown note first.');
    expect(writes()).toEqual([]);
  });
});
