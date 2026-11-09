// @vitest-environment jsdom
import { act } from '@testing-library/react';
import type { SampleInfo, SampleRecord } from '@labnoteo/core/lib/sampleStorage';
import { getLang, setLang } from '../../i18n/lang';
import { coreT } from '../../labnote/i18n';
import {
  listSome,
  sampleListHeaders,
  sampleListRow,
  sampleLocationText,
  unregisteredReferences,
  updateSampleListTables,
} from '../../labnote/port/sampleListTable';
import { notesInSampleScope, resolveScopeFolder, validateAlias } from '../../labnote/port/sampleScope';
import { createTestHost, type TestHost } from '../../labnote/__tests__/testHost';
import { rememberExperiment } from '../../labnote/port/sampleFolders';
import { createSampleEnv } from '../env';
import { CONFLICTED, GLOBAL, LOCAL, NOTE, SAMPLE_VAULT } from './fixtures';

const HEAD = '| ID | Alias | Description | Location | Scope | Discarded |\n|---|---|---|---|---|---|\n';

let hosts: TestHost[] = [];
const host = (...a: Parameters<typeof createTestHost>) => {
  const th = createTestHost(...a);
  hosts.push(th);
  return th;
};
const lang = getLang();
beforeEach(() => setLang('en'));
afterEach(() => {
  for (const th of hosts) th.cleanup();
  hosts = [];
  rememberExperiment(undefined);
  setLang(lang);
});

describe('sampleListHeaders', () => {
  it('headers: UI language first, then ko and en', () => {
    setLang('ko');
    const sets = sampleListHeaders({ t: coreT });
    expect(sets[0]).toEqual(['ID', '별칭', '설명', '보관 위치', '범위', '폐기']);
    expect(sets.at(-1)).toEqual(['ID', 'Alias', 'Description', 'Location', 'Scope', 'Discarded']);
  });

  it('drops a duplicate set: in English the UI set is the English one', () => {
    const sets = sampleListHeaders({ t: coreT });
    expect(sets).toHaveLength(2);
    expect(sets[0]).toEqual(['ID', 'Alias', 'Description', 'Location', 'Scope', 'Discarded']);
    expect(sets[1]).toEqual(['ID', '별칭', '설명', '보관 위치', '범위', '폐기']);
  });
});

describe('sampleLocationText and sampleListRow', () => {
  const rec = (r: Partial<SampleRecord>): SampleRecord => ({ type: 'DNA', alias: null, descriptions: [], sources: [], ...r }) as SampleRecord;

  it('shows the stored location, or the emptied one of a discarded sample (#458)', () => {
    expect(sampleLocationText({ t: coreT }, rec({ location: 'Freezer A / B3' }))).toBe('Freezer A / B3');
    expect(sampleLocationText({ t: coreT }, rec({ discardedLocation: 'Box 2' }))).toBe('(emptied, was Box 2)');
    expect(sampleLocationText({ t: coreT }, rec({}))).toBe('');
  });

  it('builds the row in header order, descriptions joined with "; " (#462)', () => {
    const r = rec({ alias: 'pUC', descriptions: ['a', 'b'], location: 'F1', discarded: '2026-10-01' });
    expect(sampleListRow({ t: coreT }, 'DNA-1', r, 'global')).toEqual(['DNA-1', 'pUC', 'a; b', 'F1', 'Global', '2026-10-01']);
    expect(sampleListRow({ t: coreT }, 'DNA-1', rec({}), 'local')).toEqual(['DNA-1', '', '', '', 'Local', '']);
  });
});

describe('updateSampleListTables', () => {
  it('updateSampleListTables rewrites the row of one sample in its experiment and returns the count', async () => {
    const table = `${HEAD}| DNA-1 | old | | | Local | |\n`;
    const th = host({ ...SAMPLE_VAULT, [NOTE]: SAMPLE_VAULT[NOTE] + '\n' + table });
    expect(await updateSampleListTables(createSampleEnv(th.ctx), { folder: LOCAL, type: 'DNA', id: 'DNA-1' })).toBe(1);
    expect(th.vault.files()[NOTE]).toContain('| DNA-1 | pUC | miniprep | Freezer A / B3 | Local |  |');
  });

  // vendor "rewrites the sample's row … when a value changed" / "leaves the tables alone when nothing changed" (#463)
  it('leaves a row that already matches the registry alone', async () => {
    const before = `${HEAD}| DNA-1 | pUC | miniprep | Freezer A / B3 | Local |  |\n`;
    const th = host({ ...SAMPLE_VAULT, [NOTE]: before });
    expect(await updateSampleListTables(createSampleEnv(th.ctx), { folder: LOCAL, type: 'DNA', id: 'DNA-1' })).toBe(0);
    expect(th.vault.files()[NOTE]).toBe(before);
  });

  it('a Local sample only touches the notes of its experiment', async () => {
    const other = 'labnote/062_Gel/002_t.labnote.md';
    const table = `${HEAD}| DNA-1 | old | | | Local | |\n`;
    const th = host({ ...SAMPLE_VAULT, [NOTE]: table, [other]: table });
    expect(await updateSampleListTables(createSampleEnv(th.ctx), { folder: LOCAL, type: 'DNA', id: 'DNA-1' })).toBe(1);
    expect(th.vault.files()[other]).toBe(table);
  });

  it('a Global sample is skipped where a Local record of the same id shadows it', async () => {
    const global = '{"DNA-1":{"type":"DNA","alias":"glob","descriptions":[],"sources":[]}}';
    const table = `${HEAD}| DNA-1 | old | | | Global | |\n`;
    const home = 'Notes/list.md';
    const th = host({ ...SAMPLE_VAULT, [`${GLOBAL}/DNA.json`]: global, [NOTE]: table, [home]: table });
    expect(await updateSampleListTables(createSampleEnv(th.ctx), { folder: GLOBAL, type: 'DNA', id: 'DNA-1' })).toBe(1);
    expect(th.vault.files()[NOTE]).toBe(table); // 061 has its own DNA-1
    expect(th.vault.files()[home]).toContain('| DNA-1 | glob |  |  | Global |  |');
  });

  it('notesOf picks the folder whose notes are read', async () => {
    const table = `${HEAD}| DNA-1 | old | | | Local | |\n`;
    const th = host({ ...SAMPLE_VAULT, 'labnote/062_Gel/002_t.labnote.md': table });
    const env = createSampleEnv(th.ctx);
    expect(await updateSampleListTables(env, { folder: LOCAL, type: 'DNA', id: 'DNA-1', notesOf: 'labnote/062_Gel/resources/labsamples' })).toBe(1);
    expect(th.vault.files()['labnote/062_Gel/002_t.labnote.md']).toContain('| DNA-1 | pUC | miniprep |');
  });

  it('returns 0 and writes nothing when the sample is not in the registry, or the registry is unreadable', async () => {
    const table = `${HEAD}| DNA-1 | old | | | Local | |\n`;
    const th = host({ ...SAMPLE_VAULT, [NOTE]: table, [`${LOCAL}/DNA.json`]: CONFLICTED });
    const env = createSampleEnv(th.ctx);
    expect(await updateSampleListTables(env, { folder: LOCAL, type: 'DNA', id: 'DNA-1' })).toBe(0);
    expect(await updateSampleListTables(env, { folder: LOCAL, type: 'DNA', id: 'DNA-404' })).toBe(0);
    expect(th.vault.files()[NOTE]).toBe(table);
    expect(th.vault.files()[`${LOCAL}/DNA.json`]).toBe(CONFLICTED);
  });

  it('an open note is rewritten through its editor buffer, unsaved text kept', async () => {
    const table = `${HEAD}| DNA-1 | old | | | Local | |\n`;
    const th = host({ ...SAMPLE_VAULT, [NOTE]: table });
    const m = await th.mount(NOTE);
    act(() => m.view().dispatch({ changes: { from: 0, insert: 'typed\n' } }));
    let n = -1;
    await act(async () => void (n = await updateSampleListTables(createSampleEnv(th.ctx), { folder: LOCAL, type: 'DNA', id: 'DNA-1' })));
    expect(n).toBe(1);
    expect(m.view().state.doc.toString()).toMatch(/^typed\n/);
    expect(m.view().state.doc.toString()).toContain('| DNA-1 | pUC | miniprep | Freezer A / B3 | Local |  |');
  });
});

describe('notesInSampleScope', () => {
  it('a Local folder is its experiment; outsideExperiments adds the notes outside every experiment', async () => {
    const env = createSampleEnv(host(SAMPLE_VAULT).ctx);
    expect((await notesInSampleScope(env, LOCAL)).map((n) => n.path).sort()).toEqual([
      NOTE,
      'labnote/061_PCR/README.labnote.md',
    ]);
    expect((await notesInSampleScope(env, LOCAL, { outsideExperiments: true })).map((n) => n.path).sort()).toEqual([
      'Home.md',
      NOTE,
      'labnote/061_PCR/README.labnote.md',
    ]);
    expect((await notesInSampleScope(env, GLOBAL)).length).toBe(5);
    expect((await notesInSampleScope(env, LOCAL)).find((n) => n.path === NOTE)?.text).toBe(SAMPLE_VAULT[NOTE]);
  });
});

describe('sample scope', () => {
  it('resolveScopeFolder: Global is the settings folder, Local the active note experiment', () => {
    const th = host(SAMPLE_VAULT, { globalSampleFolder: 'shared/labsamples/' });
    th.setActive(NOTE);
    const env = createSampleEnv(th.ctx);
    expect(resolveScopeFolder(env, 'global')).toBe('shared/labsamples');
    expect(resolveScopeFolder(env, 'local')).toBe(LOCAL);
  });

  it('validateAlias blocks separators (#98) and Markdown (#168)', () => {
    const v = validateAlias({ t: coreT });
    expect(v('1-10')).toBeNull();
    expect(v('a;b')).toContain('";" or ":"');
    expect(v('a:b')).toContain('";" or ":"');
    expect(v('#tag')).toContain('Markdown');
  });
});

// #238: the sample list left out references the registry does not have without a word.
describe('unregisteredReferences', () => {
  const ref = (id: string, alias: string | null = null) =>
    ({ id, type: 'RNA', alias, description: null, definition: false }) as unknown as SampleInfo;

  it('lists each reference the registries do not have once, with its alias', () => {
    const refs = [ref('RNA-1', 'siKIF'), ref('RNA-9', '집락B'), ref('rna-9'), ref('Reagent-1001'), ref('RNA-7')];
    expect(unregisteredReferences(refs, new Set(['rna-1', 'reagent-1001']))).toEqual(['RNA-9;집락B', 'RNA-7']);
  });
});

describe('listSome', () => {
  it('lists up to five, then an ellipsis', () => {
    expect(listSome(['a', 'b'])).toBe('a, b');
    expect(listSome(['1', '2', '3', '4', '5', '6'])).toBe('1, 2, 3, 4, 5, …');
    expect(listSome(['1', '2', '3'], 2)).toBe('1, 2, …');
  });
});
