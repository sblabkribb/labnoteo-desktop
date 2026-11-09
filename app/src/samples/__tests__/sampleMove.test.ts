// @vitest-environment jsdom
/**
 * 샘플 종류 바꾸기와 Local/Global 옮기기(plan SP5 Task 22). vendor tests/plugin/moveSample.test.ts 의 모든 사례와
 * tests/plugin/sampleActions.test.ts 의 종류 바꾸기 사례를 앱 호스트로 옮기고, 앱의 안전 규칙(충돌한 대장, 쓰는 순서)을 더했다.
 * 대화상자의 답은 `th.answer.*` 로 차례로 적는다(답이 떨어지면 닫은 것처럼 undefined / false).
 */
import { act } from '@testing-library/react';
import { undo } from '@codemirror/commands';
import { getLang, setLang } from '../../i18n/lang';
import { createTestHost, type TestHost } from '../../labnote/__tests__/testHost';
import { changeSampleTypeInteractive, moveSampleInteractive } from '../../labnote/port/sampleMove';
import type { SampleScope } from '../../labnote/port/sampleScope';
import { createSampleEnv, RegistryUnreadableError, sampleEvents } from '../env';
import { CONFLICTED, GLOBAL, LOCAL, NOTE, SAMPLE_VAULT } from './fixtures';

let hosts: TestHost[] = [];
let events: Array<readonly string[] | undefined> = [];
let offEvents: () => void = () => undefined;
const host = (files: Record<string, string> = {}) => {
  const th = createTestHost(files);
  hosts.push(th);
  return th;
};
const lang = getLang();
beforeEach(() => {
  setLang('en');
  events = [];
  offEvents = sampleEvents.subscribe((paths) => void events.push(paths));
});
afterEach(() => {
  offEvents();
  for (const th of hosts) th.cleanup();
  hosts = [];
  setLang(lang);
});

const json = (th: TestHost, p: string) => JSON.parse(th.vault.files()[p] ?? '{}');

// ---------------------------------------------------------------- moveSample.test.ts (vendor)

const RENDERED_LOCAL = 'labnote/111_Shown/resources/labsamples';
const WRONG_NOTE = 'labnote/999_Stale/001_WD010_X.labnote.md';
const WRONG_LOCAL = 'labnote/999_Stale/resources/labsamples';
const TYPE = 'Reagent';
const record = (alias: string) => ({ type: TYPE, alias, descriptions: [], sources: [], location: null });
const reg = (folder: string, recs: Record<string, unknown>) => ({ [`${folder}/${TYPE}.json`]: JSON.stringify(recs) });
const move = (th: TestHost, opts: { fromScope: SampleScope; fromFolder: string; toFolder: string; id: string }) =>
  moveSampleInteractive(createSampleEnv(th.ctx), { ...opts, type: TYPE });
/** 활성 노트를 "틀린" 실험에 둔다: 옮기기는 그것을 보지 않아야 한다. */
const stale = (files: Record<string, string>) => {
  const th = host({ [WRONG_NOTE]: '# x\n', ...files });
  th.setActive(WRONG_NOTE);
  return th;
};

describe('moveSampleInteractive — targets the rendered folder (vendor)', () => {
  it('moves Global -> Local into the shown experiment, not the active-file one', async () => {
    const th = stale(reg(GLOBAL, { 'Reagent-1': record('water') }));

    const moved = await move(th, { fromScope: 'global', fromFolder: GLOBAL, toFolder: RENDERED_LOCAL, id: 'Reagent-1' });

    expect(moved).toBe(true);
    expect(json(th, `${RENDERED_LOCAL}/${TYPE}.json`)['Reagent-1']).toEqual(record('water'));
    expect(th.vault.files()[`${WRONG_LOCAL}/${TYPE}.json`]).toBeUndefined();
    expect(json(th, `${GLOBAL}/${TYPE}.json`)).toEqual({});
    expect(events).toHaveLength(1);
  });

  it('moves Local -> Global into the rendered global folder', async () => {
    const th = stale(reg(RENDERED_LOCAL, { 'Reagent-2': record('buffer') }));

    const moved = await move(th, { fromScope: 'local', fromFolder: RENDERED_LOCAL, toFolder: GLOBAL, id: 'Reagent-2' });

    expect(moved).toBe(true);
    expect(json(th, `${GLOBAL}/${TYPE}.json`)['Reagent-2']).toEqual(record('buffer'));
    expect(json(th, `${RENDERED_LOCAL}/${TYPE}.json`)).toEqual({});
  });

  it('refuses to move when a scope folder is unresolved (empty), writing nothing', async () => {
    const th = stale(reg(GLOBAL, { 'Reagent-3': record('x') }));
    const before = { ...th.vault.files() };

    const moved = await move(th, { fromScope: 'global', fromFolder: GLOBAL, toFolder: '', id: 'Reagent-3' });

    expect(moved).toBe(false);
    expect(th.vault.files()).toEqual(before);
    expect(events).toHaveLength(0);
    expect(th.notes.at(-1)?.message).toBe('Open an experiment note first to move samples.');
  });

  it('refuses a move into the same folder, writing nothing', async () => {
    const th = stale(reg(GLOBAL, { 'Reagent-3': record('x') }));
    const before = { ...th.vault.files() };

    expect(await move(th, { fromScope: 'global', fromFolder: GLOBAL, toFolder: GLOBAL, id: 'Reagent-3' })).toBe(false);

    expect(th.vault.files()).toEqual(before);
    expect(th.notes.at(-1)?.message).toBe(
      'The open note is outside an experiment. Open a note of the experiment to move it to, then try again.',
    );
  });
});

// #78
describe('moveSampleInteractive — Global -> Local warns about other experiments (vendor)', () => {
  const toLocal = (th: TestHost, id: string) =>
    move(th, { fromScope: 'global', fromFolder: GLOBAL, toFolder: RENDERED_LOCAL, id });

  it('asks first and keeps the sample Global when the user declines', async () => {
    const th = host({
      ...reg(GLOBAL, { 'Reagent-4': record('salt') }),
      'labnote/111_Shown/001_WD010_A.labnote.md': 'Reagent-4;salt',
      'labnote/222_Other/001_WD010_B.labnote.md': 'Reagent-4;salt',
    });
    th.answer.confirm(false);

    expect(await toLocal(th, 'Reagent-4')).toBe(false);

    expect(th.asked.confirm[0].message).toContain('labnote/222_Other/001_WD010_B.labnote.md');
    expect(th.asked.confirm[0].message).not.toContain('111_Shown');
    expect(th.asked.confirm[0].opts).toMatchObject({ confirmLabel: 'Move anyway', destructive: true });
    expect(json(th, `${GLOBAL}/${TYPE}.json`)['Reagent-4']).toEqual(record('salt'));
    expect(th.vault.files()[`${RENDERED_LOCAL}/${TYPE}.json`]).toBeUndefined();
  });

  it('moves after the user agrees', async () => {
    const th = host({ ...reg(GLOBAL, { 'Reagent-4': record('salt') }), 'Welcome.md': 'Reagent-4' });
    th.answer.confirm(true);

    expect(await toLocal(th, 'Reagent-4')).toBe(true);
    expect(json(th, `${RENDERED_LOCAL}/${TYPE}.json`)['Reagent-4']).toEqual(record('salt'));
  });

  it('does not ask when only the target experiment uses it', async () => {
    const th = host({
      ...reg(GLOBAL, { 'Reagent-4': record('salt') }),
      'labnote/111_Shown/001_WD010_A.labnote.md': 'Reagent-4;salt',
    });

    expect(await toLocal(th, 'Reagent-4')).toBe(true);
    expect(th.asked.confirm).toHaveLength(0);
  });

  it('does not check references for a Local -> Global move', async () => {
    const th = host({
      ...reg(RENDERED_LOCAL, { 'Reagent-5': record('x') }),
      'labnote/222_Other/001_WD010_B.labnote.md': 'Reagent-5',
    });

    expect(await move(th, { fromScope: 'local', fromFolder: RENDERED_LOCAL, toFolder: GLOBAL, id: 'Reagent-5' })).toBe(true);
    expect(th.asked.confirm).toHaveLength(0);
  });
});

// #336
describe('moveSampleInteractive — sample list tables (vendor)', () => {
  it("rewrites the sample's row in the experiment's notes", async () => {
    const readme = 'labnote/111_Shown/README.labnote.md';
    const th = host({
      ...reg(RENDERED_LOCAL, { 'Reagent-2': record('buffer') }),
      [readme]:
        '| ID | Alias | Description | Location | Scope | Discarded |\n| --- | --- | --- | --- | --- | --- |\n| Reagent-2 | buffer |  |  | Local |  |\n',
    });

    expect(await move(th, { fromScope: 'local', fromFolder: RENDERED_LOCAL, toFolder: GLOBAL, id: 'Reagent-2' })).toBe(true);
    expect(th.vault.files()[readme]).toContain('| Reagent-2 | buffer |  |  | Global |  |');
    expect(th.notes.at(-1)?.message).toBe('Sample moved: Reagent-2 Updated the sample list table in 1 note(s).');
  });
});

// #299
describe('moveSampleInteractive — same alias in the destination (vendor)', () => {
  const setup = () =>
    host({ ...reg(RENDERED_LOCAL, { 'Reagent-2': record('Buffer') }), ...reg(GLOBAL, { 'Reagent-9': record(' buffer ') }) });
  const toGlobal = (th: TestHost) =>
    move(th, { fromScope: 'local', fromFolder: RENDERED_LOCAL, toFolder: GLOBAL, id: 'Reagent-2' });

  it('asks first, naming the sample that has the alias, and stays put when declined', async () => {
    const th = setup();
    th.answer.confirm(false);

    expect(await toGlobal(th)).toBe(false);

    // #507: the alias as Reagent-9 has it, not as the moved sample spells it.
    expect(th.asked.confirm[0].message).toBe(
      'Global samples already have the alias buffer (Reagent-9). Move Reagent-2 there anyway?',
    );
    expect(th.asked.confirm[0].opts?.confirmLabel).toBe('Move anyway');
    expect(json(th, `${RENDERED_LOCAL}/${TYPE}.json`)['Reagent-2']).toBeDefined();
    expect(json(th, `${GLOBAL}/${TYPE}.json`)['Reagent-2']).toBeUndefined();
  });

  it('moves when confirmed', async () => {
    const th = setup();
    th.answer.confirm(true);

    expect(await toGlobal(th)).toBe(true);
    expect(Object.keys(json(th, `${GLOBAL}/${TYPE}.json`)).sort()).toEqual(['Reagent-2', 'Reagent-9']);
  });
});

describe('moveSampleInteractive — an existing record in the destination (vendor)', () => {
  it('asks before overwriting it, and changes nothing when declined', async () => {
    const th = host({ ...reg(RENDERED_LOCAL, { 'Reagent-2': record('new') }), ...reg(GLOBAL, { 'Reagent-2': record('old') }) });
    th.answer.confirm(false);

    expect(await move(th, { fromScope: 'local', fromFolder: RENDERED_LOCAL, toFolder: GLOBAL, id: 'Reagent-2' })).toBe(false);

    expect(th.asked.confirm[0].message).toBe('Reagent-2 already exists in the destination. Overwrite it?');
    expect(th.asked.confirm[0].opts).toMatchObject({ confirmLabel: 'Overwrite', destructive: true });
    expect(json(th, `${GLOBAL}/${TYPE}.json`)['Reagent-2']).toEqual(record('old'));
    expect(json(th, `${RENDERED_LOCAL}/${TYPE}.json`)['Reagent-2']).toEqual(record('new'));
  });
});

// ---------------------------------------------------------------- sampleActions.test.ts changeSampleTypeInteractive (vendor)

describe('changeSampleTypeInteractive (vendor)', () => {
  const A = 'labnote/001_Test';
  const B = 'labnote/002_Other';
  const FOLDER = `${A}/resources/labsamples`;
  const REGISTRY = `${FOLDER}/RNA.json`;
  const RECORD = { type: 'RNA', alias: 'pUC19', descriptions: ['vector'], sources: [], location: null };
  const files = (extra: Record<string, string> = {}) => ({
    [REGISTRY]: JSON.stringify({ 'RNA-1': RECORD }),
    [`${A}/001_WD010_A.labnote.md`]: '@rna;RNA-1;pUC19;vector\n',
    [`${A}/002_WD020_B.labnote.md`]: 'used RNA-1;pUC19 and RNA-12\n',
    [`${B}/001_WD010_C.labnote.md`]: 'RNA-1;other\n',
    ...extra,
  });
  const change = (th: TestHost) =>
    changeSampleTypeInteractive(createSampleEnv(th.ctx), { folder: FOLDER, type: 'RNA', id: 'RNA-1' });

  it('moves the record under the new type and rewrites the notes of its experiment', async () => {
    const th = host(files());
    th.answer.pick('Plasmid');
    th.answer.confirm(true);

    expect(await change(th)).toBe(true);

    expect(th.asked.confirm[0].message).toContain('Change RNA-1 to Plasmid-1? Its record moves from RNA.json to Plasmid.json.');
    expect(th.asked.confirm[0].opts?.confirmLabel).toBe('Change type');
    expect(json(th, REGISTRY)).toEqual({});
    expect(json(th, `${FOLDER}/Plasmid.json`)['Plasmid-1']).toMatchObject({
      type: 'Plasmid',
      alias: 'pUC19',
      descriptions: ['vector'],
    });
    expect(th.vault.files()[`${A}/001_WD010_A.labnote.md`]).toBe('@plasmid;Plasmid-1;pUC19;vector\n');
    expect(th.vault.files()[`${A}/002_WD020_B.labnote.md`]).toBe('used Plasmid-1;pUC19 and RNA-12\n');
    expect(th.vault.files()[`${B}/001_WD010_C.labnote.md`]).toBe('RNA-1;other\n');
    expect(th.notes.at(-1)?.message).toBe(
      'Changed RNA-1 to Plasmid-1. 2 note(s) updated. Ctrl+Z only reverts the note, not the sample record. To undo, change the type again.',
    );
    expect(events).toHaveLength(1);
  });

  it('gives a new id when the new type already has those numbers', async () => {
    const th = host(files({ [`${GLOBAL}/Plasmid.json`]: JSON.stringify({ 'Plasmid-1': { ...RECORD, type: 'Plasmid' } }) }));
    th.answer.pick('Plasmid');
    th.answer.confirm(true);

    await change(th);

    const ids = Object.keys(json(th, `${FOLDER}/Plasmid.json`));
    expect(ids).toHaveLength(1);
    expect(ids[0]).not.toBe('Plasmid-1');
    expect(ids[0]).toMatch(/^Plasmid-/);
    expect(th.vault.files()[`${A}/001_WD010_A.labnote.md`]).toBe(`@plasmid;${ids[0]};pUC19;vector\n`);
  });

  it('changes nothing when declined', async () => {
    const th = host(files());
    th.answer.pick('Plasmid');
    th.answer.confirm(false);

    expect(await change(th)).toBe(false);

    expect(json(th, REGISTRY)).toHaveProperty('RNA-1');
    expect(th.vault.files()[`${FOLDER}/Plasmid.json`]).toBeUndefined();
    expect(th.vault.files()[`${A}/001_WD010_A.labnote.md`]).toBe('@rna;RNA-1;pUC19;vector\n');
  });

  it('does not offer the current type', async () => {
    const th = host(files());
    th.answer.pick(undefined);

    expect(await change(th)).toBe(false);

    const offered = th.asked.pick[0].items.map((i) => i.value);
    expect(offered).not.toContain('RNA');
    expect(offered).toContain('Plasmid');
    expect(th.asked.pick[0].opts).toMatchObject({ title: 'Change the type of RNA-1', placeholder: 'Pick the new type' });
  });
});

// ---------------------------------------------------------------- app

describe('changeSampleTypeInteractive (app)', () => {
  it('change type rewrites the ID prefix in notes (DNA-1 → Plasmid-1)', async () => {
    const th = host(SAMPLE_VAULT);
    th.answer.pick('Plasmid');
    th.answer.confirm(true);
    expect(await changeSampleTypeInteractive(createSampleEnv(th.ctx), { folder: LOCAL, type: 'DNA', id: 'DNA-1' })).toBe(true);
    expect(th.vault.files()[NOTE]).toContain('Use Plasmid-1;pUC and');
    expect(JSON.parse(th.vault.files()[`${LOCAL}/Plasmid.json`])['Plasmid-1'].alias).toBe('pUC');
    expect(JSON.parse(th.vault.files()[`${LOCAL}/DNA.json`])['DNA-1']).toBeUndefined();
    expect(events).toContainEqual(expect.arrayContaining([`${LOCAL}/Plasmid.json`, `${LOCAL}/DNA.json`]));
  });

  it('an open note is rewritten in its buffer as one undo step', async () => {
    const th = host(SAMPLE_VAULT);
    const m = await th.mount(NOTE);
    th.answer.pick('Plasmid');
    th.answer.confirm(true);

    expect(await changeSampleTypeInteractive(createSampleEnv(th.ctx), { folder: LOCAL, type: 'DNA', id: 'DNA-1' })).toBe(true);

    const doc = m.view().state.doc.toString();
    expect(doc).toContain('@plasmid;Plasmid-1;pUC;miniprep');
    expect(doc).toContain('Use Plasmid-1;pUC and');
    act(() => void undo(m.view()));
    expect(m.view().state.doc.toString()).toContain('@dna;DNA-1;pUC;miniprep');
    expect(m.view().state.doc.toString()).toContain('Use DNA-1;pUC and');
  });

  it('refuses over a conflicted source registry before asking, and touches nothing', async () => {
    const th = host({ ...SAMPLE_VAULT, [`${LOCAL}/DNA.json`]: CONFLICTED });
    th.answer.pick('Plasmid');
    th.answer.confirm(true);
    await expect(
      changeSampleTypeInteractive(createSampleEnv(th.ctx), { folder: LOCAL, type: 'DNA', id: 'DNA-1' }),
    ).rejects.toBeInstanceOf(RegistryUnreadableError);
    expect(th.asked.pick).toHaveLength(0);
    expect(th.vault.files()[`${LOCAL}/DNA.json`]).toBe(CONFLICTED);
    expect(th.vault.files()[NOTE]).toBe(SAMPLE_VAULT[NOTE]);
  });

  it('refuses over a conflicted destination registry before confirming, and keeps the record', async () => {
    const th = host({ ...SAMPLE_VAULT, [`${LOCAL}/Plasmid.json`]: CONFLICTED });
    th.answer.pick('Plasmid');
    th.answer.confirm(true);
    await expect(
      changeSampleTypeInteractive(createSampleEnv(th.ctx), { folder: LOCAL, type: 'DNA', id: 'DNA-1' }),
    ).rejects.toBeInstanceOf(RegistryUnreadableError);
    expect(th.asked.confirm).toHaveLength(0);
    expect(th.vault.files()[`${LOCAL}/Plasmid.json`]).toBe(CONFLICTED);
    expect(json(th, `${LOCAL}/DNA.json`)['DNA-1']).toBeDefined();
    expect(th.vault.files()[NOTE]).toBe(SAMPLE_VAULT[NOTE]);
  });
});

describe('moveSampleInteractive (app)', () => {
  it('move to Global writes the destination before deleting the source', async () => {
    const th = host(SAMPLE_VAULT);
    th.answer.confirm(true);
    await moveSampleInteractive(createSampleEnv(th.ctx), { fromScope: 'local', fromFolder: LOCAL, toFolder: GLOBAL, type: 'DNA', id: 'DNA-1' });
    // 읽기는 빼고 쓰기만: 먼저 목적지에 쓰고, 그다음에 원본에서 지운다.
    const order = th.vault.log
      .filter((l) => /^vault_(write|modify|remove|trash)$/.test(l.cmd))
      .filter((l) => /labsamples\/DNA\.json$/.test(String(l.args?.path)))
      .map((l) => l.args.path);
    expect(order[0]).toBe(`${GLOBAL}/DNA.json`);
    expect(order).toContain(`${LOCAL}/DNA.json`);
    expect(JSON.parse(th.vault.files()[`${GLOBAL}/DNA.json`])['DNA-1'].alias).toBe('pUC');
    expect(json(th, `${LOCAL}/DNA.json`)['DNA-1']).toBeUndefined();
  });

  it('move warns about users outside the experiment', async () => {
    const th = host({ ...SAMPLE_VAULT, 'Home.md': '# Home\n\nTaq is Reagent-7.\n' });
    th.answer.confirm(false);
    expect(
      await moveSampleInteractive(createSampleEnv(th.ctx), {
        fromScope: 'global',
        fromFolder: GLOBAL,
        toFolder: LOCAL,
        type: 'Reagent',
        id: 'Reagent-7',
      }),
    ).toBe(false);
    expect(th.asked.confirm[0].message).toContain('Home.md');
    expect(th.asked.confirm[0].message).not.toContain(NOTE);
    expect(json(th, `${GLOBAL}/Reagent.json`)['Reagent-7']).toBeDefined();
    expect(th.vault.files()[`${LOCAL}/Reagent.json`]).toBeUndefined();
  });

  it('refuses over a conflicted destination registry and keeps the source', async () => {
    const th = host({ ...SAMPLE_VAULT, [`${GLOBAL}/DNA.json`]: CONFLICTED });
    th.answer.confirm(true);
    await expect(
      moveSampleInteractive(createSampleEnv(th.ctx), { fromScope: 'local', fromFolder: LOCAL, toFolder: GLOBAL, type: 'DNA', id: 'DNA-1' }),
    ).rejects.toBeInstanceOf(RegistryUnreadableError);
    expect(th.asked.confirm).toHaveLength(0);
    expect(th.vault.files()[`${GLOBAL}/DNA.json`]).toBe(CONFLICTED);
    expect(json(th, `${LOCAL}/DNA.json`)['DNA-1'].alias).toBe('pUC');
  });

  it('refuses over a conflicted source registry and leaves the destination alone', async () => {
    const th = host({ ...SAMPLE_VAULT, [`${LOCAL}/DNA.json`]: CONFLICTED });
    th.answer.confirm(true);
    await expect(
      moveSampleInteractive(createSampleEnv(th.ctx), { fromScope: 'local', fromFolder: LOCAL, toFolder: GLOBAL, type: 'DNA', id: 'DNA-1' }),
    ).rejects.toBeInstanceOf(RegistryUnreadableError);
    expect(th.vault.files()[`${LOCAL}/DNA.json`]).toBe(CONFLICTED);
    expect(th.vault.files()[`${GLOBAL}/DNA.json`]).toBeUndefined();
  });
});
