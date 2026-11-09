// @vitest-environment jsdom
/**
 * 저장 때의 샘플 동기화(plan SP5 Task 17, D12). 노트의 `@type;ID;…` 정의가 마지막 변경 800 ms 뒤 `{Type}.json` 으로 간다:
 * 편집기 입력(touch), 닫힌 노트에 대한 processNote(noteWrites), 밖에서 고친 노트(감시자 → touchPath).
 * 읽지 못하는 대장은 덮지 않고 세션에 한 번 알린다. 별칭 겹침은 플러그인처럼 (종류, ID, 별칭 묶음)마다 한 번 알린다.
 */
import { EditorState } from '@codemirror/state';
import { getLang, setLang } from '../../i18n/lang';
import { t } from '../../i18n/t';
import { createTestHost, type TestHost } from '../../labnote/__tests__/testHost';
import { coreT } from '../../labnote/i18n';
import { processNote } from '../../labnote/openNotes';
import { createSampleEnv } from '../env';
import { samples } from '../sampleStore';
import { SAMPLE_SYNC_MS, SampleSync, samplesSync, setSampleSyncEnv } from '../sync';
import { CONFLICTED, GLOBAL, koListHeader, LOCAL, NOTE, SAMPLE_VAULT } from './fixtures';

vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));

const RUN = 'labnote/062_Gel/001_run.labnote.md';
const NOTE2 = 'labnote/061_PCR/002_digest.labnote.md';
const NOTE3 = 'labnote/061_PCR/003_ligate.labnote.md';
const ALIAS_KEY =
  '{0} is defined with different aliases: {1}. The sample keeps the alias of the definition changed last; use "Edit sample" to settle on one and fix the notes together.';

type FakeView = { composing: boolean; compositionStarted: boolean; state: EditorState };
const viewWith = (text: string): FakeView => ({ composing: false, compositionStarted: false, state: EditorState.create({ doc: text }) });

let hosts: TestHost[] = [];
let syncs: SampleSync[] = [];
const lang = getLang();

function setup(files: Record<string, string> = SAMPLE_VAULT, settings = {}): TestHost {
  const th = createTestHost(files, settings);
  hosts.push(th);
  samples.resetForTest();
  samples.configure(th.host.fs, th.ctx.settings);
  setSampleSyncEnv(() => createSampleEnv(th.ctx));
  return th;
}
function sync(): SampleSync {
  const s = new SampleSync();
  syncs.push(s);
  return s;
}
const json = (th: TestHost, p: string) => JSON.parse(th.vault.files()[p]);
/** 대장(labsamples 아래) 쓰기 호출. */
const registryWrites = (th: TestHost) =>
  th.vault.log.filter((e) => (e.cmd === 'vault_modify' || e.cmd === 'vault_write') && String(e.args.path).includes('labsamples'));
const warns = (th: TestHost) => th.notes.filter((n) => n.kind === 'warn');

beforeEach(() => {
  vi.useFakeTimers();
  setLang('en');
});
afterEach(async () => {
  for (const s of syncs.splice(0)) s.dispose();
  await samplesSync.flush();
  setSampleSyncEnv(() => undefined);
  vi.useRealTimers();
  vi.restoreAllMocks();
  samples.resetForTest();
  for (const th of hosts) th.cleanup();
  hosts = [];
  setLang(lang);
});

describe('SampleSync', () => {
  it('waits SAMPLE_SYNC_MS = 800', () => {
    expect(SAMPLE_SYNC_MS).toBe(800);
  });

  it('syncs a tracked labnote note 800 ms after the last change', async () => {
    const th = setup();
    const s = sync();
    const base = SAMPLE_VAULT[NOTE];
    s.touch(NOTE, viewWith(`${base}\nv1\n`));
    await vi.advanceTimersByTimeAsync(500);
    s.touch(NOTE, viewWith(`${base}\nv2\n`));
    await vi.advanceTimersByTimeAsync(500);
    s.touch(NOTE, viewWith(`${base}\n@dna;DNA-2;pX;new\n`));
    await vi.advanceTimersByTimeAsync(799);
    expect(registryWrites(th)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await s.flush();
    expect(registryWrites(th)).toHaveLength(1);
    // 코어 saveSamplesFromDocument 는 노트의 basename 을 sources 에 적는다(플러그인과 같다)
    expect(json(th, `${LOCAL}/DNA.json`)['DNA-2']).toMatchObject({ alias: 'pX', descriptions: ['new'], sources: ['001_clone.labnote.md'] });
  });

  it('a processNote write into a closed note syncs', async () => {
    const th = setup();
    await processNote(th.host.fs, NOTE, (s) => s + '\n@dna;DNA-2;x;y\n');
    await vi.advanceTimersByTimeAsync(800);
    await samplesSync.flush();
    expect(json(th, `${LOCAL}/DNA.json`)['DNA-2']).toMatchObject({ alias: 'x', descriptions: ['y'] });
  });

  it('an external modify event syncs', async () => {
    const th = setup();
    const s = sync();
    await th.host.fs.write(NOTE, `${SAMPLE_VAULT[NOTE]}\n@dna;DNA-2;ext;outside\n`);
    s.touchPath(NOTE);
    await vi.advanceTimersByTimeAsync(800);
    await s.flush();
    expect(json(th, `${LOCAL}/DNA.json`)['DNA-2']).toMatchObject({ alias: 'ext', descriptions: ['outside'] });
  });

  it('skips plain .md, untracked experiments and tracking off', async () => {
    const files = { ...SAMPLE_VAULT, 'Home.md': '# Home\n@dna;DNA-3;a;b\n', [RUN]: '# run\n\n@dna;DNA-3;a;b\n' };
    const th = setup(files);
    const s = sync();
    s.touchPath('Home.md');
    s.touchPath(RUN);
    await vi.advanceTimersByTimeAsync(800);
    await s.flush();
    expect(registryWrites(th)).toHaveLength(0);

    const off = setup({ ...SAMPLE_VAULT, [NOTE]: `${SAMPLE_VAULT[NOTE]}\n@dna;DNA-3;a;b\n` }, { sampleTracking: false });
    s.touchPath(NOTE);
    await vi.advanceTimersByTimeAsync(800);
    await s.flush();
    expect(registryWrites(off)).toHaveLength(0);
  });

  it('a cold tracking cache still keeps 062 untouched', async () => {
    const th = setup({ ...SAMPLE_VAULT, [RUN]: '# run\n\n@dna;DNA-3;a;b\n' });
    samples.resetForTest();
    samples.configure(th.host.fs, th.ctx.settings);
    const s = sync();
    s.touchPath(RUN);
    await vi.advanceTimersByTimeAsync(800);
    await s.flush();
    expect(registryWrites(th)).toHaveLength(0);
  });

  it('reschedules while composing', async () => {
    const th = setup();
    const s = sync();
    const view = viewWith(`${SAMPLE_VAULT[NOTE]}\n@dna;DNA-2;a;b\n`);
    view.composing = true;
    s.touch(NOTE, view);
    await vi.advanceTimersByTimeAsync(800);
    expect(registryWrites(th)).toHaveLength(0);
    view.composing = false;
    await vi.advanceTimersByTimeAsync(799);
    expect(registryWrites(th)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await s.flush();
    expect(json(th, `${LOCAL}/DNA.json`)['DNA-2']).toMatchObject({ alias: 'a' });
  });

  it('Korean list-table rows are not synced', async () => {
    const th = setup();
    const s = sync();
    const text = `${SAMPLE_VAULT[NOTE]}\n${koListHeader()}\n| DNA-77 | x | | | 로컬 | |\n`;
    s.touch(NOTE, viewWith(text));
    await vi.advanceTimersByTimeAsync(800);
    await s.flush();
    expect(json(th, `${LOCAL}/DNA.json`)['DNA-77']).toBeUndefined();
  });

  it('sync leaves an unparsable registry untouched', async () => {
    const th = setup({ ...SAMPLE_VAULT, [`${LOCAL}/DNA.json`]: CONFLICTED });
    const s = sync();
    s.touch(NOTE, viewWith(`${SAMPLE_VAULT[NOTE]}\n@dna;DNA-2;a;b\n`));
    await vi.advanceTimersByTimeAsync(800);
    await s.flush();
    expect(th.vault.files()[`${LOCAL}/DNA.json`]).toBe(CONFLICTED);
    expect(warns(th)).toEqual([{ kind: 'warn', message: t('samples.syncFailed', `${LOCAL}/DNA.json`) }]);
  });

  it('a failure toasts once per session, later failures are silent', async () => {
    const th = setup({ ...SAMPLE_VAULT, [`${LOCAL}/DNA.json`]: CONFLICTED });
    const s = sync();
    s.touch(NOTE, viewWith(`${SAMPLE_VAULT[NOTE]}\n@dna;DNA-2;a;b\n`));
    await vi.advanceTimersByTimeAsync(800);
    await s.flush();
    s.touch(NOTE, viewWith(`${SAMPLE_VAULT[NOTE]}\n@dna;DNA-3;c;d\n`));
    await vi.advanceTimersByTimeAsync(800);
    await s.flush();
    expect(warns(th)).toHaveLength(1);
    expect(th.vault.files()[`${LOCAL}/DNA.json`]).toBe(CONFLICTED);
  });

  it('alias conflicts: once per type, id and alias set; a new alias is reported again', async () => {
    const th = setup({
      ...SAMPLE_VAULT,
      [NOTE]: '# clone\n\n@dna;DNA-1;pUC;x\n',
      [NOTE2]: '# digest\n\n@dna;DNA-1;pUC19;y\n',
      [NOTE3]: '# ligate\n\n@dna;DNA-1;pBR;z\n',
    });
    const s = sync();
    for (let round = 0; round < 2; round++) {
      for (const p of [NOTE, NOTE2]) {
        s.touchPath(p);
        await vi.advanceTimersByTimeAsync(800);
        await s.flush();
      }
    }
    expect(warns(th)).toHaveLength(1);
    s.touchPath(NOTE3);
    await vi.advanceTimersByTimeAsync(800);
    await s.flush();
    expect(warns(th)).toHaveLength(2);
    const [head, tail] = coreT(ALIAS_KEY, 'DNA-1', '\u0000').split('\u0000');
    for (const w of warns(th)) {
      expect(w.message.startsWith(head)).toBe(true);
      expect(w.message.endsWith(tail)).toBe(true);
    }
    expect(warns(th)[1].message).toContain('pBR (003_ligate.labnote.md)');
  });

  it('only the touched registry files are re-read', async () => {
    setup();
    const spy = vi.spyOn(samples, 'registryChanged');
    const s = sync();
    s.touch(NOTE, viewWith('# clone\n\n@dna;DNA-2;a;b\n'));
    await vi.advanceTimersByTimeAsync(800);
    await s.flush();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith([`${LOCAL}/DNA.json`, `${GLOBAL}/DNA.json`]);
  });

  it('touch with no env bound writes nothing', async () => {
    const th = setup();
    setSampleSyncEnv(() => undefined);
    const s = sync();
    s.touch(NOTE, viewWith('# clone\n\n@dna;DNA-2;a;b\n'));
    await vi.advanceTimersByTimeAsync(800);
    await s.flush();
    expect(registryWrites(th)).toHaveLength(0);
  });

  it('dispose cancels pending syncs', async () => {
    const th = setup();
    const s = sync();
    s.touch(NOTE, viewWith('# clone\n\n@dna;DNA-2;a;b\n'));
    s.dispose();
    await vi.advanceTimersByTimeAsync(800);
    expect(registryWrites(th)).toHaveLength(0);
  });
});
