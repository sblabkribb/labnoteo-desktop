import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLang } from '../../../i18n/lang';
import { fakeInvoke, netError } from '../../../integrations/__tests__/fakeNet';
import type { ListenFn } from '../../../integrations/netIpc';
import { coreT, overrideOr } from '../../i18n';
import {
  FAILED_DIR,
  POLL_MS,
  PROCESSED_DIR,
  ScanFolderWatcher,
  historyKey,
  isInsideFolder,
  outcomeOf,
  pruneHistory,
  selectReadyFiles,
  type FolderEntry,
} from '../../port/scanFolderWatcher';
import type { RunOptions, ScanInput, ScanResult } from '../../port/scanPipeline';
import { SCAN_FOLDER_CHANGED, type ScanFolderStatus } from '../scanIpc';

const DAY = 24 * 60 * 60 * 1000;

describe('selectReadyFiles', () => {
  const now = 1_000_000;
  const entry = (name: string, over: Partial<FolderEntry> = {}): FolderEntry => ({ name, size: 10, mtimeMs: now - 10_000, ...over });

  it('takes settled scan files new since the folder was set, on the second look', () => {
    const lastSizes = new Map<string, number>();
    const entries = [
      entry('a.jpg'),
      entry('old.jpg', { mtimeMs: now - 100_000 }),
      entry('notes.txt'),
      entry('.hidden.jpg'),
      entry('growing.pdf', { mtimeMs: now - 500 }),
      entry('empty.png', { size: 0 }),
    ];
    const opts = { since: now - 50_000, now, handled: () => false, lastSizes };
    expect(selectReadyFiles(entries, opts)).toEqual({ ready: [], waiting: 3 });
    expect(selectReadyFiles(entries, opts).ready.map((e) => e.name)).toEqual(['a.jpg']);
  });

  it('takes settled files at once on a manual run, and old ones when asked', () => {
    const entries = [entry('a.jpg'), entry('old.jpg', { mtimeMs: now - 100_000 })];
    const ready = selectReadyFiles(entries, {
      since: now - 50_000,
      now,
      handled: () => false,
      lastSizes: new Map(),
      manual: true,
      includeExisting: true,
    }).ready;
    expect(ready.map((e) => e.name)).toEqual(['a.jpg', 'old.jpg']);
  });

  it('passes over only what the folder already held, whatever the file times say (#247)', () => {
    const copied = entry('copied.jpg', { mtimeMs: now - 100_000 });
    const known = entry('was-here.jpg', { mtimeMs: now - 100_000 });
    const ready = selectReadyFiles([copied, known], {
      since: now - 50_000,
      now,
      baseline: new Set([historyKey(known)]),
      handled: () => false,
      lastSizes: new Map(),
      manual: true,
    }).ready;
    expect(ready.map((e) => e.name)).toEqual(['copied.jpg']);
  });

  it('without a baseline, takes a file the file system says appeared after the folder was set (#247)', () => {
    const copied = entry('copied.jpg', { mtimeMs: now - 100_000, birthtimeMs: now - 10_000 });
    const old = entry('old.jpg', { mtimeMs: now - 100_000, birthtimeMs: now - 100_000 });
    const ready = selectReadyFiles([copied, old], {
      since: now - 50_000,
      now,
      handled: () => false,
      lastSizes: new Map(),
      manual: true,
    }).ready;
    expect(ready.map((e) => e.name)).toEqual(['copied.jpg']);
  });

  it('forgets the size of files that left the folder', () => {
    const lastSizes = new Map([['gone.jpg', 5]]);
    selectReadyFiles([], { since: 0, now, handled: () => false, lastSizes });
    expect(lastSizes.size).toBe(0);
  });
});

describe('watcher helpers', () => {
  it('drops history older than 90 days', () => {
    const now = 100 * DAY;
    expect(pruneHistory({ old: now - 91 * DAY, recent: now - 89 * DAY }, now)).toEqual({ recent: now - 89 * DAY });
  });

  it('sends a file to the failed folder only when nothing came of it', () => {
    const r = (status: ScanResult['status']): ScanResult => ({ source: 'a', status });
    expect(outcomeOf([r('unmatched'), r('error')])).toBe('failed');
    expect(outcomeOf([r('unmatched'), r('filed')])).toBe('processed');
    expect(outcomeOf([r('blank')])).toBe('processed');
    expect(outcomeOf([])).toBe('processed');
  });

  it('a PDF with an unreadable page and a filed page counts as processed; all pages unreadable counts as failed', () => {
    // SMOKE-TEST SP7 step 8: an undecodable PDF page is an `error` result (not queued); the original is kept either way.
    const r = (status: ScanResult['status']): ScanResult => ({ source: 'scan.pdf', status });
    expect(outcomeOf([r('filed'), r('error'), r('filed')])).toBe('processed');
    expect(outcomeOf([r('error'), r('error')])).toBe('failed');
  });

  it('tells a folder inside the vault, whatever the slashes and case', () => {
    expect(isInsideFolder('C:\\Vault\\scans', 'c:/vault')).toBe(true);
    expect(isInsideFolder('C:/Vault', 'C:/Vault/')).toBe(true);
    expect(isInsideFolder('C:/Vault2/scans', 'C:/Vault')).toBe(false);
  });

  it('keeps the plugin folder names', () => {
    expect([PROCESSED_DIR, FAILED_DIR, POLL_MS]).toEqual(['labnote-processed', 'labnote-failed', 30_000]);
  });
});

// ── The watcher over a fake Rust scan folder ─────────────────────────

const NOW = 200 * DAY;
const DIR = 'D:\\scans';

interface FakeFile {
  size: number;
  mtimeMs: number;
  birthtimeMs?: number | null;
}

/** An in-memory scan folder behind the scan commands, with `scan_folder_prune_baseline` as B4 has it. */
function fakeRust(init: { status?: Partial<ScanFolderStatus>; files?: Record<string, FakeFile>; history?: Record<string, number> }) {
  const status: ScanFolderStatus = {
    path: DIR,
    mode: 'dedicated',
    exists: true,
    insideVault: false,
    since: NOW - 60_000,
    baseline: [],
    ...init.status,
  };
  const files: Record<string, FakeFile> = { ...init.files };
  let historyText: string | null = init.history ? JSON.stringify(init.history) : null;
  const moves: Array<[string, string]> = [];
  const unreadable = new Set<string>();
  let listFails = false;
  const f = fakeInvoke({
    scan_folder_status: () => ({ ...status, baseline: status.baseline && [...status.baseline] }),
    scan_folder_list: () => {
      if (listFails) throw { kind: 'io', message: 'raw-rust-text' };
      return Object.keys(files)
        .sort()
        .map((name) => ({ name, size: files[name].size, mtimeMs: files[name].mtimeMs, birthtimeMs: files[name].birthtimeMs ?? null }));
    },
    scan_folder_prune_baseline: (a) => {
      if (status.baseline === null) return null;
      const present = a.present as string[];
      status.baseline = status.baseline.filter((k) => present.includes(k));
      return [...status.baseline];
    },
    scan_folder_read: (a) => {
      const name = a.name as string;
      if (unreadable.has(name)) throw netError('io');
      return new TextEncoder().encode(name).buffer;
    },
    scan_folder_move: (a) => {
      const name = a.name as string;
      moves.push([name, a.outcome as string]);
      delete files[name];
      return `${a.outcome === 'processed' ? PROCESSED_DIR : FAILED_DIR}/${name}`;
    },
    integration_state_read: (a) => (a.name === 'scanFolderHistory' ? historyText : null),
    integration_state_write: (a) => {
      if (a.name === 'scanFolderHistory') historyText = a.content as string;
      return null;
    },
  });
  return {
    ...f,
    status,
    files,
    moves,
    unreadable,
    failList: () => void (listFails = true),
    history: (): Record<string, number> => (historyText === null ? {} : (JSON.parse(historyText) as Record<string, number>)),
  };
}

/** A file whose modification time is `ageMs` before NOW; its size is its name's length. */
const file = (name: string, ageMs: number, birthAgeMs?: number): FakeFile => ({
  size: name.length,
  mtimeMs: NOW - ageMs,
  birthtimeMs: birthAgeMs === undefined ? null : NOW - birthAgeMs,
});
const keyOf = (name: string, f: FakeFile) => historyKey({ name, size: f.size, mtimeMs: f.mtimeMs });

function makeWatcher(rust: ReturnType<typeof fakeRust>, statusOf: (name: string) => ScanResult['status'] = () => 'filed') {
  const run = vi.fn(async (inputs: ScanInput[], _opts: RunOptions, _manual: boolean) =>
    inputs.map((i): ScanResult => ({ source: i.name, input: i.name, status: statusOf(i.name) })),
  );
  const report = vi.fn((_results: ScanResult[], _manual: boolean) => undefined);
  const notices: string[] = [];
  const handlers = new Map<string, () => void>();
  const listen = vi.fn(async (event: string, cb: () => void) => {
    handlers.set(event, cb);
    return () => void handlers.delete(event);
  });
  const watcher = new ScanFolderWatcher({
    invoke: rust.invoke,
    listen: listen as unknown as ListenFn,
    run,
    report,
    notify: (m) => void notices.push(m),
    now: () => NOW,
  });
  const names = (call: number) => run.mock.calls[call][0].map((i) => i.name);
  return { watcher, run, report, notices, listen, handlers, names };
}

const callsOf = (rust: ReturnType<typeof fakeRust>, cmd: string) => rust.calls.filter(([c]) => c === cmd);

describe('ScanFolderWatcher.tick', () => {
  beforeEach(() => setLang('en'));
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('files already in the folder when it was chosen are neither processed nor moved until Process existing files too', async () => {
    const old = { size: 3, mtimeMs: 500 };
    const rust = fakeRust({
      status: { mode: 'dedicated', since: 1000, baseline: ['old.jpg|3|500'] },
      files: { 'old.jpg': old, 'new.jpg': { size: 7, mtimeMs: 2000 } },
    });
    const { watcher, run, names } = makeWatcher(rust);
    await watcher.tick({ manual: true });
    expect(run).toHaveBeenCalledTimes(1);
    expect(names(0)).toEqual(['new.jpg']);
    expect(rust.moves).toEqual([['new.jpg', 'processed']]);
    await watcher.tick({ manual: true, includeExisting: true });
    expect(names(run.mock.calls.length - 1)).toEqual(['old.jpg']);
    expect(rust.moves).toEqual([
      ['new.jpg', 'processed'],
      ['old.jpg', 'processed'],
    ]);
  });

  it('dedicated mode moves originals to processed or failed by outcome', async () => {
    const before = file('before.jpg', 120_000);
    const rust = fakeRust({
      status: { mode: 'dedicated', baseline: [keyOf('before.jpg', before)] },
      files: { 'before.jpg': before, 'a.jpg': file('a.jpg', 10_000), 'b.jpg': file('b.jpg', 10_000), 'c.jpg': file('c.jpg', 10_000) },
    });
    const { watcher, run, report, names } = makeWatcher(rust, (n) => (n === 'b.jpg' ? 'error' : n === 'c.jpg' ? 'unmatched' : 'filed'));
    await watcher.tick({ manual: true });
    expect(names(0)).toEqual(['a.jpg', 'b.jpg', 'c.jpg']);
    expect(run.mock.calls[0][1]).toEqual({ skipNoQr: false });
    expect(run.mock.calls[0][2]).toBe(true);
    expect(report.mock.calls.map((c) => c[1])).toEqual([true]);
    expect(rust.moves).toEqual([
      ['a.jpg', 'processed'],
      ['b.jpg', 'failed'],
      ['c.jpg', 'failed'],
    ]);
    expect(Object.keys(rust.files)).toEqual(['before.jpg']);
  });

  it('shared mode never moves and remembers 90 days of history', async () => {
    const photo = file('photo.jpg', 10_000);
    const rust = fakeRust({
      status: { mode: 'shared', baseline: [] },
      files: { 'photo.jpg': photo },
      history: { 'gone.jpg|3|1': NOW - 91 * DAY, 'kept.jpg|3|1': NOW - 89 * DAY },
    });
    const { watcher, run } = makeWatcher(rust, () => 'skipped');
    await watcher.tick({ manual: true });
    await watcher.tick({ manual: true });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][1]).toEqual({ skipNoQr: true });
    expect(callsOf(rust, 'scan_folder_move')).toEqual([]);
    expect(rust.history()).toEqual({ [keyOf('photo.jpg', photo)]: NOW, 'kept.jpg|3|1': NOW - 89 * DAY });
  });

  it.each(['shared', 'dedicated'] as const)('%s mode retries unreadable originals in a mixed batch', async (mode) => {
    const rust = fakeRust({
      status: { mode },
      files: { 'retry.jpg': file('retry.jpg', 10_000), 'good.jpg': file('good.jpg', 10_000) },
    });
    rust.unreadable.add('retry.jpg');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { watcher, run, names } = makeWatcher(rust);

    await watcher.tick({ manual: true });
    expect(names(0)).toEqual(['good.jpg']);
    expect(Object.keys(rust.history())).toEqual([expect.stringMatching(/^good\.jpg\|/)]);
    if (mode === 'dedicated') expect(rust.moves).toEqual([['good.jpg', 'processed']]);
    else expect(rust.moves).toEqual([]);

    rust.unreadable.clear();
    await watcher.tick({ manual: true });
    expect(run.mock.calls.flatMap((c) => c[0].map((i) => i.name))).toEqual(['good.jpg', 'retry.jpg']);
    await watcher.tick({ manual: true });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('reads files that were there before only when asked', async () => {
    const before = file('before.jpg', 60_000);
    const rust = fakeRust({ status: { mode: 'shared', baseline: [keyOf('before.jpg', before)] }, files: { 'before.jpg': before } });
    const { watcher, run, names } = makeWatcher(rust);
    expect(await watcher.tick({ manual: true })).toEqual([]);
    await watcher.tick({ manual: true, includeExisting: true });
    expect(run).toHaveBeenCalledTimes(1);
    expect(names(0)).toEqual(['before.jpg']);
  });

  it('reads a copied file whose modification time is old, and passes over what was there when the folder was set (#247)', async () => {
    const was = file('was-here.jpg', 120_000);
    const rust = fakeRust({
      status: { mode: 'shared', baseline: [keyOf('was-here.jpg', was)] },
      files: { 'was-here.jpg': was, 'copied.jpg': file('copied.jpg', 120_000) },
    });
    const { watcher, names } = makeWatcher(rust);
    await watcher.tick({ manual: true });
    expect(names(0)).toEqual(['copied.jpg']);
  });

  it('reads a file that left the folder and came back (#247)', async () => {
    const photo = file('photo.jpg', 120_000);
    const rust = fakeRust({ status: { mode: 'shared', baseline: [keyOf('photo.jpg', photo)] }, files: { 'photo.jpg': photo } });
    const { watcher, run, names } = makeWatcher(rust, () => 'skipped');
    expect(await watcher.tick({ manual: true })).toEqual([]);

    delete rust.files['photo.jpg'];
    expect(await watcher.tick({ manual: true })).toEqual([]);
    expect(rust.status.baseline).toEqual([]);

    rust.files['photo.jpg'] = photo;
    await watcher.tick({ manual: true });
    expect(run).toHaveBeenCalledTimes(1);
    expect(names(0)).toEqual(['photo.jpg']);
  });

  it('a removed baseline file is pruned through Rust on the next tick', async () => {
    const rust = fakeRust({ status: { mode: 'dedicated', baseline: ['old.jpg|3|500'] } });
    const { watcher } = makeWatcher(rust);
    await watcher.tick();
    expect(callsOf(rust, 'scan_folder_prune_baseline')).toEqual([['scan_folder_prune_baseline', { present: [] }]]);
    expect(rust.status.baseline).toEqual([]);
  });

  it('a folder without a baseline falls back to since', async () => {
    const rust = fakeRust({
      status: { mode: 'shared', since: NOW - 50_000, baseline: null },
      files: { 'copied.jpg': file('copied.jpg', 100_000, 10_000), 'old.jpg': file('old.jpg', 100_000, 100_000) },
    });
    const { watcher, names } = makeWatcher(rust);
    await watcher.tick({ manual: true });
    expect(names(0)).toEqual(['copied.jpg']);
  });

  it('a manual tick with only baseline files names the second button', async () => {
    const was = file('was-here.jpg', 60_000);
    const rust = fakeRust({ status: { mode: 'shared', baseline: [keyOf('was-here.jpg', was)] }, files: { 'was-here.jpg': was } });
    const { watcher, notices, run } = makeWatcher(rust);
    await watcher.tick({ manual: true });
    expect(run).not.toHaveBeenCalled();
    expect(notices).toEqual([
      `${coreT('No new files in the scan folder.')} ${coreT(
        '{0} file(s) that were already in the folder when it was set are skipped. Read them with "{1}".',
        '1',
        coreT('Process existing files too'),
      )}`,
    ]);
    expect(notices[0]).toContain('1 file(s) that were already in the folder');
    expect(notices[0]).toContain('Process existing files too');
  });

  it('says why a manual run found nothing in a folder without a baseline, and only that with includeExisting', async () => {
    const rust = fakeRust({ status: { mode: 'shared', baseline: null } });
    const { watcher, notices } = makeWatcher(rust);
    await watcher.tick({ manual: true });
    expect(notices[0]).toContain(coreT('Process existing files too'));
    expect(notices[0].startsWith(coreT('No new files in the scan folder.'))).toBe(true);
    await watcher.tick({ manual: true, includeExisting: true });
    expect(notices[1]).toBe(coreT('No new files in the scan folder.'));
  });

  it('does nothing without a folder', async () => {
    const rust = fakeRust({ status: { path: null } });
    const { watcher, run, notices } = makeWatcher(rust);
    expect(await watcher.tick()).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
    expect(notices).toEqual([]);
    expect(callsOf(rust, 'scan_folder_list')).toEqual([]);
  });

  it('without a folder a manual tick says where to set one, without naming Obsidian', async () => {
    for (const lang of ['en', 'ko'] as const) {
      setLang(lang);
      const rust = fakeRust({ status: { path: null } });
      const { watcher, notices } = makeWatcher(rust);
      expect(await watcher.tick({ manual: true })).toBeUndefined();
      expect(notices).toEqual([overrideOr('scan.setFolderFirst')]);
      expect(notices[0]).not.toMatch(/Obsidian|Labnote Assistant/);
    }
    setLang('en');
    expect(overrideOr('scan.setFolderFirst')).toBe('Set a scan folder first: Integration settings → Barcode & scans.');
    setLang('ko');
    expect(overrideOr('scan.setFolderFirst')).toBe('먼저 스캔 폴더를 고르세요: 연동 설정 → 바코드와 스캔.');
  });

  it('a folder that cannot be listed is reported by kind on a manual run, never with the raw Rust text', async () => {
    const rust = fakeRust({});
    rust.failList();
    const { watcher, notices, run } = makeWatcher(rust);
    expect(await watcher.tick()).toBeUndefined();
    expect(notices).toEqual([]);
    expect(await watcher.tick({ manual: true })).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
    expect(notices).toEqual([coreT('The scan folder {0} could not be read: {1}', DIR, 'io')]);
    expect(notices[0]).not.toContain('raw-rust-text');
  });

  it('a manual tick while another runs says so and runs nothing more', async () => {
    const rust = fakeRust({ files: { 'a.jpg': file('a.jpg', 10_000) } });
    const { watcher, run, notices } = makeWatcher(rust);
    let release!: () => void;
    run.mockImplementationOnce(
      (inputs) =>
        new Promise((resolve) => {
          release = () => resolve(inputs.map((i) => ({ source: i.name, input: i.name, status: 'filed' as const })));
        }),
    );
    const first = watcher.tick({ manual: true });
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(await watcher.tick({ manual: true })).toBeUndefined();
    expect(notices).toEqual([coreT('The scan folder is being processed already.')]);
    release();
    expect((await first)?.map((r) => r.source)).toEqual(['a.jpg']);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('a background tick waits for a second look at the same size before reading', async () => {
    const rust = fakeRust({ files: { 'a.jpg': file('a.jpg', 10_000) } });
    const { watcher, run, report } = makeWatcher(rust);
    expect(await watcher.tick()).toEqual([]);
    expect(run).not.toHaveBeenCalled();
    await watcher.tick();
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][2]).toBe(false);
    expect(report.mock.calls.map((c) => c[1])).toEqual([false]);
  });
});

describe('ScanFolderWatcher.start', () => {
  beforeEach(() => {
    setLang('en');
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('a folder-changed event schedules one tick after the 2 s settle', async () => {
    const rust = fakeRust({});
    const { watcher, listen, handlers } = makeWatcher(rust);
    watcher.start();
    await vi.advanceTimersByTimeAsync(1_000); // the first look after start
    expect(listen).toHaveBeenCalledWith(SCAN_FOLDER_CHANGED, expect.any(Function));
    const lists = () => callsOf(rust, 'scan_folder_list').length;
    expect(lists()).toBe(1);

    const changed = handlers.get(SCAN_FOLDER_CHANGED)!;
    changed();
    await vi.advanceTimersByTimeAsync(200);
    changed();
    await vi.advanceTimersByTimeAsync(200);
    changed();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(lists()).toBe(1); // still settling
    await vi.advanceTimersByTimeAsync(600);
    expect(lists()).toBe(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(lists()).toBe(2);
    watcher.stop();
  });

  it('polls every 30 s and stop() ends the polling and the listening', async () => {
    const rust = fakeRust({});
    const { watcher, handlers } = makeWatcher(rust);
    watcher.start();
    await vi.advanceTimersByTimeAsync(1_000);
    const lists = () => callsOf(rust, 'scan_folder_list').length;
    expect(lists()).toBe(1);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(lists()).toBe(2);
    watcher.stop();
    expect(handlers.size).toBe(0);
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(lists()).toBe(2);
  });

  it('without a folder start neither polls nor listens, and restart() picks up a folder chosen since', async () => {
    const rust = fakeRust({ status: { path: null } });
    const { watcher, listen } = makeWatcher(rust);
    watcher.start();
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    expect(listen).not.toHaveBeenCalled();
    expect(callsOf(rust, 'scan_folder_list')).toEqual([]);

    rust.status.path = DIR;
    watcher.restart();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(listen).toHaveBeenCalledTimes(1);
    expect(callsOf(rust, 'scan_folder_list')).toHaveLength(1);
    watcher.stop();
  });

  it('a stop() before start has read the status leaves nothing running', async () => {
    const rust = fakeRust({});
    const { watcher, listen } = makeWatcher(rust);
    watcher.start();
    watcher.stop();
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    expect(listen).not.toHaveBeenCalled();
    expect(callsOf(rust, 'scan_folder_list')).toEqual([]);
  });
});
