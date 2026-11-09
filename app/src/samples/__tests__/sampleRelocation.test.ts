// @vitest-environment jsdom
/**
 * 노트가 다른 실험으로 옮겨 가면 그 노트가 쓰던 Local 샘플을 함께 가져올지 묻는다(plan SP5 Task 27, 플러그인 #97).
 * - 옮긴 뒤(settled 뒤) 실험 짝 (옛, 새)마다 1000 ms 모아서 한 번 묻는다(main.ts offerLocalSamplesMoved).
 * - 옛 실험의 다른 노트가 아직 쓰는 샘플은 옮기지 않고 복사한다. 그때는 Global 로 옮기는 선택이 있다(#173).
 * - "Sync workflow checklist with folder" 는 전에 두고 온 샘플을 다시 묻는다(offerSamplesLeftBehind).
 * - 샘플 추적이 꺼진 실험으로 옮기면 묻지 않는다. 읽을 수 없는 대장은 덮어쓰지 않는다.
 * 플러그인의 답 이름표(Move/Copy/Leave 는 없다): 옮기기만 있으면 확인('Bring samples'), 복사가 있으면
 * pick('bring' | 'global' | 'cancel'), 거절하면 남겨 두었다는 알림.
 */
import { createTestHost, type TestHost } from '../../labnote/__tests__/testHost';
import { coreT } from '../../labnote/i18n';
import { syncWorkflowChecklist } from '../../labnote/commands/syncChecklist';
import { planRename } from '../../links/planRename';
import { renameWithLinks } from '../../links/renameWithLinks';
import { getLang, setLang } from '../../i18n/lang';
import { t } from '../../i18n/t';
import { createSampleEnv } from '../env';
import { wireSampleFollowUps } from '../followUps';
import { samples } from '../sampleStore';
import { SAMPLE_MOVE_BATCH_MS } from '../../labnote/port/sampleRelocation';
import { CONFLICTED, GLOBAL, LOCAL, NOTE, README, SAMPLE_VAULT } from './fixtures';

vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));

const X = 'labnote/063_X';
const X_LOCAL = `${X}/resources/labsamples`;
const X_README = README.replace(/061 PCR/g, '063 X') + '\n## 🗂️ Related Workflows\n\n## Summary and Discussion\n';
const vault = (extra: Record<string, string> = {}): Record<string, string> => ({
  ...SAMPLE_VAULT,
  [`${X}/README.labnote.md`]: X_README,
  ...extra,
});
const BRING_QUESTION =
  "Notes in {0} use {1} local sample(s) that are still in another experiment's registry, so the notes cannot find them. Bring them into {0}?";
const LEFT_BEHIND = 'The local samples stay in {0}. To bring them later, run "{1}" from a note in {2}.';
const WAIT = { timeout: 4000 };

let hosts: TestHost[] = [];
const offs: Array<() => void> = [];
const lang = getLang();

function setup(files: Record<string, string> = vault()): TestHost {
  const th = createTestHost(files);
  hosts.push(th);
  samples.resetForTest();
  samples.configure(th.host.fs, th.ctx.settings);
  offs.push(wireSampleFollowUps(() => createSampleEnv(th.ctx)));
  return th;
}
const registry = (th: TestHost, p: string) => {
  const text = th.vault.files()[p];
  return text === undefined ? {} : JSON.parse(text);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function move(th: TestHost, from: string, to: string, isDir = false) {
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

describe('offerSamplesAfterMove through the follow-ups', () => {
  it('batches for SAMPLE_MOVE_BATCH_MS like the plugin', () => {
    expect(SAMPLE_MOVE_BATCH_MS).toBe(1000);
  });

  it('a note moved to another experiment offers to bring its Local samples; yes moves them', async () => {
    const th = setup();
    th.answer.confirm(true);
    await move(th, NOTE, `${X}/001_clone.labnote.md`);
    await vi.waitFor(() => expect(registry(th, `${X_LOCAL}/DNA.json`)['DNA-1']?.alias).toBe('pUC'), WAIT);
    expect(th.asked.confirm).toHaveLength(1);
    expect(th.asked.confirm[0].message).toContain(coreT(BRING_QUESTION, '063_X', '1'));
    expect(th.asked.confirm[0].message).toContain(`- DNA-1 (pUC): ${coreT('move from {0}', '061_PCR')}`);
    expect(th.asked.confirm[0].opts?.confirmLabel).toBe(coreT('Bring samples'));
    expect(registry(th, `${X_LOCAL}/DNA.json`)['DNA-1'].sources).toEqual(['001_clone.labnote.md']);
    expect(registry(th, `${LOCAL}/DNA.json`)['DNA-1']).toBeUndefined();
    // Global 에 있는 Reagent-7 은 그대로 풀리므로 가져오지 않는다
    expect(th.vault.files()[`${X_LOCAL}/Reagent.json`]).toBeUndefined();
    await vi.waitFor(() =>
      expect(th.notes.map((n) => n.message)).toContain(coreT('Brought {0} local sample(s) into {1}.', '1', '063_X')),
    );
  });

  it('no offer before the batch time has passed', async () => {
    const th = setup();
    th.answer.confirm(false);
    await move(th, NOTE, `${X}/001_clone.labnote.md`);
    await sleep(300);
    expect(th.asked.confirm).toHaveLength(0);
    await vi.waitFor(() => expect(th.asked.confirm).toHaveLength(1), WAIT);
  });

  it('declining leaves the samples and says how to bring them later', async () => {
    const th = setup();
    th.answer.confirm(false);
    await move(th, NOTE, `${X}/001_clone.labnote.md`);
    const told = coreT(LEFT_BEHIND, '061_PCR', coreT('Sync workflow checklist with folder'), '063_X');
    await vi.waitFor(() => expect(th.notes.map((n) => n.message)).toContain(told), WAIT);
    expect(registry(th, `${LOCAL}/DNA.json`)['DNA-1'].alias).toBe('pUC');
    expect(th.vault.files()[`${X_LOCAL}/DNA.json`]).toBeUndefined();
  });

  it('moving a subfolder of two notes gives one offer that brings the sample for both', async () => {
    const SUB = 'labnote/061_PCR/sub';
    const files = vault({
      [`${SUB}/001_a.labnote.md`]: '# a\n\nUse DNA-1.\n',
      [`${SUB}/002_b.labnote.md`]: '# b\n\nUse DNA-1 again.\n',
    });
    delete files[NOTE]; // 061 에 DNA-1 을 쓰는 노트가 남지 않게
    const th = setup(files);
    th.answer.confirm(true);
    await move(th, SUB, `${X}/sub`, true);
    await vi.waitFor(() => expect(registry(th, `${X_LOCAL}/DNA.json`)['DNA-1']).toBeDefined(), WAIT);
    await sleep(50);
    expect(th.asked.confirm).toHaveLength(1);
    expect(th.asked.confirm[0].message).toContain(coreT(BRING_QUESTION, '063_X', '1'));
    expect([...registry(th, `${X_LOCAL}/DNA.json`)['DNA-1'].sources].sort()).toEqual(['001_a.labnote.md', '002_b.labnote.md']);
  });

  it('a sample the old experiment still uses is copied ("bring"): both registries keep it', async () => {
    const MORE = 'labnote/061_PCR/002_more.labnote.md';
    const th = setup(vault({ [MORE]: '# more\n\nUse DNA-1 here too.\n' }));
    th.answer.pick('bring');
    await move(th, MORE, `${X}/002_more.labnote.md`);
    await vi.waitFor(() => expect(registry(th, `${X_LOCAL}/DNA.json`)['DNA-1']).toBeDefined(), WAIT);
    expect(th.asked.pick).toHaveLength(1);
    expect(th.asked.pick[0].items.map((i) => i.value)).toEqual(['bring', 'global', 'cancel']);
    expect(th.asked.pick[0].opts?.placeholder).toBe(coreT(BRING_QUESTION, '063_X', '1'));
    expect(registry(th, `${X_LOCAL}/DNA.json`)['DNA-1'].sources).toEqual(['002_more.labnote.md']);
    expect(registry(th, `${LOCAL}/DNA.json`)['DNA-1'].alias).toBe('pUC');
  });

  it('"global" moves a sample both experiments use to the Global registry', async () => {
    const MORE = 'labnote/061_PCR/002_more.labnote.md';
    const th = setup(vault({ [MORE]: '# more\n\nUse DNA-1 here too.\n' }));
    th.answer.pick('global');
    await move(th, MORE, `${X}/002_more.labnote.md`);
    await vi.waitFor(() => expect(registry(th, `${GLOBAL}/DNA.json`)['DNA-1']).toBeDefined(), WAIT);
    await vi.waitFor(() => expect(registry(th, `${LOCAL}/DNA.json`)['DNA-1']).toBeUndefined());
    expect(th.vault.files()[`${X_LOCAL}/DNA.json`]).toBeUndefined();
    await vi.waitFor(() => expect(th.notes.map((n) => n.message)).toContain(coreT('Moved to Global: {0}', 'DNA-1')));
  });

  it('moving into an untracked experiment offers nothing', async () => {
    const th = setup();
    await move(th, NOTE, 'labnote/062_Gel/001_clone.labnote.md');
    await sleep(SAMPLE_MOVE_BATCH_MS + 300);
    expect(th.asked.confirm).toHaveLength(0);
    expect(th.asked.pick).toHaveLength(0);
  });

  it('a conflicted target registry is never overwritten and the source record stays', async () => {
    const th = setup(vault({ [`${X_LOCAL}/DNA.json`]: CONFLICTED }));
    th.answer.confirm(true);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await move(th, NOTE, `${X}/001_clone.labnote.md`);
    await vi.waitFor(() => expect(th.asked.confirm).toHaveLength(1), WAIT);
    await vi.waitFor(() =>
      expect(th.notes).toContainEqual({ kind: 'warn', message: t('samples.registryUnreadable', `${X_LOCAL}/DNA.json`) }),
    );
    expect(th.vault.files()[`${X_LOCAL}/DNA.json`]).toBe(CONFLICTED);
    expect(registry(th, `${LOCAL}/DNA.json`)['DNA-1'].alias).toBe('pUC');
  });
});

describe('sync-workflow-checklist and samples left behind', () => {
  it('offers the samples a note left in another experiment and brings them on yes', async () => {
    const files = vault({ [`${X}/001_clone.labnote.md`]: SAMPLE_VAULT[NOTE] });
    delete files[NOTE]; // 예전에 옮기며 남겨 두기를 고른 상태
    const th = setup(files);
    th.answer.confirm(true);
    th.setActive(`${X}/001_clone.labnote.md`);
    await syncWorkflowChecklist(th.ctx);
    expect(th.asked.confirm).toHaveLength(1);
    expect(th.asked.confirm[0].message).toContain(coreT(BRING_QUESTION, '063_X', '1'));
    expect(registry(th, `${X_LOCAL}/DNA.json`)['DNA-1'].alias).toBe('pUC');
    expect(registry(th, `${LOCAL}/DNA.json`)['DNA-1']).toBeUndefined();
    expect(th.notes.at(-1)?.message).toContain(coreT('Brought {0} local sample(s) into {1}.', '1', '063_X'));
  });

  it('asks nothing when the experiment does not track samples', async () => {
    const GEL = 'labnote/062_Gel';
    const files = vault({
      [`${GEL}/README.labnote.md`]: SAMPLE_VAULT[`${GEL}/README.labnote.md`] + '\n## 🗂️ Related Workflows\n',
      [`${GEL}/001_clone.labnote.md`]: SAMPLE_VAULT[NOTE],
    });
    delete files[NOTE];
    const th = setup(files);
    th.setActive(`${GEL}/001_clone.labnote.md`);
    await syncWorkflowChecklist(th.ctx);
    expect(th.asked.confirm).toHaveLength(0);
    expect(registry(th, `${LOCAL}/DNA.json`)['DNA-1'].alias).toBe('pUC');
  });
});
