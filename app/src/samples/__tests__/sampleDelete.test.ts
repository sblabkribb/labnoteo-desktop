// @vitest-environment jsdom
/**
 * 샘플 지우기(plan SP5 Task 21). vendor tests/plugin/sampleActions.test.ts 의 지우기 사례(#385 목록 표에만 있는 샘플,
 * 표 밖에서 쓰이는 샘플의 거절, #423 실험 밖 노트의 쓰임)를 앱 호스트로 옮기고, 앱의 안전 규칙(휴지통, 충돌한 대장)을 더했다.
 * 대화상자의 답은 `th.answer.confirm` 으로 차례로 적는다(답이 떨어지면 닫은 것처럼 false).
 */
import { getLang, setLang } from '../../i18n/lang';
import { coreT } from '../../labnote/i18n';
import { createTestHost, type TestHost } from '../../labnote/__tests__/testHost';
import { deleteSampleInteractive } from '../../labnote/port/sampleDelete';
import { createSampleEnv, RegistryUnreadableError, sampleEvents } from '../env';
import { CONFLICTED, LOCAL, NOTE, SAMPLE_VAULT } from './fixtures';

const A = 'labnote/001_Test';
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
  setLang(lang);
});

const json = (th: TestHost, p: string) => JSON.parse(th.vault.files()[p]);
const del = (th: TestHost, folder: string, type: string, id: string) =>
  deleteSampleInteractive(createSampleEnv(th.ctx), { folder, type, id });

describe('deleteSampleInteractive (vendor)', () => {
  // #385
  it('deletes a sample only a sample list table names, with its rows', async () => {
    const table = [
      '| ID | Alias | Description | Location | Scope | Discarded |',
      '| --- | --- | --- | --- | --- | --- |',
      '| RNA-1 | si KIF | kd |  | Local |  |',
      '| RNA-2 | other |  |  | Local |  |',
      '',
    ].join('\n');
    const th = host({
      [REGISTRY]: JSON.stringify({ 'RNA-1': RECORD, 'RNA-2': { ...RECORD, alias: 'other' } }),
      [`${A}/README.labnote.md`]: table,
    });
    th.answer.confirm(true);

    expect(await del(th, FOLDER, 'RNA', 'RNA-1')).toBe(true);

    expect(th.asked.confirm[0].message).toContain('RNA-1 is only listed in the sample list tables');
    // #391: what is deleted, beyond its ID.
    expect(th.asked.confirm[0].message).toContain('Alias: si KIF\nDescription: kd\nScope: Local');
    expect(th.asked.confirm[0].opts).toMatchObject({ confirmLabel: 'Delete', destructive: true });
    // #503: Ctrl+Z restored only the rows.
    expect(th.notes.at(-1)?.message).toBe(
      'Sample deleted: RNA-1;si KIF Ctrl+Z only brings back the table rows, not the sample record. To undo, add the sample again.',
    );
    expect(json(th, REGISTRY)).not.toHaveProperty('RNA-1');
    expect(th.vault.files()[`${A}/README.labnote.md`]).not.toContain('RNA-1');
    expect(th.vault.files()[`${A}/README.labnote.md`]).toContain('| RNA-2 | other |');
    expect(events).toContainEqual([REGISTRY]);
  });

  it('still refuses to delete a sample a note uses outside the table', async () => {
    const th = host({ [REGISTRY]: JSON.stringify({ 'RNA-1': RECORD }), [`${A}/001_WD010_A.labnote.md`]: 'RNA-1;si KIF\n' });

    expect(await del(th, FOLDER, 'RNA', 'RNA-1')).toBe(false);
    expect(json(th, REGISTRY)).toHaveProperty('RNA-1');
  });

  // #423: a daily note at the vault root naming a Local sample was not counted.
  it('refuses while a note outside every experiment uses a Local sample', async () => {
    const th = host({
      [REGISTRY]: JSON.stringify({ 'RNA-1': RECORD }),
      '2026-10-26.md': '- 로트1 RNA-1;si KIF\n',
      'Daily/2026-10-27.md': '- RNA-1;si KIF\n',
      'Daily/resources/labsamples/RNA.json': JSON.stringify({ 'RNA-1': RECORD }),
    });

    expect(await del(th, FOLDER, 'RNA', 'RNA-1')).toBe(false);
    expect(th.asked.confirm[0].message).toContain('2026-10-26.md');
    expect(th.asked.confirm[0].message).not.toContain('Daily/2026-10-27.md');
    expect(json(th, REGISTRY)).toHaveProperty('RNA-1');
  });
});

describe('deleteSampleInteractive (app)', () => {
  it('refuses while notes use it, naming each note by full path, and offers discard', async () => {
    const th = host(SAMPLE_VAULT);
    th.answer.confirm(false);
    expect(await del(th, LOCAL, 'DNA', 'DNA-1')).toBe(false);
    expect(th.asked.confirm[0].message).toContain(NOTE);
    expect(th.asked.confirm[0].opts?.confirmLabel).toBe(coreT('Mark as discarded'));
    expect(json(th, `${LOCAL}/DNA.json`)['DNA-1']).toBeDefined();
  });

  it('accepting the offer marks the sample discarded instead (#158)', async () => {
    const th = host({ ...SAMPLE_VAULT, [`${LOCAL}/DNA.json`]: '{"DNA-1":{"type":"DNA","alias":"pUC","descriptions":[],"sources":[]}}' });
    th.answer.confirm(true);
    expect(await del(th, LOCAL, 'DNA', 'DNA-1')).toBe(false);
    expect(json(th, `${LOCAL}/DNA.json`)['DNA-1'].discarded).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('an already discarded sample in use is refused with a notice only', async () => {
    const th = host({
      ...SAMPLE_VAULT,
      [`${LOCAL}/DNA.json`]: '{"DNA-1":{"type":"DNA","alias":"pUC","descriptions":[],"sources":[],"discarded":"2026-10-01"}}',
    });
    expect(await del(th, LOCAL, 'DNA', 'DNA-1')).toBe(false);
    expect(th.asked.confirm).toHaveLength(0);
    expect(th.notes.at(-1)?.message).toContain(NOTE);
    expect(json(th, `${LOCAL}/DNA.json`)['DNA-1']).toBeDefined();
  });

  it('AI-callout references still block delete', async () => {
    const th = host({ ...SAMPLE_VAULT, [NOTE]: '# clone\n\n> [!note] AI\n> DNA-1\n' });
    th.answer.confirm(false);
    expect(await del(th, LOCAL, 'DNA', 'DNA-1')).toBe(false);
    expect(th.asked.confirm[0].message).toContain(NOTE);
  });

  it('an unused sample is removed from the JSON, the file stays, list-table rows go', async () => {
    const vault = {
      ...SAMPLE_VAULT,
      [`${LOCAL}/DNA.json`]:
        '{"DNA-1":{"type":"DNA","alias":"pUC","descriptions":[],"sources":[]},"DNA-2":{"type":"DNA","alias":"","descriptions":[],"sources":[]}}',
      [NOTE]: '# clone\n\n| ID | Alias | Description | Location | Scope | Discarded |\n|---|---|---|---|---|---|\n| DNA-2 | | | | Local | |\n',
    };
    const th = host(vault);
    th.answer.confirm(true);
    expect(await del(th, LOCAL, 'DNA', 'DNA-2')).toBe(true);
    expect(Object.keys(json(th, `${LOCAL}/DNA.json`))).toEqual(['DNA-1']);
    expect(th.vault.files()[NOTE]).not.toContain('DNA-2');
    expect(th.vault.log.some((l) => l.cmd === 'vault_remove')).toBe(false);
  });

  it('removing the last sample does not permanently delete the file', async () => {
    const th = host({ ...SAMPLE_VAULT, [`${LOCAL}/DNA.json`]: '{"DNA-2":{"type":"DNA","alias":"","descriptions":[],"sources":[]}}' });
    th.answer.confirm(true);
    expect(await del(th, LOCAL, 'DNA', 'DNA-2')).toBe(true);
    expect(th.vault.log.some((l) => l.cmd === 'vault_remove')).toBe(false);
    const left = th.vault.files()[`${LOCAL}/DNA.json`];
    expect(left === undefined ? th.vault.recycleBin.map((e) => e.path) : JSON.parse(left)).toEqual(
      left === undefined ? [`${LOCAL}/DNA.json`] : {},
    );
  });

  it('declining the confirmation changes nothing', async () => {
    const th = host({ ...SAMPLE_VAULT, [`${LOCAL}/DNA.json`]: '{"DNA-2":{"type":"DNA","alias":"","descriptions":[],"sources":[]}}' });
    th.answer.confirm(false);
    expect(await del(th, LOCAL, 'DNA', 'DNA-2')).toBe(false);
    expect(json(th, `${LOCAL}/DNA.json`)).toHaveProperty('DNA-2');
  });

  it('refuses over a conflicted registry before asking, and touches no note', async () => {
    const body = '# clone\n\n| ID | Alias | Description | Location | Scope | Discarded |\n|---|---|---|---|---|---|\n| DNA-2 | | | | Local | |\n';
    const th = host({ ...SAMPLE_VAULT, [`${LOCAL}/DNA.json`]: CONFLICTED, [NOTE]: body });
    th.answer.confirm(true);
    await expect(del(th, LOCAL, 'DNA', 'DNA-2')).rejects.toBeInstanceOf(RegistryUnreadableError);
    expect(th.asked.confirm).toHaveLength(0);
    expect(th.vault.files()[`${LOCAL}/DNA.json`]).toBe(CONFLICTED);
    expect(th.vault.files()[NOTE]).toBe(body);
  });

  it('a Global sample keeps the rows of an experiment whose Local record shadows it', async () => {
    const table = (id: string) =>
      `| ID | Alias | Description | Location | Scope | Discarded |\n|---|---|---|---|---|---|\n| ${id} | | | | Global | |\n`;
    const th = host({
      [`${GLOBAL}/RNA.json`]: JSON.stringify({ 'RNA-1': RECORD }),
      [`${A}/001_WD010_A.labnote.md`]: table('RNA-1'),
      [REGISTRY]: JSON.stringify({ 'RNA-1': RECORD }),
      'labnote/002_Other/001_WD010_C.labnote.md': table('RNA-1'),
    });
    th.answer.confirm(true);
    expect(await del(th, GLOBAL, 'RNA', 'RNA-1')).toBe(true);
    expect(th.vault.files()[`${A}/001_WD010_A.labnote.md`]).toContain('RNA-1');
    expect(th.vault.files()['labnote/002_Other/001_WD010_C.labnote.md']).not.toContain('RNA-1');
    expect(json(th, `${GLOBAL}/RNA.json`)).not.toHaveProperty('RNA-1');
  });
});
