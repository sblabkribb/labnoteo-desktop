// @vitest-environment jsdom
/**
 * vendor tests/plugin/sampleIdIndex.test.ts 의 모든 경우를 앱 TestHost 의 fs 위로 옮기고,
 * 계획 Task 5 의 공용 보관함(SAMPLE_VAULT) 경우를 더한다.
 */
import { createTestHost, type TestHost } from '../../labnote/__tests__/testHost';
import { SampleIdIndex } from '../../labnote/port/sampleIdIndex';
import { sampleTypesFor } from '../types';
import { CONFLICTED, GLOBAL, LOCAL, NOTE, SAMPLE_VAULT } from './fixtures';

const waitFor = vi.waitFor;

let hosts: TestHost[] = [];
const host = (files: Record<string, string>) => {
  const th = createTestHost(files);
  hosts.push(th);
  return th;
};
afterEach(() => {
  for (const th of hosts) th.cleanup();
  hosts = [];
});

describe('vendor SampleIdIndex cases', () => {
  const EXP = 'labnote/001_Test';
  const VLOCAL = `${EXP}/resources/labsamples`;
  const VNOTE = `${EXP}/001_WD010_A.labnote.md`;
  const json = (ids: string[]) => JSON.stringify(Object.fromEntries(ids.map((id) => [id, { alias: null }])));

  function setup(files: Record<string, string>) {
    const fs = host(files).host.fs;
    const onChange = vi.fn();
    const index = new SampleIdIndex(fs, {
      globalFolder: () => GLOBAL,
      types: () => ['DNA', 'Reagent'],
      onChange,
      delayMs: 0,
    });
    return { fs, index, onChange };
  }

  async function known(index: SampleIdIndex, path = VNOTE) {
    await waitFor(() => expect(index.knownFor(path)).toBeDefined());
    return index.knownFor(path)!;
  }

  it('joins the Local and Global registries and the catalogs, lower-cased', async () => {
    const { index } = setup({
      [`${VLOCAL}/DNA.json`]: json(['DNA-1']),
      [`${GLOBAL}/DNA.json`]: json(['dna-2']),
      [`${GLOBAL}/Reagent_sigma.json`]: json(['Reagent-1001']),
    });
    expect(index.knownFor(VNOTE)).toBeUndefined();
    expect([...(await known(index)).ids].sort()).toEqual(['dna-1', 'dna-2', 'reagent-1001']);
  });

  it('keeps the registry aliases, the Local one first, without the catalogs (#239)', async () => {
    const { index } = setup({
      [`${VLOCAL}/DNA.json`]: JSON.stringify({ 'DNA-1': { alias: 'local' } }),
      [`${GLOBAL}/DNA.json`]: JSON.stringify({ 'DNA-1': { alias: 'global' }, 'DNA-2': { alias: null } }),
      [`${GLOBAL}/Reagent_sigma.json`]: json(['Reagent-1001']),
    });
    expect((await known(index)).aliases).toEqual(
      new Map([
        ['dna-1', 'local'],
        ['dna-2', ''],
      ]),
    );
  });

  it('takes the discard date from the record that gives the alias (#330)', async () => {
    const { index } = setup({
      [`${VLOCAL}/DNA.json`]: JSON.stringify({ 'DNA-1': { alias: 'a' } }),
      [`${GLOBAL}/DNA.json`]: JSON.stringify({
        'DNA-1': { alias: 'a', discarded: '2026-10-01' },
        'DNA-2': { alias: null, discarded: '2026-10-25' },
      }),
    });
    expect((await known(index)).discarded).toEqual(new Map([['dna-2', '2026-10-25']]));
  });

  it('covers lab notes only', async () => {
    const { index, onChange } = setup({ [`${GLOBAL}/DNA.json`]: json(['DNA-1']) });
    expect(index.knownFor('QUICKSTART.md')).toBeUndefined();
    expect(index.knownFor(`${EXP}/notes.md`)).toBeUndefined();
    expect(index.knownFor(undefined)).toBeUndefined();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('answers nothing for a note whose registry cannot be read, and keeps that answer', async () => {
    const { fs, index, onChange } = setup({ [`${VLOCAL}/DNA.json`]: '<<<<<<< HEAD\n{}\n' });
    const read = vi.spyOn(fs, 'read');
    index.knownFor(VNOTE);
    // One read each for the Local and the Global folder.
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(2));
    const reads = read.mock.calls.length;
    expect(index.knownFor(VNOTE)).toBeUndefined();
    expect(index.knownFor(VNOTE)).toBeUndefined();
    expect(read.mock.calls.length).toBe(reads);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('reads a folder once however often it is asked, and caches an empty one', async () => {
    const { fs, index, onChange } = setup({});
    const list = vi.spyOn(fs, 'exists');
    index.knownFor(VNOTE);
    index.knownFor(VNOTE);
    const first = await known(index);
    const calls = list.mock.calls.length;
    expect(first.ids.size).toBe(0);
    expect(index.knownFor(VNOTE)).toBe(first);
    expect(list.mock.calls.length).toBe(calls);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('reads the registries again once after an invalidation, with a new version', async () => {
    const { fs, index, onChange } = setup({ [`${VLOCAL}/DNA.json`]: json(['DNA-1']) });
    const before = await known(index);
    const calls = onChange.mock.calls.length;
    await fs.write(`${VLOCAL}/DNA.json`, json(['DNA-1', 'DNA-2']));
    index.invalidate();
    index.fileChanged(`${VLOCAL}/DNA.json`);
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(calls + 1));
    const after = index.knownFor(VNOTE)!;
    expect(after.version).toBeGreaterThan(before.version);
    expect(after.ids.has('dna-2')).toBe(true);
  });

  it('ignores files outside the registries it has read', async () => {
    const { index, onChange } = setup({});
    await known(index);
    const calls = onChange.mock.calls.length;
    index.fileChanged(`${EXP}/001_WD010_A.labnote.md`);
    index.fileChanged('other/resources/labsamples/DNA.json');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(onChange).toHaveBeenCalledTimes(calls);
  });
});

describe('SampleIdIndex on the shared sample vault', () => {
  const opts = (extra = {}) => ({
    globalFolder: () => GLOBAL,
    types: () => sampleTypesFor({ customSampleTypes: [] }),
    onChange: () => {},
    delayMs: 0,
    ...extra,
  });

  it('a folder with an unreadable registry is unknown', async () => {
    const th = host({ ...SAMPLE_VAULT, [`${LOCAL}/DNA.json`]: CONFLICTED });
    const idx = new SampleIdIndex(th.host.fs, opts());
    idx.knownFor(NOTE);
    await new Promise((r) => setTimeout(r, 20));
    expect(idx.knownFor(NOTE)).toBeUndefined();
    expect(await th.host.fs.read(`${LOCAL}/DNA.json`)).toBe(CONFLICTED);
  });

  it('knows Local, Global and catalog IDs lower-cased, with aliases and discard dates', async () => {
    const idx = new SampleIdIndex(host(SAMPLE_VAULT).host.fs, opts());
    idx.knownFor(NOTE);
    await waitFor(() => expect(idx.knownFor(NOTE)).toBeDefined());
    const k = idx.knownFor(NOTE)!;
    expect([...k.ids].sort()).toEqual(['dna-1', 'reagent-7', 'reagent-900']);
    expect(k.aliases.get('dna-1')).toBe('pUC');
    expect(k.discarded.get('reagent-7')).toBe('2026-10-01');
  });

  it('fileChanged re-reads one registry and calls onChange', async () => {
    const onChange = vi.fn();
    const th = host(SAMPLE_VAULT);
    const idx = new SampleIdIndex(th.host.fs, opts({ onChange }));
    idx.knownFor(NOTE);
    await waitFor(() => expect(idx.knownFor(NOTE)).toBeDefined());
    await th.host.fs.write(`${LOCAL}/DNA.json`, '{"DNA-2":{"type":"DNA","alias":"","descriptions":[],"sources":[]}}');
    idx.fileChanged(`${LOCAL}/DNA.json`);
    await waitFor(() => expect(idx.knownFor(NOTE)?.ids.has('dna-2')).toBe(true));
    expect(onChange).toHaveBeenCalled();
  });
});
