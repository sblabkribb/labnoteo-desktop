// @vitest-environment jsdom
/**
 * 샘플 고치기, 폐기 표시와 옛 별칭 바꾸기(plan SP5 Task 20). vendor tests/plugin/sampleActions.test.ts 의
 * "editSampleInteractive alias rewrite" 묶음 가운데 고치기 사례와 "setSampleDiscardedInteractive" 묶음을 앱 호스트로 옮겼다.
 * 읽기 보기(reading view) 두 사례는 앱에 읽기 보기가 없어 뺐다. 지우기와 쓰임 사례는 Task 18 과 21 이 맡는다.
 * 대화상자의 답은 `th.answer.prompt/confirm/pick` 으로 차례로 적는다(답이 떨어지면 닫은 것처럼 undefined / false).
 */
import { act } from '@testing-library/react';
import { undo } from '@codemirror/commands';
import { getLang, setLang } from '../../i18n/lang';
import { createTestHost, type TestHost } from '../../labnote/__tests__/testHost';
import { editSampleInteractive, setSampleDiscardedInteractive } from '../../labnote/port/sampleEdit';
import { NoteBusyError } from '../../labnote/noteErrors';
import { createSampleEnv, RegistryUnreadableError, sampleEvents, type SampleEnv } from '../env';
import { CONFLICTED, koListHeader, LOCAL, NOTE, SAMPLE_VAULT } from './fixtures';

const A = 'labnote/001_Test';
const B = 'labnote/002_Other';
const FOLDER = `${A}/resources/labsamples`;
const REGISTRY = `${FOLDER}/RNA.json`;
const GLOBAL = 'resources/labsamples';
const RECORD = { type: 'RNA', alias: 'si KIF', descriptions: ['kd'], sources: [], location: null };

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
  vi.useRealTimers();
  setLang(lang);
});

const json = (th: TestHost, p: string) => JSON.parse(th.vault.files()[p]);
const lastNotice = (th: TestHost) => th.notes.at(-1)?.message;
/** 별칭, 설명, 위치 순으로 답하고 RNA-1 을 고친다. */
const edit = (th: TestHost, folder: string, alias: string, record: typeof RECORD = RECORD) => {
  th.answer.prompt(alias, 'kd', '');
  return editSampleInteractive(createSampleEnv(th.ctx), { folder, type: 'RNA', id: 'RNA-1', record });
};

describe('editSampleInteractive alias rewrite (vendor)', () => {
  it('rewrites definitions and references in the experiment of a Local sample', async () => {
    const th = host({
      [`${A}/001_WD010_A.labnote.md`]: '@rna;RNA-1;si KIF;kd\n',
      [`${A}/002_WD020_B.labnote.md`]: 'RNA-1;si KIF 를 처리했다\n',
      [`${B}/001_WD010_C.labnote.md`]: 'RNA-1;si KIF\n',
    });
    th.answer.confirm(true);

    await edit(th, FOLDER, 'siKIF');

    expect(th.asked.confirm[0].message).toContain(`- ${A}/001_WD010_A.labnote.md (1 definition(s), 0 reference(s))`);
    expect(th.vault.files()[`${A}/001_WD010_A.labnote.md`]).toBe('@rna;RNA-1;siKIF;kd\n');
    expect(th.vault.files()[`${A}/002_WD020_B.labnote.md`]).toBe('RNA-1;siKIF 를 처리했다\n');
    expect(th.vault.files()[`${B}/001_WD010_C.labnote.md`]).toBe('RNA-1;si KIF\n');
    expect(lastNotice(th)).toBe('Sample updated: RNA-1 2 note(s) updated.');
    expect(events).toContainEqual([REGISTRY]);
  });

  it('skips a note busy in the editor, rewrites the rest and names it in the notice', async () => {
    const busy = `${A}/001_WD010_A.labnote.md`;
    const th = host({
      [busy]: '@rna;RNA-1;si KIF;kd\n',
      [`${A}/002_WD020_B.labnote.md`]: 'RNA-1;si KIF 를 처리했다\n',
    });
    th.answer.confirm(true);
    th.answer.prompt('siKIF', 'kd', '');
    const env = createSampleEnv(th.ctx);
    const busyEnv: SampleEnv = {
      ...env,
      processNote: (p, f) => (p === busy ? Promise.reject(new NoteBusyError(p)) : env.processNote(p, f)),
    };

    expect(await editSampleInteractive(busyEnv, { folder: FOLDER, type: 'RNA', id: 'RNA-1', record: RECORD })).toBe(true);

    expect(th.vault.files()[busy]).toBe('@rna;RNA-1;si KIF;kd\n');
    expect(th.vault.files()[`${A}/002_WD020_B.labnote.md`]).toBe('RNA-1;siKIF 를 처리했다\n');
    expect(lastNotice(th)).toBe(
      `Sample updated: RNA-1 1 note(s) updated. 1 note(s) were busy in the editor and were left unchanged: ${busy}.`,
    );
    expect(events).toContainEqual([REGISTRY]);
  });

  it('changes nothing when declined, and warns that a definition can revert the alias', async () => {
    const th = host({ [`${A}/001_WD010_A.labnote.md`]: '@rna;RNA-1;si KIF\n' });
    th.answer.confirm(false);

    await edit(th, FOLDER, 'siKIF');

    expect(th.vault.files()[`${A}/001_WD010_A.labnote.md`]).toBe('@rna;RNA-1;si KIF\n');
    expect(lastNotice(th)).toBe(
      'Sample updated: RNA-1 1 note(s) still show the old alias. Saving a note that defines it may bring the old alias back.',
    );
  });

  it('skips experiments where a Local record shadows a Global sample, and edits open notes in place', async () => {
    const open = `${A}/002_WD020_Open.labnote.md`;
    const th = host({
      [`${A}/001_WD010_A.labnote.md`]: 'RNA-1;si KIF\n',
      [`${B}/resources/labsamples/RNA.json`]: JSON.stringify({ 'RNA-1': RECORD }),
      [`${B}/001_WD010_C.labnote.md`]: 'RNA-1;si KIF\n',
      [open]: 'RNA-1;si KIF\n',
    });
    const m = await th.mount(open);
    // 저장하지 않은 입력: 바꾸기는 디스크가 아니라 버퍼를 기준으로 한다
    act(() => {
      const view = m.view();
      view.dispatch({ changes: { from: view.state.doc.length - 1, insert: ' (unsaved)' } });
    });
    th.answer.confirm(true);

    await edit(th, GLOBAL, 'siKIF');

    expect(th.vault.files()[`${A}/001_WD010_A.labnote.md`]).toBe('RNA-1;siKIF\n');
    expect(th.vault.files()[`${B}/001_WD010_C.labnote.md`]).toBe('RNA-1;si KIF\n');
    expect(m.view().state.doc.toString()).toBe('RNA-1;siKIF (unsaved)\n');
  });

  it('does not ask when no other note shows the old alias', async () => {
    const th = host({ [`${A}/001_WD010_A.labnote.md`]: 'RNA-1;other\n' });

    await edit(th, FOLDER, 'siKIF');

    expect(th.asked.confirm).toHaveLength(0);
    expect(lastNotice(th)).toBe('Sample updated: RNA-1');
  });

  // #403
  it('asks before taking the alias of another sample of the experiment, and saves nothing when declined', async () => {
    const th = host({ [REGISTRY]: JSON.stringify({ 'RNA-1': RECORD, 'RNA-2': { ...RECORD, alias: 'siKIF' } }) });
    th.answer.confirm(false);

    expect(await edit(th, FOLDER, 'SIKIF ')).toBe(false);

    expect(th.asked.confirm[0].message).toBe('This experiment already has the alias siKIF (RNA-2). Save RNA-1 anyway?');
    expect(json(th, REGISTRY)['RNA-1'].alias).toBe('si KIF');
  });

  it('saves the shared alias on "Save anyway", and does not ask when only the case changed', async () => {
    const th = host({ [REGISTRY]: JSON.stringify({ 'RNA-1': RECORD, 'RNA-2': { ...RECORD, alias: 'siKIF' } }) });
    th.answer.confirm(true);
    expect(await edit(th, FOLDER, 'siKIF')).toBe(true);
    expect(json(th, REGISTRY)['RNA-1'].alias).toBe('siKIF');

    const th2 = host({ [REGISTRY]: JSON.stringify({ 'RNA-1': RECORD, 'RNA-2': { ...RECORD } }) });
    expect(await edit(th2, FOLDER, 'SI KIF')).toBe(true);
    expect(th2.asked.confirm).toHaveLength(0);
  });

  // #471
  it('asks before emptying the alias, and saves nothing when declined', async () => {
    const th = host({ [REGISTRY]: JSON.stringify({ 'RNA-1': RECORD }) });
    th.answer.confirm(false);

    expect(await edit(th, FOLDER, '   ')).toBe(false);

    expect(th.asked.confirm[0].message).toBe(
      "Remove the alias 'si KIF' of RNA-1? The sample list tables and the sample view lose it too.",
    );
    expect(th.asked.confirm[0].opts?.confirmLabel).toBe('Remove');
    expect(json(th, REGISTRY)['RNA-1'].alias).toBe('si KIF');
  });

  it('empties the alias and the first description once confirmed', async () => {
    const record = { ...RECORD, descriptions: ['kd', 'from B'] };
    const th = host({ [REGISTRY]: JSON.stringify({ 'RNA-1': record }) });
    th.answer.confirm(true, true, true);
    th.answer.prompt(' ', '', '');

    expect(await editSampleInteractive(createSampleEnv(th.ctx), { folder: FOLDER, type: 'RNA', id: 'RNA-1', record })).toBe(
      true,
    );

    expect(th.asked.confirm[0].message).toBe(
      "Remove the alias 'si KIF' and the first description 'kd' of RNA-1? The sample list tables and the sample view lose it too.",
    );
    const saved = json(th, REGISTRY)['RNA-1'];
    expect(saved.alias).toBeNull();
    expect(saved.descriptions).toEqual(['from B']);
  });

  it('rewrites the alias in a note outside experiments, unless another experiment has the same ID', async () => {
    const th = host({ '2026-10-26.md': 'RNA-1;si KIF\n' });
    th.answer.confirm(true);
    await edit(th, FOLDER, 'siKIF');
    expect(th.vault.files()['2026-10-26.md']).toBe('RNA-1;siKIF\n');

    const th2 = host({
      '2026-10-26.md': 'RNA-1;si KIF\n',
      [`${A}/001_WD010_A.labnote.md`]: 'RNA-1;si KIF\n',
      [`${B}/resources/labsamples/RNA.json`]: JSON.stringify({ 'RNA-1': RECORD }),
    });
    th2.answer.confirm(true);
    await edit(th2, FOLDER, 'siKIF');

    expect(th2.asked.confirm[0].message).toContain(
      'Another experiment has a sample with the same ID, so 1 note(s) outside experiments are left as they are.',
    );
    expect(th2.vault.files()[`${A}/001_WD010_A.labnote.md`]).toBe('RNA-1;siKIF\n');
    expect(th2.vault.files()['2026-10-26.md']).toBe('RNA-1;si KIF\n');
  });

  // #173
  // #553: the slot question names both samples by alias first, as the create flow does.
  it('names the aliases when an edit moves a sample into a taken slot, and saves nothing when declined', async () => {
    const registry = JSON.stringify({
      'RNA-1': { ...RECORD, alias: 'moving', location: '4도' },
      'RNA-9': { type: 'RNA', alias: 'kept', descriptions: [], sources: [], location: '-80 / P1 / A1' },
    });
    const th = host({ [REGISTRY]: registry });
    th.answer.prompt('moving', 'kd', '-80 / P1 / A1');
    th.answer.confirm(false);

    const record = { ...RECORD, alias: 'moving', location: '4도' };
    expect(await editSampleInteractive(createSampleEnv(th.ctx), { folder: FOLDER, type: 'RNA', id: 'RNA-1', record })).toBe(false);

    expect(th.asked.confirm[0].message).toBe(
      'kept (RNA-9, Local RNA sample) is already stored at -80 / P1 / A1. Save moving (RNA-1) anyway?',
    );
    expect(th.asked.confirm[0].opts).toEqual({ confirmLabel: 'Save anyway' });
    expect(json(th, REGISTRY)['RNA-1'].location).toBe('4도');
  });

  it('names the other experiments that keep a copy of the sample', async () => {
    const th = host({
      [REGISTRY]: JSON.stringify({ 'RNA-1': RECORD }),
      [`${B}/resources/labsamples/RNA.json`]: JSON.stringify({ 'RNA-1': RECORD }),
    });

    await edit(th, FOLDER, 'siKIF');

    expect(lastNotice(th)).toBe(
      `Sample updated: RNA-1 RNA-1 is also registered in other experiments (${B}); only this one changed.`,
    );
  });
});

describe('editSampleInteractive (app)', () => {
  const rec = () => JSON.parse(SAMPLE_VAULT[`${LOCAL}/DNA.json`])['DNA-1'];

  it('changing an alias rewrites exact references in scope after confirmation, one undo per open note', async () => {
    const th = host(SAMPLE_VAULT);
    const m = await th.mount(NOTE);
    th.answer.prompt('pUC19', 'miniprep', 'Freezer A / B3');
    th.answer.confirm(true);

    await editSampleInteractive(createSampleEnv(th.ctx), { folder: LOCAL, type: 'DNA', id: 'DNA-1', record: rec() });

    const doc = m.view().state.doc.toString();
    expect(doc).toContain('@dna;DNA-1;pUC19;miniprep');
    expect(doc).toContain('Use DNA-1;pUC19 and');
    expect(th.asked.confirm[0].message).toContain('001_clone');
    expect(json(th, `${LOCAL}/DNA.json`)['DNA-1'].alias).toBe('pUC19');
    act(() => void undo(m.view()));
    expect(m.view().state.doc.toString()).toContain('Use DNA-1;pUC and');
  });

  it('first alias offers to add ;alias to bare-ID references', async () => {
    const vault = {
      ...SAMPLE_VAULT,
      [`${LOCAL}/DNA.json`]: '{"DNA-1":{"type":"DNA","alias":"","descriptions":["miniprep"],"sources":["001_clone"]}}',
      [NOTE]: '# clone\n\nUse DNA-1 here.\n',
    };
    const th = host(vault);
    th.answer.prompt('pUC', 'miniprep', '');
    th.answer.confirm(true);

    await editSampleInteractive(createSampleEnv(th.ctx), {
      folder: LOCAL,
      type: 'DNA',
      id: 'DNA-1',
      record: JSON.parse(vault[`${LOCAL}/DNA.json`])['DNA-1'],
    });

    expect(th.asked.confirm[0].message).toContain("Add the alias 'pUC' to the references that show only the ID DNA-1");
    expect(th.vault.files()[NOTE]).toBe('# clone\n\nUse DNA-1;pUC here.\n');
  });

  it('edit rewrites a Korean list table row', async () => {
    const body = `${SAMPLE_VAULT[NOTE]}\n${koListHeader()}\n| DNA-1 | pUC | miniprep | Freezer A / B3 | 로컬 |  |\n`;
    const th = host({ ...SAMPLE_VAULT, [NOTE]: body });
    th.answer.prompt('pUC19', 'miniprep', 'Freezer A / B3');
    th.answer.confirm(true);

    await editSampleInteractive(createSampleEnv(th.ctx), { folder: LOCAL, type: 'DNA', id: 'DNA-1', record: rec() });

    const text = th.vault.files()[NOTE];
    expect(text).toContain('| DNA-1 | pUC19 | miniprep | Freezer A / B3 |');
    expect(text).toContain('Use DNA-1;pUC19 and');
    expect(text).toContain(koListHeader().split('\n')[0]);
  });

  it('edit refuses over a conflicted registry', async () => {
    const th = host({ ...SAMPLE_VAULT, [`${LOCAL}/DNA.json`]: CONFLICTED });
    th.answer.prompt('pUC19', 'miniprep', 'Freezer A / B3');

    await expect(
      editSampleInteractive(createSampleEnv(th.ctx), { folder: LOCAL, type: 'DNA', id: 'DNA-1', record: rec() }),
    ).rejects.toBeInstanceOf(RegistryUnreadableError);

    expect(th.vault.files()[`${LOCAL}/DNA.json`]).toBe(CONFLICTED);
    expect(th.vault.files()[NOTE]).toBe(SAMPLE_VAULT[NOTE]);
    // 친 글을 잃지 않게 묻기 전에 거절한다
    expect(th.asked.prompt).toHaveLength(0);
  });

  it('empty alias or first description asks before saving', async () => {
    const th = host(SAMPLE_VAULT);
    th.answer.prompt('', '', '');
    th.answer.confirm(false);

    expect(await editSampleInteractive(createSampleEnv(th.ctx), { folder: LOCAL, type: 'DNA', id: 'DNA-1', record: rec() })).toBe(
      false,
    );

    expect(th.asked.confirm.length).toBeGreaterThanOrEqual(1);
    expect(th.vault.files()[`${LOCAL}/DNA.json`]).toBe(SAMPLE_VAULT[`${LOCAL}/DNA.json`]);
  });
});

// #458
describe('setSampleDiscardedInteractive (vendor)', () => {
  const vault = () => ({ [REGISTRY]: JSON.stringify({ 'RNA-1': { ...RECORD, alias: null, descriptions: [], location: 'Freezer-2' } }) });
  const discard = (th: TestHost, discarded: boolean) =>
    setSampleDiscardedInteractive(createSampleEnv(th.ctx), { folder: FOLDER, type: 'RNA', id: 'RNA-1', discarded });
  const stored = (th: TestHost) => json(th, REGISTRY)['RNA-1'];
  const value = (v: boolean | null) => (items: Array<{ value: unknown }>) => items.find((i) => i.value === v)?.value;

  it('empties the location when picked and puts it back on unmark', async () => {
    const th = host(vault());
    th.answer.pick(value(true));
    expect(await discard(th, true)).toBe(true);
    expect(th.asked.pick[0].opts?.title).toBe('RNA-1 is stored at Freezer-2. Mark it discarded?');
    expect(stored(th)).toMatchObject({ location: null, discardedLocation: 'Freezer-2' });
    expect(lastNotice(th)).toBe('Marked RNA-1 as discarded.');
    await discard(th, false);
    expect(th.asked.pick).toHaveLength(1);
    expect(stored(th)).toMatchObject({ location: 'Freezer-2' });
    expect(lastNotice(th)).toBe('RNA-1 is no longer marked discarded.');
  });

  it('keeps the location when asked to', async () => {
    const th = host(vault());
    th.answer.pick(value(false));
    expect(await discard(th, true)).toBe(true);
    expect(stored(th)).toMatchObject({ location: 'Freezer-2', discarded: expect.any(String) });
  });

  // #524
  it('marks nothing when the question is cancelled or dismissed', async () => {
    const th = host(vault());
    th.answer.pick(value(null), undefined);
    for (let i = 0; i < 2; i++) {
      expect(await discard(th, true)).toBe(false);
      expect(stored(th).discarded).toBeUndefined();
    }
  });
});

describe('setSampleDiscardedInteractive (app)', () => {
  it('discard offers to empty the location, kept as discardedLocation; unmark restores it', async () => {
    const th = host(SAMPLE_VAULT);
    th.answer.pick((items: Array<{ value: unknown }>) => items[0].value);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-07T03:00:00Z'));

    expect(
      await setSampleDiscardedInteractive(createSampleEnv(th.ctx), { folder: LOCAL, type: 'DNA', id: 'DNA-1', discarded: true }),
    ).toBe(true);
    const after = json(th, `${LOCAL}/DNA.json`)['DNA-1'];
    expect(after.discarded).toBe('2026-11-07');
    expect(after).toMatchObject({ location: null, discardedLocation: 'Freezer A / B3' });
    expect(events).toContainEqual([`${LOCAL}/DNA.json`]);

    await setSampleDiscardedInteractive(createSampleEnv(th.ctx), { folder: LOCAL, type: 'DNA', id: 'DNA-1', discarded: false });
    expect(json(th, `${LOCAL}/DNA.json`)['DNA-1'].location).toBe('Freezer A / B3');
  });

  it('updates a Korean list table row when the mark changes', async () => {
    const body = `${SAMPLE_VAULT[NOTE]}\n${koListHeader()}\n| DNA-1 | pUC | miniprep | Freezer A / B3 | 로컬 |  |\n`;
    const th = host({ ...SAMPLE_VAULT, [NOTE]: body });
    th.answer.pick((items: Array<{ value: unknown }>) => items[1].value);

    await setSampleDiscardedInteractive(createSampleEnv(th.ctx), { folder: LOCAL, type: 'DNA', id: 'DNA-1', discarded: true });

    const row = th.vault.files()[NOTE].split('\n').find((l) => l.startsWith('| DNA-1 '))!;
    expect(row).not.toBe('| DNA-1 | pUC | miniprep | Freezer A / B3 | 로컬 |  |');
    expect(lastNotice(th)).toBe('Marked DNA-1 as discarded. Updated the sample list table in 1 note(s).');
  });

  it('a missing sample is reported and nothing is written', async () => {
    const th = host(SAMPLE_VAULT);
    expect(
      await setSampleDiscardedInteractive(createSampleEnv(th.ctx), { folder: LOCAL, type: 'DNA', id: 'DNA-404', discarded: false }),
    ).toBe(false);
    expect(lastNotice(th)).toBe('Sample not found: DNA-404');
    expect(th.vault.files()[`${LOCAL}/DNA.json`]).toBe(SAMPLE_VAULT[`${LOCAL}/DNA.json`]);
  });

  it('discard refuses over a conflicted registry', async () => {
    const th = host({ ...SAMPLE_VAULT, [`${LOCAL}/DNA.json`]: CONFLICTED });
    await expect(
      setSampleDiscardedInteractive(createSampleEnv(th.ctx), { folder: LOCAL, type: 'DNA', id: 'DNA-1', discarded: true }),
    ).rejects.toBeInstanceOf(RegistryUnreadableError);
    expect(th.vault.files()[`${LOCAL}/DNA.json`]).toBe(CONFLICTED);
  });
});
