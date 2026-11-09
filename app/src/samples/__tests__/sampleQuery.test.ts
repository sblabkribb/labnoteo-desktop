// @vitest-environment jsdom
/**
 * 정의 찾기, 정의 목록, 쓰인 곳과 범위(plan SP5 Task 18). vendor tests/plugin/sampleActions.test.ts 의
 * listSampleDefinitions 묶음과 sampleUsages / sampleUsageSpots / usageSpotLabel 사례를 앱 호스트로 옮겼다.
 * 지우기와 고치기에 딸린 부분(deleteSampleInteractive, editSampleInteractive)은 그 흐름을 옮기는 Task 20, 21 이 맡는다.
 */
import {
  heldNotesSentence,
  listSampleDefinitions,
  notesForSample,
  notesReferencingSample,
  otherExperimentsWithSample,
  resolveSampleDefinition,
  sampleUsages,
  sampleUsageSpots,
  usageSpotLabel,
} from '../../labnote/port/sampleQuery';
import { createTestHost, type TestHost } from '../../labnote/__tests__/testHost';
import { getLang, setLang } from '../../i18n/lang';
import { createSampleEnv } from '../env';
import { GLOBAL, LOCAL, NOTE, SAMPLE_VAULT } from './fixtures';

const FOLDER = 'labnote/001_Test/resources/labsamples';
const REGISTRY = `${FOLDER}/RNA.json`;
const A = 'labnote/001_Test';
const B = 'labnote/002_Other';
const RECORD = { type: 'RNA', alias: 'si KIF', descriptions: ['kd'], sources: [], location: null };
const rec = (r: object = RECORD) => JSON.stringify({ 'RNA-1': r });

let hosts: TestHost[] = [];
const host = (files: Record<string, string> = {}) => {
  const th = createTestHost(files);
  hosts.push(th);
  return th;
};
const env = (files: Record<string, string> = {}) => createSampleEnv(host(files).ctx);
const lang = getLang();
beforeEach(() => setLang('en'));
afterEach(() => {
  for (const th of hosts) th.cleanup();
  hosts = [];
  setLang(lang);
});

describe('resolveSampleDefinition', () => {
  it('resolves Local, then Global, then catalog', async () => {
    const e = env(SAMPLE_VAULT);
    expect((await resolveSampleDefinition(e, { type: 'DNA', id: 'DNA-1', docPath: NOTE }))?.scope).toBe('local');
    expect((await resolveSampleDefinition(e, { type: 'Reagent', id: 'Reagent-7', docPath: NOTE }))?.scope).toBe('global');
    const cat = await resolveSampleDefinition(e, { type: 'Reagent', id: 'Reagent-900', docPath: NOTE });
    expect(cat?.scope).toBe('catalog');
    expect(cat?.file).toBe(`${GLOBAL}/Reagent_vendor.json`);
  });

  it('returns the folder and record, and undefined for an unknown ID', async () => {
    const e = env(SAMPLE_VAULT);
    expect(await resolveSampleDefinition(e, { type: 'DNA', id: 'DNA-1', docPath: NOTE })).toMatchObject({
      folder: LOCAL,
      record: { alias: 'pUC', location: 'Freezer A / B3' },
    });
    expect(await resolveSampleDefinition(e, { type: 'DNA', id: 'DNA-404', docPath: NOTE })).toBeUndefined();
  });
});

describe('listSampleDefinitions', () => {
  const base = {
    [REGISTRY]: JSON.stringify({ 'RNA-1': { type: 'RNA', alias: 'siKIF', descriptions: ['kd'], sources: [], location: 'Freezer-2' } }),
    [`${GLOBAL}/DNA.json`]: JSON.stringify({ 'DNA-2': { type: 'DNA', alias: null, descriptions: [], sources: [] } }),
  };

  it('shows the Local samples of the note and then the Global ones as ID | alias | scope', async () => {
    const items = await listSampleDefinitions(env(base), 'labnote/001_Test/001_WD010_A.labnote.md');

    expect(items.map((i) => i.label)).toEqual(['RNA-1 | siKIF | Local RNA sample', 'DNA-2 | - | Global DNA sample']);
    expect(items[0].detail).toBe('kd');
    // #386: the location is searched ahead of the description.
    expect(items[0].description).toBe('Freezer-2');
    expect(items[1].description).toBeUndefined();
    expect(items[0].value).toMatchObject({ type: 'RNA', id: 'RNA-1', resolved: { scope: 'local', folder: FOLDER } });
  });

  it('shows only the Global samples without an open note', async () => {
    expect((await listSampleDefinitions(env(base), undefined)).map((i) => i.value.id)).toEqual(['DNA-2']);
  });

  // #448, #462
  it('puts a discarded sample, dimmed and tagged, after those in use of its scope, with every description', async () => {
    const items = await listSampleDefinitions(
      env({
        ...base,
        [REGISTRY]: JSON.stringify({
          'RNA-1': { type: 'RNA', alias: 'aaa', descriptions: ['kd'], sources: [], discarded: '2026-10-19' },
          'RNA-2': { type: 'RNA', alias: 'bbb', descriptions: ['one', 'two'], sources: [] },
        }),
      }),
      'labnote/001_Test/001_WD010_A.labnote.md',
    );

    expect(items.map((i) => i.label)).toEqual([
      'RNA-2 | bbb | Local RNA sample',
      'RNA-1 | aaa | Local RNA sample (discarded)',
      'DNA-2 | - | Global DNA sample',
    ]);
    expect(items.map((i) => i.dimmed)).toEqual([false, true, false]);
    expect(items[0].detail).toBe('one; two');
  });

  it('labels in Korean through the plugin keys', async () => {
    setLang('ko');
    const items = await listSampleDefinitions(env(base), undefined);
    expect(items[0].label.startsWith('DNA-2 | - | ')).toBe(true);
    expect(items[0].label).not.toContain('Global DNA sample');
  });
});

describe('sample usages', () => {
  it('lists the usages of a Global sample without the experiments a Local record shadows', async () => {
    const e = env({
      [`${A}/001_WD010_A.labnote.md`]: 'RNA-1;si KIF\n',
      [`${A}/002_WD020_B.labnote.md`]: 'no reference\n',
      [`${B}/resources/labsamples/RNA.json`]: rec(),
      [`${B}/001_WD010_C.labnote.md`]: 'RNA-1;si KIF\n',
    });

    expect(await sampleUsages(e, GLOBAL, 'RNA', 'RNA-1')).toEqual([`${A}/001_WD010_A.labnote.md`]);
    expect(await sampleUsages(e, `${B}/resources/labsamples`, 'RNA', 'RNA-1')).toEqual([`${B}/001_WD010_C.labnote.md`]);
  });

  // #423: a daily note at the vault root naming a Local sample was not counted.
  it('counts a note outside every experiment that uses a Local sample, unless its own registry has the ID', async () => {
    const files = {
      [`${FOLDER}/RNA.json`]: rec(),
      '2026-10-26.md': '- 로트1 RNA-1;si KIF\n',
      'Daily/2026-10-27.md': '- RNA-1;si KIF\n',
      'Daily/resources/labsamples/RNA.json': rec(),
    };
    expect(await sampleUsages(env(files), FOLDER, 'RNA', 'RNA-1')).toEqual(['2026-10-26.md']);
    expect(await sampleUsages(env({ ...files, [`${GLOBAL}/RNA.json`]: rec() }), FOLDER, 'RNA', 'RNA-1')).toEqual([]);
  });

  // #291: the list gave only paths and opened each note at its top.
  it('lists where in each note the sample is used, under the same filter', async () => {
    const e = env({
      [`${A}/001_WD010_A.labnote.md`]: '## [UHW1 PCR] 첫\n#### Input\n- RNA-1;si KIF\n#### Output\n- x RNA-1\n',
      [`${B}/resources/labsamples/RNA.json`]: rec(),
      [`${B}/001_WD010_C.labnote.md`]: 'RNA-1;si KIF\n',
    });

    const spots = await sampleUsageSpots(e, GLOBAL, 'RNA', 'RNA-1');
    expect(spots).toEqual([
      { path: `${A}/001_WD010_A.labnote.md`, line: 2, ch: 2, heading: '[UHW1 PCR] 첫 › Input' },
      { path: `${A}/001_WD010_A.labnote.md`, line: 4, ch: 4, heading: '[UHW1 PCR] 첫 › Output' },
    ]);
    expect(usageSpotLabel(e.t, spots[0])).toBe('[UHW1 PCR] 첫 › Input · line 3');
    expect(usageSpotLabel(e.t, { path: 'x', line: 0, ch: 0, heading: '' })).toBe('Line 1');
  });

  it('usage scope: a Local sample is searched in its experiment plus notes outside experiments', async () => {
    const e = env({ ...SAMPLE_VAULT, 'Home.md': 'see DNA-1\n' });
    const spots = await sampleUsageSpots(e, LOCAL, 'DNA', 'DNA-1');
    expect([...new Set(spots.map((s) => s.path))].sort()).toEqual(['Home.md', NOTE]); // 062's DNA-1 is another experiment's
  });

  it('AI callouts and list-table rows are not usages', async () => {
    const body = `> [!note] AI\n> DNA-1 was used\n\n${'| ID | Alias | Description | Location | Scope | Discarded |\n|---|---|---|---|---|---|\n| DNA-1 | pUC | | | Local | |'}\n`;
    const e = env({ ...SAMPLE_VAULT, 'labnote/061_PCR/002_x.labnote.md': body });
    expect((await sampleUsageSpots(e, LOCAL, 'DNA', 'DNA-1')).some((s) => s.path.endsWith('002_x.labnote.md'))).toBe(false);
    expect(await sampleUsages(e, LOCAL, 'DNA', 'DNA-1')).not.toContain('labnote/061_PCR/002_x.labnote.md');
  });

  it('the delete check counts AI callouts, and list-table rows unless masked', async () => {
    const ai = '> [!note] AI\n> DNA-1 was used\n';
    const table = '| ID | Alias | Description | Location | Scope | Discarded |\n|---|---|---|---|---|---|\n| DNA-1 | pUC | | | Local | |\n';
    const e = env({ ...SAMPLE_VAULT, 'labnote/061_PCR/002_ai.labnote.md': ai, 'labnote/061_PCR/003_t.labnote.md': table });
    const strict = await notesReferencingSample(e, LOCAL, 'DNA', 'DNA-1');
    expect(strict).toEqual(
      expect.arrayContaining(['labnote/061_PCR/002_ai.labnote.md', 'labnote/061_PCR/003_t.labnote.md', NOTE]),
    );
    const masked = await notesReferencingSample(e, LOCAL, 'DNA', 'DNA-1', { maskSampleLists: true });
    expect(masked).toContain('labnote/061_PCR/002_ai.labnote.md');
    expect(masked).not.toContain('labnote/061_PCR/003_t.labnote.md');
  });
});

describe('notesForSample and the held notes (#173)', () => {
  const files = {
    [`${FOLDER}/RNA.json`]: rec(),
    [`${A}/001_WD010_A.labnote.md`]: 'RNA-1;si KIF\n',
    '2026-10-26.md': 'RNA-1;si KIF\n',
  };

  it('a Global sample is searched in the whole vault', async () => {
    const { notes, held } = await notesForSample(env(files), { folder: GLOBAL, type: 'RNA', id: 'RNA-1' });
    expect(notes.map((n) => n.path).sort()).toEqual(['2026-10-26.md', `${A}/001_WD010_A.labnote.md`]);
    expect(held).toEqual([]);
  });

  it('holds back the notes outside experiments for a write when another experiment has the same ID', async () => {
    const plain = await notesForSample(env(files), { folder: FOLDER, type: 'RNA', id: 'RNA-1' }, { write: true });
    expect(plain.held).toEqual([]);
    expect(plain.notes.map((n) => n.path)).toContain('2026-10-26.md');

    const e = env({ ...files, [`${B}/resources/labsamples/RNA.json`]: rec() });
    expect(await otherExperimentsWithSample(e, FOLDER, 'RNA', 'RNA-1')).toEqual([B]);
    const held = await notesForSample(e, { folder: FOLDER, type: 'RNA', id: 'RNA-1' }, { write: true });
    expect(held.held.map((n) => n.path)).toEqual(['2026-10-26.md']);
    expect(held.notes.map((n) => n.path)).toEqual([`${A}/001_WD010_A.labnote.md`]);
    // Without `write` (a usage list), they still count.
    expect((await notesForSample(e, { folder: FOLDER, type: 'RNA', id: 'RNA-1' })).held).toEqual([]);
  });

  it('heldNotesSentence uses the plugin sentence', () => {
    expect(heldNotesSentence(env(), 1)).toBe(
      'Another experiment has a sample with the same ID, so 1 note(s) outside experiments are left as they are.',
    );
  });
});
