// @vitest-environment jsdom
/**
 * 샘플 만들기, 카탈로그 고르기, 직접 입력(plan SP5 Task 16). vendor tests/plugin/sampleActions.test.ts 의
 * createSampleInteractive 묶음(만들기, 별칭 겹침, 보관 칸 겹침, 입력한 글 채우기, 있는 ID 다시 넣기)을 앱 호스트로 옮겼다.
 * 대화상자의 답은 `th.answer.prompt/confirm/pick` 으로 차례로 적는다(답이 떨어지면 닫은 것처럼 undefined / false).
 */
import { createSampleInteractive, pickCatalogReference } from '../../labnote/port/sampleCreate';
import { validateAlias } from '../../labnote/port/sampleScope';
import { createTestHost, type TestHost } from '../../labnote/__tests__/testHost';
import { rememberExperiment } from '../../labnote/port/sampleFolders';
import { resetIdCounter } from '@labnoteo/core/lib/sampleUtils';
import { coreT } from '../../labnote/i18n';
import { getLang, setLang } from '../../i18n/lang';
import { t } from '../../i18n/t';
import { installSampleActionRunners } from '../actionRunners';
import { createSampleEnv, RegistryUnreadableError, sampleEvents } from '../env';
import { sampleActionRunners } from '../sources';
import { CONFLICTED, LOCAL, NOTE, SAMPLE_VAULT } from './fixtures';

const FOLDER = 'labnote/001_Test/resources/labsamples';
const REGISTRY = `${FOLDER}/RNA.json`;
const GLOBAL = 'resources/labsamples';

let hosts: TestHost[] = [];
let events = 0;
let offEvents: () => void = () => undefined;
const host = (files: Record<string, string> = {}) => {
  const th = createTestHost(files);
  hosts.push(th);
  return th;
};
const lang = getLang();
beforeEach(() => {
  // 코어의 ID 생성기는 모든 종류가 한 시각/카운터를 나눠 쓴다: 앞 테스트가 같은 밀리초에 만든 ID 가 `-1` 을 붙이지 않게.
  resetIdCounter();
  setLang('en');
  events = 0;
  offEvents = sampleEvents.subscribe(() => void events++);
});
afterEach(() => {
  offEvents();
  for (const th of hosts) th.cleanup();
  hosts = [];
  rememberExperiment(undefined);
  vi.restoreAllMocks();
  setLang(lang);
});

const json = (th: TestHost, p: string) => JSON.parse(th.vault.files()[p]);
const messages = (th: TestHost) => th.notes.map((n) => n.message);
const add = (th: TestHost, folder = FOLDER) =>
  createSampleInteractive(createSampleEnv(th.ctx), { type: 'RNA', folder, mode: 'generate' });

describe('createSampleInteractive', () => {
  it.each([
    ['alias', [undefined], 1],
    ['description', ['R1', undefined], 2],
    ['location', ['R1', 'note', undefined], 3],
  ] as const)('registers nothing when the %s prompt is closed', async (_step, values, prompts) => {
    const th = host();
    th.answer.prompt(...values);

    expect(await add(th)).toBeUndefined();
    expect(th.asked.prompt).toHaveLength(prompts);
    expect(th.vault.files()[REGISTRY]).toBeUndefined();
    expect(events).toBe(0);
  });

  it('registers a blank sample when every prompt is submitted empty', async () => {
    const th = host();
    th.answer.prompt('', '', '');

    const created = await add(th);
    expect(created?.alias).toBeNull();
    expect(json(th, REGISTRY)[created!.id]).toMatchObject({ alias: null, descriptions: [], location: null });
  });

  it('stores what was entered and tells the index', async () => {
    const th = host();
    th.answer.prompt(' R1 ', 'first run', 'Freezer-2 / Box-3 / A1');

    const created = await add(th);
    expect(json(th, REGISTRY)[created!.id]).toMatchObject({
      alias: 'R1',
      descriptions: ['first run'],
      location: 'Freezer-2 / Box-3 / A1',
    });
    expect(events).toBe(1);
    expect(messages(th)).toContain(`Sample added: ${created!.id}`);
  });

  it('generate → alias → description → location writes the Local registry and returns the reference', async () => {
    const th = host(SAMPLE_VAULT);
    th.setActive(NOTE);
    vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
    th.answer.prompt('pBR', 'backbone', 'Freezer A / C1');
    const created = await createSampleInteractive(createSampleEnv(th.ctx), { type: 'DNA', folder: LOCAL, mode: 'generate', scope: 'local' });
    expect(created?.referenceText).toBe('DNA-1700000000000;pBR');
    expect(JSON.parse(th.vault.files()[`${LOCAL}/DNA.json`])['DNA-1700000000000']).toMatchObject({
      alias: 'pBR',
      descriptions: ['backbone'],
      location: 'Freezer A / C1',
    });
  });

  it('says a vault-root sample went to Global', async () => {
    const th = host();
    th.answer.prompt('', '', '');
    const created = await createSampleInteractive(createSampleEnv(th.ctx), { type: 'RNA', folder: GLOBAL, mode: 'generate', scope: 'local' });
    expect(messages(th)).toContain(`${created!.id} was added to Global samples because this note is outside an experiment folder.`);
  });

  it('refuses a folder Windows cannot hold before asking anything (#328)', async () => {
    const th = host();
    expect(await add(th, 'labnote/a:b/resources/labsamples')).toBeUndefined();
    expect(th.asked.prompt).toHaveLength(0);
    expect(th.notes[0]).toMatchObject({ kind: 'warn' });
    expect(th.notes[0].message).toContain('Samples cannot be saved in "labnote/a:b/resources/labsamples"');
  });

  it('create refuses over a conflicted registry', async () => {
    const th = host({ ...SAMPLE_VAULT, [`${LOCAL}/DNA.json`]: CONFLICTED });
    th.answer.prompt('DNA-5', 'pBR', 'backbone', 'Freezer A / C1');
    await expect(
      createSampleInteractive(createSampleEnv(th.ctx), { type: 'DNA', folder: LOCAL, mode: 'manual', scope: 'local', initial: 'DNA-5' }),
    ).rejects.toBeInstanceOf(RegistryUnreadableError);
    // Refused before the first prompt, so nothing typed is lost (like #328).
    expect(th.asked.prompt).toHaveLength(0);
    expect(th.vault.files()[`${LOCAL}/DNA.json`]).toBe(CONFLICTED);
  });

  // #512
  describe('a storage slot another sample is in', () => {
    const SLOT = { [REGISTRY]: JSON.stringify({ 'RNA-9': { type: 'RNA', alias: 'kept', descriptions: [], sources: [], location: '-80 / P1 / A1' } }) };

    it('occupied slot asks before taking it, and registers nothing when declined', async () => {
      const th = host(SLOT);
      th.answer.confirm(false);
      th.answer.prompt('R1', '', '-80 / p1 / a1');

      expect(await add(th)).toBeUndefined();

      // #553: the sample in the slot, and the one being saved, by alias first.
      expect(th.asked.confirm[0].message).toMatch(
        /^kept \(RNA-9, Local RNA sample\) is already stored at -80 \/ p1 \/ a1\. Save R1 \(RNA-[^)]+\) anyway\?$/,
      );
      expect(th.asked.confirm[0].opts).toEqual({ confirmLabel: 'Save anyway' });
      expect(Object.keys(json(th, REGISTRY))).toEqual(['RNA-9']);
    });

    it('saves it once confirmed', async () => {
      const th = host(SLOT);
      th.answer.confirm(true);
      th.answer.prompt('R1', '', '-80 / P1 / A1');

      const created = await add(th);

      expect(json(th, REGISTRY)[created!.id]).toMatchObject({ location: '-80 / P1 / A1' });
    });

    it('discarded sample frees its slot; a free slot or a whole box asks nothing', async () => {
      const th = host({
        ...SLOT,
        [`${GLOBAL}/DNA.json`]: JSON.stringify({
          'DNA-3': { type: 'DNA', descriptions: [], sources: [], location: '-80 / P1 / B2', discarded: '2026-10-25' },
        }),
      });
      th.answer.prompt('R1', '', '-80 / P1 / A2');
      await add(th);
      th.answer.prompt('R2', '', '-80 / P1 / B2');
      await add(th);
      th.answer.prompt('R3', '', '-80 / P1');
      await add(th);

      expect(th.asked.confirm).toHaveLength(0);
    });

    it('finds the sample holding the slot in the Global registry too', async () => {
      const th = host({
        ...SLOT,
        [`${GLOBAL}/DNA.json`]: JSON.stringify({ 'DNA-3': { type: 'DNA', descriptions: [], sources: [], location: '-80 / P1 / C3' } }),
      });
      th.answer.confirm(false);
      th.answer.prompt('R1', '', '-80 / P1 / C3');

      expect(await add(th)).toBeUndefined();

      expect(th.asked.confirm[0].message).toContain('DNA-3 (Global DNA sample) is already stored at -80 / P1 / C3. Save R1 (RNA-');
    });

    it('names a sample without an alias by its ID alone (#553)', async () => {
      const th = host({
        [`${GLOBAL}/DNA.json`]: JSON.stringify({ 'DNA-3': { type: 'DNA', descriptions: [], sources: [], location: '-80 / P1 / C3' } }),
      });
      th.answer.confirm(false);
      th.answer.prompt('', '', '-80 / P1 / C3');

      expect(await add(th)).toBeUndefined();

      expect(th.asked.confirm[0].message).toMatch(/^DNA-3 \(Global DNA sample\) is already stored at -80 \/ P1 \/ C3\. Save RNA-[^ ]+ anyway\?$/);
    });
  });

  // #109
  it('warns, without refusing, when a Global sample has the same alias', async () => {
    const th = host({ [`${GLOBAL}/RNA.json`]: JSON.stringify({ 'RNA-7': { type: 'RNA', alias: 'siKIF', descriptions: [], sources: [] } }) });
    th.answer.prompt(' sikif ', '', '');

    const created = await add(th);

    expect(messages(th)[0]).toBe(
      'Global samples already have the alias sikif (RNA-7). Autocomplete will show both, marked Local and Global.',
    );
    expect(json(th, REGISTRY)[created!.id].alias).toBe('sikif');
  });

  it('asks about a same-alias Global sample when adding to Global', async () => {
    const th = host({ [`${GLOBAL}/RNA.json`]: JSON.stringify({ 'RNA-7': { type: 'RNA', alias: 'siKIF', descriptions: [], sources: [] } }) });
    th.answer.prompt('siKIF', '', '');
    th.answer.pick(() => null);

    await add(th, GLOBAL);

    expect(th.asked.pick[0].opts).toMatchObject({ title: 'Global samples already have the alias siKIF (RNA-7).' });
  });

  // #125, #248
  it('duplicate alias asks before creating, and creates on "anyway"', async () => {
    const th = host({
      [REGISTRY]: JSON.stringify({ 'RNA-3': { type: 'RNA', alias: '배지성분-1', descriptions: [], sources: [] } }),
      [`${GLOBAL}/RNA.json`]: JSON.stringify({ 'RNA-7': { type: 'RNA', alias: '배지성분-1', descriptions: [], sources: [] } }),
    });
    th.answer.prompt('배지성분-1', '', '');
    th.answer.pick(() => null);

    const created = await add(th);

    expect(th.asked.pick[0].opts).toMatchObject({ title: 'This experiment already has the alias 배지성분-1 (RNA-3).' });
    expect(messages(th).some((m) => m.includes('marked Local and Global'))).toBe(false);
    expect(created?.reused).toBeUndefined();
    expect(Object.keys(json(th, REGISTRY))).toContain(created!.id);
  });

  it('inserts the existing sample, asking nothing else and writing nothing, on "use the existing one"', async () => {
    const reg = JSON.stringify({ 'RNA-3': { type: 'RNA', alias: '배지성분-1', descriptions: ['first run'], sources: [] } });
    const th = host({ [REGISTRY]: reg });
    th.answer.prompt('배지성분-1');
    th.answer.pick('RNA-3');

    const created = await add(th);

    expect(created).toMatchObject({
      id: 'RNA-3',
      alias: '배지성분-1',
      description: 'first run',
      referenceText: 'RNA-3;배지성분-1',
      reused: true,
    });
    expect(th.asked.prompt).toHaveLength(1);
    expect(th.vault.files()[REGISTRY]).toBe(reg);
    expect(messages(th)).toContain('Using the existing sample RNA-3 instead of creating one.');
    expect(messages(th).some((m) => m.includes('Sample added'))).toBe(false);
  });

  // #274
  it('lists every sample that has the alias, with its description and location', async () => {
    const th = host({
      [REGISTRY]: JSON.stringify({
        'RNA-3': { type: 'RNA', alias: 'R1', descriptions: ['first run'], sources: [], location: 'Freezer-1' },
        'RNA-4': { type: 'RNA', alias: 'r1', descriptions: [], sources: [] },
        'RNA-5': { type: 'RNA', alias: 'R2', descriptions: [], sources: [] },
      }),
    });
    th.answer.prompt('R1');
    th.answer.pick('RNA-4');

    const created = await add(th);

    const { items, opts } = th.asked.pick[0];
    expect(opts).toMatchObject({ title: '2 samples in this experiment already have the alias R1 (RNA-3, RNA-4).' });
    expect(items).toEqual([
      { label: 'Use the existing sample RNA-3', value: 'RNA-3', description: 'first run · Freezer-1' },
      { label: 'Use the existing sample RNA-4', value: 'RNA-4', description: 'Nothing is registered; its ID goes where this one would have.' },
      expect.objectContaining({ label: 'Create a new sample anyway', value: null }),
    ]);
    expect(created).toMatchObject({ id: 'RNA-4', referenceText: 'RNA-4;r1', reused: true });
    expect(Object.keys(json(th, REGISTRY))).toEqual(['RNA-3', 'RNA-4', 'RNA-5']);
  });

  // #419
  it('offers discarded samples with the alias below "Create a new sample anyway", marked', async () => {
    const th = host({
      [REGISTRY]: JSON.stringify({
        'RNA-3': { type: 'RNA', alias: 'R1', descriptions: ['old'], sources: [], discarded: '2026-10-25' },
        'RNA-4': { type: 'RNA', alias: 'R1', descriptions: ['new'], sources: [] },
      }),
    });
    th.answer.prompt('R1');

    await add(th);

    const { items, opts } = th.asked.pick[0];
    expect(opts).toMatchObject({ title: '2 samples in this experiment already have the alias R1 (RNA-3 (discarded), RNA-4).' });
    expect(items.map((i) => i.value)).toEqual(['RNA-4', null, 'RNA-3']);
    expect(items[2]).toEqual({
      label: 'Use the existing sample RNA-3 (discarded)',
      value: 'RNA-3',
      description: 'Marked discarded on 2026-10-25 · old',
    });
  });

  it('says when only discarded samples have the alias, offering a new one first', async () => {
    const th = host({
      [REGISTRY]: JSON.stringify({ 'RNA-3': { type: 'RNA', alias: 'R1', descriptions: [], sources: [], discarded: '2026-10-25' } }),
    });
    th.answer.prompt('R1');

    await add(th);

    const { items, opts } = th.asked.pick[0];
    expect(opts).toMatchObject({ title: 'Only discarded samples have the alias R1 (RNA-3).' });
    expect(items[0]).toMatchObject({ label: 'Create a new sample anyway', value: null });
  });

  it('names every Global sample with the alias when adding to Local', async () => {
    const th = host({
      [`${GLOBAL}/RNA.json`]: JSON.stringify({
        'RNA-7': { type: 'RNA', alias: 'siKIF', descriptions: [], sources: [] },
        'RNA-8': { type: 'RNA', alias: 'siKIF', descriptions: [], sources: [] },
      }),
    });
    th.answer.prompt('siKIF', '', '');

    await add(th);

    expect(messages(th)[0]).toBe(
      'Global samples already have the alias siKIF (RNA-7, RNA-8). Autocomplete will show both, marked Local and Global.',
    );
  });

  it('registers nothing when the same-alias question is closed', async () => {
    const th = host({ [REGISTRY]: JSON.stringify({ 'RNA-3': { type: 'RNA', alias: 'R1', descriptions: [], sources: [] } }) });
    th.answer.prompt('R1');

    expect(await add(th)).toBeUndefined();
    expect(Object.keys(json(th, REGISTRY))).toEqual(['RNA-3']);
  });

  it('does not warn about a same alias of another type', async () => {
    const th = host({ [`${FOLDER}/DNA.json`]: JSON.stringify({ 'DNA-3': { type: 'DNA', alias: 'R1', descriptions: [], sources: [] } }) });
    th.answer.prompt('R1', '', '');

    await add(th);

    expect(messages(th).some((m) => m.includes('already has the alias'))).toBe(false);
    expect(th.asked.pick).toHaveLength(0);
  });
});

// #142
describe('createSampleInteractive with a typed search term', () => {
  it('the @type; text pre-fills the first prompt (#142)', async () => {
    const th = host(SAMPLE_VAULT);
    th.answer.prompt(undefined);
    await createSampleInteractive(createSampleEnv(th.ctx), { type: 'DNA', folder: LOCAL, mode: 'generate', scope: 'local', initial: 'pB' });
    expect(th.asked.prompt[0].value).toBe('pB');
  });

  it('fills the alias prompt with a name, and the ID prompt with an ID', async () => {
    const th = host();
    const env = createSampleEnv(th.ctx);
    th.answer.prompt(undefined);
    await createSampleInteractive(env, { type: 'RNA', folder: FOLDER, mode: 'generate', initial: ' siKIF ' });
    expect(th.asked.prompt[0]).toMatchObject({ value: 'siKIF' });

    th.answer.prompt(undefined);
    await createSampleInteractive(env, { type: 'RNA', folder: FOLDER, mode: 'manual', initial: 'RNA-12' });
    expect(th.asked.prompt[1]).toMatchObject({ value: 'RNA-12' });

    th.answer.prompt('RNA-13', undefined);
    await createSampleInteractive(env, { type: 'RNA', folder: FOLDER, mode: 'manual', initial: 'siKIF' });
    expect(th.asked.prompt[2]).toMatchObject({ value: 'RNA-' });
    expect(th.asked.prompt[3]).toMatchObject({ value: 'siKIF' });
  });

  it('the ID prompt checks the form, and the alias prompt refuses Markdown characters (#168)', async () => {
    const th = host();
    th.answer.prompt('RNA-13', undefined);
    await createSampleInteractive(createSampleEnv(th.ctx), { type: 'RNA', folder: FOLDER, mode: 'manual' });
    expect(th.asked.prompt[0].validate?.('x')).toBe('Invalid ID. Expected RNA-<number>.');
    expect(th.asked.prompt[0].validate?.('RNA-4')).toBeNull();
    expect(th.asked.prompt[1].validate?.('#1')).toContain('Markdown');
    expect(validateAlias({ t: coreT })('a;b')).toContain('";" or ":"');
  });
});

// #84, #403, #463
describe('createSampleInteractive with a manually entered existing id', () => {
  const STORED = {
    type: 'RNA',
    alias: 'siKIF',
    descriptions: ['knockdown'],
    sources: ['001_WD010_Design.labnote.md'],
    location: 'Freezer-1',
  };
  const README = 'labnote/001_Test/README.labnote.md';
  const TABLE_HEAD = '| ID | Alias | Description | Location | Scope | Discarded |\n| --- | --- | --- | --- | --- | --- |\n';
  const manual = (th: TestHost) =>
    createSampleInteractive(createSampleEnv(th.ctx), { type: 'RNA', folder: FOLDER, mode: 'manual', scope: 'local' });

  it("rewrites the sample's row in the sample list tables when a value changed", async () => {
    const th = host({
      [REGISTRY]: JSON.stringify({ 'RNA-7': STORED }),
      [README]: `${TABLE_HEAD}| RNA-7 | siKIF | knockdown | Freezer-1 | Local |  |\n`,
    });
    th.answer.prompt('RNA-7', 'siKIF', '', 'Freezer-9');

    await manual(th);

    expect(th.vault.files()[README]).toContain('| RNA-7 | siKIF | knockdown | Freezer-9 | Local |  |');
    expect(messages(th)).toContain('Sample updated: RNA-7 Updated the sample list table in 1 note(s).');
  });

  it('reusing an existing sample updates its list-table rows (#463)', async () => {
    const table = '| ID | Alias | Description | Location | Scope | Discarded |\n|---|---|---|---|---|---|\n| DNA-1 | pUC | old | Freezer A / B3 | Local | |\n';
    const th = host({ ...SAMPLE_VAULT, [NOTE]: `${SAMPLE_VAULT[NOTE]}\n${table}` });
    th.setActive(NOTE);
    // ID, 같은 별칭(묻지 않는다), 새 설명, 위치는 그대로(빈 칸은 저장된 값을 지킨다)
    th.answer.prompt('DNA-1', 'pUC', 'new', '');

    const created = await createSampleInteractive(createSampleEnv(th.ctx), { type: 'DNA', folder: LOCAL, mode: 'manual', scope: 'local' });

    expect(created).toMatchObject({ id: 'DNA-1', referenceText: 'DNA-1;pUC' });
    // 새 설명은 앞의 것들 앞에 붙는다(#84)
    expect(th.vault.files()[NOTE]).toContain('| DNA-1 | pUC | new; miniprep | Freezer A / B3 | Local |');
    expect(messages(th)).toContain(
      'DNA-1 already exists. Its current values are filled in, and a new description is added before the earlier ones.',
    );
  });

  it('leaves the tables alone when nothing changed', async () => {
    const before = `${TABLE_HEAD}| RNA-7 | old row | x | y | Local |  |\n`;
    const th = host({ [REGISTRY]: JSON.stringify({ 'RNA-7': STORED }), [README]: before });
    th.answer.prompt('RNA-7', 'siKIF', '', 'Freezer-1');

    await manual(th);

    expect(th.vault.files()[README]).toBe(before);
    expect(messages(th)).toContain('Sample updated: RNA-7');
  });

  it('prefills the stored values and merges what was entered', async () => {
    const th = host({ [REGISTRY]: JSON.stringify({ 'RNA-7': STORED }) });
    th.answer.prompt('rna-7', 'siKIF', 'second batch', '');

    const created = await manual(th);

    expect(th.asked.prompt.map((p) => p.value)).toEqual(['RNA-', 'siKIF', 'knockdown', 'Freezer-1']);
    expect(json(th, REGISTRY)['RNA-7']).toEqual({ ...STORED, descriptions: ['second batch', 'knockdown'] });
    expect(created).toMatchObject({ id: 'RNA-7', alias: 'siKIF', referenceText: 'RNA-7;siKIF' });
  });

  it('asks before taking an alias another sample has, and saves nothing when declined (#403)', async () => {
    const reg = JSON.stringify({ 'RNA-7': STORED, 'RNA-8': { type: 'RNA', alias: 'other', descriptions: [], sources: [] } });
    const th = host({ [REGISTRY]: reg });
    th.answer.prompt('RNA-7', 'other');
    th.answer.confirm(false);

    expect(await manual(th)).toBeUndefined();

    expect(th.asked.confirm[0].message).toBe('This experiment already has the alias other (RNA-8). Save RNA-7 anyway?');
    expect(th.vault.files()[REGISTRY]).toBe(reg);
  });

  it('updates a Global-only sample in the Global folder without a Local copy', async () => {
    const th = host({ [`${GLOBAL}/RNA.json`]: JSON.stringify({ 'RNA-7': STORED }) });
    th.answer.prompt('RNA-7', 'siKIF-2', 'knockdown', 'Freezer-1');

    await manual(th);

    expect(json(th, `${GLOBAL}/RNA.json`)['RNA-7'].alias).toBe('siKIF-2');
    expect(th.vault.files()[REGISTRY]).toBeUndefined();
  });

  it('registers a new id as before', async () => {
    const th = host();
    th.answer.prompt('RNA-8', 'new', '', '');

    await manual(th);

    expect(json(th, REGISTRY)['RNA-8']).toMatchObject({ alias: 'new', descriptions: [] });
  });
});

describe('pickCatalogReference', () => {
  it('catalog pick returns a reference to the catalog product', async () => {
    const th = host(SAMPLE_VAULT);
    th.answer.pick('Reagent-900');
    expect(await pickCatalogReference(createSampleEnv(th.ctx), { type: 'Reagent', docPath: NOTE })).toBe('Reagent-900;dNTP');
    expect(th.asked.pick[0].items).toEqual([{ label: 'Reagent-900 — dNTP', value: 'Reagent-900', description: 'mix' }]);
    expect(th.asked.pick[0].opts).toMatchObject({ title: 'Search Reagent catalog', placeholder: 'Search catalog' });
  });

  it('a Local catalog entry wins over the Global one of the same ID', async () => {
    const th = host({
      ...SAMPLE_VAULT,
      [`${LOCAL}/Reagent_lab.json`]: JSON.stringify({ 'Reagent-900': { type: 'Reagent', alias: 'dNTP-lab', descriptions: [], sources: [] } }),
    });
    th.answer.pick('Reagent-900');
    expect(await pickCatalogReference(createSampleEnv(th.ctx), { type: 'Reagent', docPath: NOTE })).toBe('Reagent-900;dNTP-lab');
  });

  it('offers to create a sample when there is no catalog entry, and returns nothing when declined', async () => {
    const th = host(SAMPLE_VAULT);
    expect(await pickCatalogReference(createSampleEnv(th.ctx), { type: 'Labware', docPath: NOTE })).toBeUndefined();
    expect(th.asked.confirm[0]).toEqual({
      message: 'No Labware catalog entries found (resources/labsamples/Labware_*.json). Create a new Labware sample instead?',
      opts: { confirmLabel: 'Create sample' },
    });
    expect(th.asked.pick).toHaveLength(0);
  });

  it('creates a Local sample with the typed text as alias when confirmed', async () => {
    const th = host(SAMPLE_VAULT);
    th.answer.confirm(true);
    th.answer.prompt((o) => o.value, '', '');
    const ref = await pickCatalogReference(createSampleEnv(th.ctx), { type: 'Labware', docPath: NOTE, initialQuery: 'tips' });
    expect(ref).toMatch(/^Labware-\d+;tips$/);
    expect(Object.keys(json(th, `${LOCAL}/Labware.json`))).toHaveLength(1);
  });
});

describe('installSampleActionRunners', () => {
  it('installed runners serve the completion action rows', async () => {
    installSampleActionRunners();
    installSampleActionRunners();
    expect(sampleActionRunners.generate).toBeTypeOf('function');
    expect(sampleActionRunners.manual).toBeTypeOf('function');
    expect(sampleActionRunners.catalog).toBeTypeOf('function');
  });

  it('generate creates in the note\'s Local folder with the typed text and resolves the reference', async () => {
    installSampleActionRunners();
    const th = host(SAMPLE_VAULT);
    th.setActive(NOTE);
    th.answer.prompt((o) => o.value, '', '');
    const q = { notePath: NOTE, trigger: { type: 'DNA' } as never, typed: 'pX' };
    const ref = await sampleActionRunners.generate!(createSampleEnv(th.ctx), q, 'DNA');
    expect(ref).toMatch(/^DNA-\d+;pX$/);
    expect(th.asked.prompt[0].value).toBe('pX');
  });

  it('generate over a conflicted registry warns in the UI language and leaves the file byte-identical', async () => {
    installSampleActionRunners();
    setLang('ko');
    const th = host({ ...SAMPLE_VAULT, [`${LOCAL}/DNA.json`]: CONFLICTED });
    th.setActive(NOTE);
    th.answer.prompt((o) => o.value, '', '');
    const q = { notePath: NOTE, trigger: { type: 'DNA' } as never, typed: 'pX' };
    expect(await sampleActionRunners.generate!(createSampleEnv(th.ctx), q, 'DNA')).toBeUndefined();
    expect(th.notes).toEqual([{ kind: 'warn', message: t('samples.registryUnreadable', `${LOCAL}/DNA.json`) }]);
    expect(th.notes[0].message).toContain('샘플 대장');
    expect(th.vault.files()[`${LOCAL}/DNA.json`]).toBe(CONFLICTED);
  });

  it('catalog resolves the picked product', async () => {
    installSampleActionRunners();
    const th = host(SAMPLE_VAULT);
    th.setActive(NOTE);
    th.answer.pick('Reagent-900');
    const q = { notePath: NOTE, trigger: { type: 'Reagent' } as never, typed: undefined };
    expect(await sampleActionRunners.catalog!(createSampleEnv(th.ctx), q, 'Reagent')).toBe('Reagent-900;dNTP');
  });
});
