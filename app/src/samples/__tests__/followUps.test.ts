// @vitest-environment jsdom
/**
 * 앱에서 한 이름 바꾸기와 삭제 뒤의 샘플 후속 처리(plan SP5 Task 26, D14). 플러그인 main.ts 의 rename/delete 듣기와 같다:
 * - 실험 안에서 제자리 이름이 바뀐 노트는 Local 대장의 sources 에서도 새 이름이 된다(#149).
 * - 대장 `{Type}.json` 이나 `resources/labsamples` 가 이름을 잃으면 되돌릴지 묻는다(#430, #338). 이름 바꾸기가 끝난 뒤에만.
 * - 지운 대장은 알린다(그 폴더째 지웠으면 알리지 않는다, 플러그인과 같다). 지운 워크플로 노트는 sources 에서만 빠진다.
 * - 샘플 추적이 꺼진 실험에는 아무것도 하지 않는다.
 */
import { createTestHost, type TestHost } from '../../labnote/__tests__/testHost';
import { coreT } from '../../labnote/i18n';
import { entryEvents } from '../../labnote/commands/entryEvents';
import { deleteEntry, renameEntry } from '../../labnote/commands/fileOps';
import { queueSampleSourceRenames } from '../../labnote/port/sampleLedger';
import { planRename } from '../../links/planRename';
import { renameWithLinks } from '../../links/renameWithLinks';
import { getLang, setLang } from '../../i18n/lang';
import { t } from '../../i18n/t';
import { createSampleEnv } from '../env';
import { wireSampleFollowUps } from '../followUps';
import { samples } from '../sampleStore';
import { GLOBAL, LOCAL, NOTE, SAMPLE_VAULT } from './fixtures';

vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));

const SCRATCH = 'labnote/061_PCR/scratch.labnote.md';
const OLD = 'labnote/061_PCR/resources/samples_old';
const GEL_SCRATCH = 'labnote/062_Gel/scratch.labnote.md';
const GEL_LOCAL = 'labnote/062_Gel/resources/labsamples';
const GEL_RUN = 'labnote/062_Gel/001_run.labnote.md';
const NOTE2 = 'labnote/061_PCR/002_digest.labnote.md';

/** sources 에 플러그인이 실제로 쓰는 이름(노트 파일 이름 전체)을 담은 보관함. */
const VAULT: Record<string, string> = {
  ...SAMPLE_VAULT,
  [SCRATCH]: '# scratch\n\n@dna;DNA-2;pET;scratch\n',
  [NOTE2]: '# digest\n\nUse Reagent-7.\n',
  [`${LOCAL}/DNA.json`]: JSON.stringify({
    'DNA-1': { type: 'DNA', alias: 'pUC', descriptions: ['miniprep'], sources: ['001_clone.labnote.md'] },
    'DNA-2': { type: 'DNA', alias: 'pET', descriptions: ['scratch'], sources: ['scratch.labnote.md'] },
  }),
  [`${GLOBAL}/Reagent.json`]: JSON.stringify({
    'Reagent-7': {
      type: 'Reagent',
      alias: 'Taq',
      descriptions: ['polymerase'],
      sources: ['001_clone.labnote.md', '002_digest.labnote.md', 'elsewhere.labnote.md'],
    },
  }),
  [GEL_SCRATCH]: '# scratch\n\n@dna;DNA-5;pX;gel\n',
  [`${GEL_LOCAL}/DNA.json`]: JSON.stringify({
    'DNA-5': { type: 'DNA', alias: 'pX', descriptions: ['gel'], sources: ['scratch.labnote.md', '001_run.labnote.md'] },
  }),
};

const FOLDER_GONE =
  '"{0}" no longer has resources/labsamples: its Local samples will show as unregistered, and new ones go to a new, empty registry.';
const LEDGER_RENAMED =
  '{0} was renamed to {1}: its {2} {3} sample(s) will show as unregistered, and the next {3} sample added starts a new, empty {0}.';

let hosts: TestHost[] = [];
const offs: Array<() => void> = [];
const lang = getLang();

function setup(files: Record<string, string> = VAULT, settings = {}): TestHost {
  const th = createTestHost(files, settings);
  hosts.push(th);
  samples.resetForTest();
  samples.configure(th.host.fs, th.ctx.settings);
  offs.push(wireSampleFollowUps(() => createSampleEnv(th.ctx)));
  return th;
}
const json = (th: TestHost, p: string) => JSON.parse(th.vault.files()[p]);
const registryWrites = (th: TestHost) =>
  th.vault.log.filter((e) => (e.cmd === 'vault_modify' || e.cmd === 'vault_write') && String(e.args.path).includes('labsamples'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function renameWithPlan(th: TestHost, from: string, to: string, isDir: boolean) {
  const links = th.ctx.links!;
  const plan = await planRename({
    from,
    to,
    isDir,
    index: links.index,
    images: links.images,
    read: (p) => th.host.fs.read(p),
    search: links.search,
    activePath: undefined,
  });
  return renameWithLinks(th.ctx, plan, links.journal);
}

beforeEach(() => setLang('en'));
afterEach(() => {
  for (const off of offs.splice(0)) off();
  samples.resetForTest();
  for (const th of hosts) th.cleanup();
  hosts = [];
  vi.restoreAllMocks();
  setLang(lang);
});

describe('wireSampleFollowUps: renames', () => {
  it('a note renamed in place renames its sources in the Local registry', async () => {
    const th = setup();
    th.answer.prompt('notes');
    expect(await renameEntry(th.ctx, SCRATCH, false, [])).toBe('labnote/061_PCR/notes.labnote.md');
    await vi.waitFor(() => expect(json(th, `${LOCAL}/DNA.json`)['DNA-2'].sources).toEqual(['notes.labnote.md']));
    expect(json(th, `${LOCAL}/DNA.json`)['DNA-1'].sources).toEqual(['001_clone.labnote.md']);
  });

  it('queueSampleSourceRenames applies renames one after another per experiment', async () => {
    const th = setup();
    const env = createSampleEnv(th.ctx);
    const first = queueSampleSourceRenames(env, 'labnote/061_PCR', new Map([['scratch.labnote.md', 'a.labnote.md']]));
    const second = queueSampleSourceRenames(env, 'labnote/061_PCR', new Map([['a.labnote.md', 'b.labnote.md']]));
    await Promise.all([first, second]);
    expect(json(th, `${LOCAL}/DNA.json`)['DNA-2'].sources).toEqual(['b.labnote.md']);
  });

  it('no follow-up dialog opens before the rename settles', async () => {
    const th = setup();
    await th.host.fs.rename(LOCAL, OLD);
    let settle!: () => void;
    const settled = new Promise<void>((r) => (settle = r));
    entryEvents.emit({
      kind: 'renamed',
      from: LOCAL,
      to: OLD,
      isDir: true,
      files: [{ from: `${LOCAL}/DNA.json`, to: `${OLD}/DNA.json` }],
      settled,
    });
    await sleep(50);
    expect(th.asked.confirm).toHaveLength(0);
    settle();
    await vi.waitFor(() => expect(th.asked.confirm).toHaveLength(1));
    expect(th.asked.confirm[0].message).toContain(coreT(FOLDER_GONE, '061_PCR'));
    expect(th.asked.confirm[0].message).toContain(coreT('Rename it back to "{0}"?', LOCAL));
    expect(th.asked.confirm[0].opts?.confirmLabel).toBe(coreT('Rename back'));
  });

  it('a renamed labsamples folder offers to put it back; yes renames it back', async () => {
    const th = setup();
    th.answer.confirm(true);
    await renameWithPlan(th, LOCAL, OLD, true);
    await vi.waitFor(() => expect(th.vault.files()[`${LOCAL}/DNA.json`]).toBeDefined());
    expect(th.vault.files()[`${OLD}/DNA.json`]).toBeUndefined();
    expect(th.asked.confirm).toHaveLength(1);
  });

  it('a renamed resources folder holding an empty labsamples folder still offers it back', async () => {
    const files = { ...VAULT };
    delete files[`${LOCAL}/DNA.json`];
    const th = setup(files);
    await th.host.fs.mkdir(LOCAL);
    th.answer.confirm(false);
    await renameWithPlan(th, 'labnote/061_PCR/resources', 'labnote/061_PCR/resources_old', true);
    await vi.waitFor(() => expect(th.asked.confirm).toHaveLength(1));
    expect(th.asked.confirm[0].message).toContain(coreT(FOLDER_GONE, '061_PCR'));
  });

  it('declining keeps the new folder name', async () => {
    const th = setup();
    th.answer.confirm(false);
    await renameWithPlan(th, LOCAL, OLD, true);
    await vi.waitFor(() => expect(th.asked.confirm).toHaveLength(1));
    await sleep(20);
    expect(th.vault.files()[`${OLD}/DNA.json`]).toBeDefined();
    expect(th.vault.files()[`${LOCAL}/DNA.json`]).toBeUndefined();
  });

  it('a registry renamed within its folder offers its name back', async () => {
    const th = setup();
    th.answer.confirm(true);
    await renameWithPlan(th, `${LOCAL}/DNA.json`, `${LOCAL}/DNA_old.json`, false);
    await vi.waitFor(() => expect(th.vault.files()[`${LOCAL}/DNA.json`]).toBeDefined());
    expect(th.asked.confirm[0].message).toContain(coreT(LEDGER_RENAMED, `${LOCAL}/DNA.json`, `${LOCAL}/DNA_old.json`, '2', 'DNA'));
    expect(th.vault.files()[`${LOCAL}/DNA_old.json`]).toBeUndefined();
  });

  it('a registry that went along with its renamed folder is not offered back on its own', async () => {
    const th = setup();
    await renameWithPlan(th, GLOBAL, 'resources/samples2', true);
    await sleep(50);
    expect(th.asked.confirm).toHaveLength(0);
  });

  it('tracking off in the experiment: no follow-ups', async () => {
    const th = setup();
    th.answer.prompt('notes');
    expect(await renameEntry(th.ctx, GEL_SCRATCH, false, [])).toBe('labnote/062_Gel/notes.labnote.md');
    await sleep(50);
    expect(registryWrites(th)).toEqual([]);
    expect(th.asked.confirm).toHaveLength(0);
  });

  it('tracking off in the settings: no follow-ups', async () => {
    const th = setup(VAULT, { sampleTracking: false });
    th.answer.prompt('notes');
    await renameEntry(th.ctx, SCRATCH, false, []);
    await renameWithPlan(th, LOCAL, OLD, true);
    await sleep(50);
    expect(registryWrites(th)).toEqual([]);
    expect(th.asked.confirm).toHaveLength(0);
  });
});

describe('wireSampleFollowUps: deletes', () => {
  it('a deleted registry gives a notice that names the Recycle Bin (the app deletes to it, not to .trash)', async () => {
    // 가짜 보관함은 마지막 파일이 빠진 폴더를 없는 것으로 본다(디스크에는 빈 폴더가 남는다): 대장을 하나 더 둔다
    const th = setup({ ...VAULT, [`${LOCAL}/Plasmid.json`]: '{}' });
    th.answer.confirm(true);
    expect(await deleteEntry(th.ctx, `${LOCAL}/DNA.json`, false)).toBe(true);
    const notice = t('samples.registryDeletedRecycleBin', `${LOCAL}/DNA.json`, 'DNA');
    expect(notice).toContain('Recycle Bin');
    expect(notice).not.toContain('.trash');
    await vi.waitFor(() => expect(th.notes).toContainEqual({ kind: 'warn', message: notice }), { timeout: 2000 });
  });

  it('a deleted labsamples folder gives no registry notice (its folder went too, as in the plugin)', async () => {
    const th = setup();
    th.answer.confirm(true);
    expect(await deleteEntry(th.ctx, LOCAL, true)).toBe(true);
    await sleep(700);
    expect(th.notes.filter((n) => n.message.includes('was deleted'))).toEqual([]);
  });

  it('deleting a workflow note removes it from sources but keeps the records', async () => {
    const th = setup();
    th.answer.confirm(true, false);
    expect(await deleteEntry(th.ctx, NOTE, false)).toBe(true);
    await vi.waitFor(() => expect(json(th, `${LOCAL}/DNA.json`)['DNA-1'].sources).toEqual([]));
    expect(json(th, `${LOCAL}/DNA.json`)['DNA-1'].alias).toBe('pUC');
    expect(json(th, `${GLOBAL}/Reagent.json`)['Reagent-7'].sources).toEqual(['002_digest.labnote.md', 'elsewhere.labnote.md']);
  });

  it('deleting a folder of workflow notes prunes the sources of each', async () => {
    const th = setup();
    th.answer.confirm(true);
    expect(await deleteEntry(th.ctx, 'labnote/061_PCR', true)).toBe(true);
    await vi.waitFor(() => expect(json(th, `${GLOBAL}/Reagent.json`)['Reagent-7'].sources).toEqual(['elsewhere.labnote.md']));
  });

  it('tracking off: a deleted workflow note keeps its sources', async () => {
    const th = setup();
    th.answer.confirm(true, false);
    expect(await deleteEntry(th.ctx, GEL_RUN, false)).toBe(true);
    await sleep(50);
    expect(registryWrites(th)).toEqual([]);
  });
});
