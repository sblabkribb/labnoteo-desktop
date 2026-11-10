// @vitest-environment jsdom
import {
  CHECK_EVERY_MS,
  DOWNLOAD_RETRY_MS,
  FOCUS_RECHECK_AFTER_MS,
  PROGRESS_EMIT_MS,
  checkForUpdatesNow,
  installUpdate,
  resetUpdateStoreForTest,
  retryUpdate,
  startUpdateChecks,
  subscribeUpdate,
  updateState,
  type DownloadEvent,
  type PendingUpdate,
  type UpdateState,
} from '../updateStore';

vi.mock('@tauri-apps/plugin-updater', () => ({ check: vi.fn(async () => null) }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: vi.fn(async () => {}) }));

const MIN = 60_000;

type FakeUpdate = PendingUpdate & {
  download: ReturnType<typeof vi.fn>;
  install: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

function upd(version: string): FakeUpdate {
  return {
    version,
    download: vi.fn(async () => {}),
    install: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
}

/** 내려받기를 손으로 진행하는 가짜. emit 으로 이벤트를 보내고 finish/fail 로 끝낸다. */
function manualUpdate(version: string) {
  let onEvent: ((e: DownloadEvent) => void) | undefined;
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const u = upd(version);
  u.download.mockImplementation((cb?: (e: DownloadEvent) => void) => {
    onEvent = cb;
    return new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
  });
  return {
    u,
    emit: (e: DownloadEvent) => onEvent?.(e),
    finish: () => resolve(),
    fail: (e: unknown = new Error('bad signature')) => reject(e),
  };
}

/** 마이크로태스크(약속)를 비운다. 가짜 타이머에서도 동작한다. */
async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

function focusWindow() {
  window.dispatchEvent(new Event('focus'));
}

let stop: (() => void) | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  resetUpdateStoreForTest();
});

afterEach(() => {
  stop?.();
  stop = undefined;
  resetUpdateStoreForTest();
  vi.useRealTimers();
});

function start(check: () => Promise<PendingUpdate | null>) {
  const fn = vi.fn(check);
  stop = startUpdateChecks({ check: fn, now: () => Date.now() });
  return fn;
}

describe('업데이트 확인 주기', () => {
  it('시작할 때 한 번, 그 뒤 6시간마다 확인한다', async () => {
    const check = start(async () => null);
    await flush();
    expect(check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS);
    expect(check).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS);
    expect(check).toHaveBeenCalledTimes(3);
  });

  it('창으로 돌아왔을 때 마지막 확인이 1시간 넘게 지났을 때만 다시 확인한다', async () => {
    expect(FOCUS_RECHECK_AFTER_MS).toBe(60 * MIN);
    const check = start(async () => null);
    await flush();
    await vi.advanceTimersByTimeAsync(30 * MIN);
    focusWindow();
    await flush();
    expect(check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(31 * MIN);
    focusWindow();
    await flush();
    expect(check).toHaveBeenCalledTimes(2);
  });

  it('창이 다시 보이게 될 때(visibilitychange)도 같은 규칙으로 확인한다', async () => {
    const check = start(async () => null);
    await flush();
    await vi.advanceTimersByTimeAsync(61 * MIN);
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(check).toHaveBeenCalledTimes(2);
  });

  it('멈추면 주기 확인도, 창 이벤트 확인도 하지 않는다', async () => {
    const check = start(async () => null);
    await flush();
    stop!();
    stop = undefined;
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS * 2);
    focusWindow();
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(check).toHaveBeenCalledTimes(1);
  });
});

describe('업데이트 확인 결과', () => {
  it('동시에 두 번 직접 확인해도 실제 확인은 한 번이다', async () => {
    let resolve!: (u: PendingUpdate | null) => void;
    const check = start(() => new Promise((r) => (resolve = r)));
    // 시작 확인이 아직 끝나지 않았다 — 그 위에 직접 확인 두 번.
    const a = checkForUpdatesNow();
    const b = checkForUpdatesNow();
    resolve(null);
    const [sa, sb] = await Promise.all([a, b]);
    expect(check).toHaveBeenCalledTimes(1);
    expect(sa).toEqual({ kind: 'upToDate', manual: true });
    expect(sb).toEqual(sa);
  });

  it('새 버전이 없으면 upToDate, 직접 확인이었는지 기억한다', async () => {
    start(async () => null);
    await flush();
    expect(updateState()).toEqual({ kind: 'upToDate', manual: false });
    expect(await checkForUpdatesNow()).toEqual({ kind: 'upToDate', manual: true });
  });

  it('확인이 실패하면 failed 이고 manual 표시는 그대로다', async () => {
    start(async () => {
      throw new Error('offline');
    });
    await flush();
    expect(updateState()).toEqual({ kind: 'failed', manual: false });
    expect(await checkForUpdatesNow()).toEqual({ kind: 'failed', manual: true });
  });

  it('확인하는 동안은 checking 을 알린다', async () => {
    let resolve!: (u: PendingUpdate | null) => void;
    start(() => new Promise((r) => (resolve = r)));
    expect(updateState()).toEqual({ kind: 'checking', manual: false });
    resolve(null);
    await flush();
    expect(updateState().kind).toBe('upToDate');
  });

  it('구독자는 바뀐 상태를 받고, 구독을 끊으면 더 받지 않는다', async () => {
    const seen: UpdateState['kind'][] = [];
    const off = subscribeUpdate((s) => seen.push(s.kind));
    start(async () => upd('0.2.0'));
    await flush();
    expect(seen).toEqual(['checking', 'downloading', 'ready']);
    off();
    await checkForUpdatesNow();
    expect(seen).toEqual(['checking', 'downloading', 'ready']);
  });
});


describe('조용히 내려받기', () => {
  it('새 버전을 찾으면 checking → downloading → ready, 받은 양은 chunkLength 의 합이다', async () => {
    const m = manualUpdate('0.2.0');
    const seen: UpdateState['kind'][] = [];
    subscribeUpdate((s) => seen.push(s.kind));
    start(async () => m.u);
    await flush();
    expect(updateState()).toEqual({ kind: 'downloading', version: '0.2.0', received: 0 });
    m.emit({ event: 'Started', data: { contentLength: 100 } });
    m.emit({ event: 'Progress', data: { chunkLength: 30 } });
    m.emit({ event: 'Progress', data: { chunkLength: 70 } });
    m.emit({ event: 'Finished' });
    expect(updateState()).toEqual({ kind: 'downloading', version: '0.2.0', received: 100, total: 100 });
    m.finish();
    await flush();
    expect(updateState()).toEqual({ kind: 'ready', version: '0.2.0' });
    expect(seen[0]).toBe('checking');
    expect(seen[1]).toBe('downloading');
    expect(seen[seen.length - 1]).toBe('ready');
  });

  it('contentLength 가 없으면 total 은 없다', async () => {
    const m = manualUpdate('0.2.0');
    start(async () => m.u);
    await flush();
    m.emit({ event: 'Started', data: {} });
    m.emit({ event: 'Progress', data: { chunkLength: 5 } });
    m.emit({ event: 'Finished' });
    const s = updateState();
    expect(s).toEqual({ kind: 'downloading', version: '0.2.0', received: 5 });
    expect('total' in s).toBe(false);
  });

  it('진행 알림은 250ms 에 한 번으로 줄이고, Finished 에서 한 번 더 알린다', async () => {
    expect(PROGRESS_EMIT_MS).toBe(250);
    const m = manualUpdate('0.2.0');
    start(async () => m.u);
    await flush();
    const seen: UpdateState[] = [];
    subscribeUpdate((s) => seen.push(s));
    m.emit({ event: 'Started', data: { contentLength: 1000 } });
    for (let i = 0; i < 20; i++) m.emit({ event: 'Progress', data: { chunkLength: 10 } });
    expect(seen).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(PROGRESS_EMIT_MS);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: 'downloading', received: 200, total: 1000 });
    for (let i = 0; i < 5; i++) m.emit({ event: 'Progress', data: { chunkLength: 10 } });
    m.emit({ event: 'Finished' });
    expect(seen).toHaveLength(2);
    expect(seen[1]).toMatchObject({ kind: 'downloading', received: 250 });
    await vi.advanceTimersByTimeAsync(PROGRESS_EMIT_MS * 4);
    expect(seen).toHaveLength(2); // Finished 가 남은 알림을 지웠다
  });

  it('내려받기가 실패하면 1분, 10분 뒤 다시 받고, 그래도 안 되면 downloadFailed{attempts:3}', async () => {
    expect(DOWNLOAD_RETRY_MS).toEqual([60_000, 600_000]);
    const u = upd('0.2.0');
    u.download.mockRejectedValue(new Error('offline'));
    start(async () => u);
    await flush();
    expect(u.download).toHaveBeenCalledTimes(1);
    expect(updateState()).toEqual({ kind: 'downloadFailed', version: '0.2.0', attempts: 1 });
    await vi.advanceTimersByTimeAsync(DOWNLOAD_RETRY_MS[0] - 1);
    expect(u.download).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(u.download).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(DOWNLOAD_RETRY_MS[1]);
    expect(u.download).toHaveBeenCalledTimes(3);
    expect(updateState()).toEqual({ kind: 'downloadFailed', version: '0.2.0', attempts: 3 });
    await vi.advanceTimersByTimeAsync(DOWNLOAD_RETRY_MS[1] * 3);
    expect(u.download).toHaveBeenCalledTimes(3);
    u.download.mockResolvedValue(undefined);
    retryUpdate();
    await flush();
    expect(u.download).toHaveBeenCalledTimes(4);
    expect(updateState()).toEqual({ kind: 'ready', version: '0.2.0' });
  });

  it('Finished 뒤에 실패해도(잘못된 서명) 실패한 시도로 센다', async () => {
    const m = manualUpdate('0.2.0');
    start(async () => m.u);
    await flush();
    m.emit({ event: 'Started', data: { contentLength: 10 } });
    m.emit({ event: 'Progress', data: { chunkLength: 10 } });
    m.emit({ event: 'Finished' });
    m.fail(new Error('signature'));
    await flush();
    expect(updateState()).toEqual({ kind: 'downloadFailed', version: '0.2.0', attempts: 1 });
  });

  it('startUpdateChecks 를 멈추면 기다리던 재시도도 하지 않는다', async () => {
    const u = upd('0.2.0');
    u.download.mockRejectedValue(new Error('offline'));
    start(async () => u);
    await flush();
    expect(u.download).toHaveBeenCalledTimes(1);
    stop!();
    stop = undefined;
    await vi.advanceTimersByTimeAsync(DOWNLOAD_RETRY_MS[0] + DOWNLOAD_RETRY_MS[1]);
    expect(u.download).toHaveBeenCalledTimes(1);
  });
});

describe('다시 확인할 때', () => {
  it('downloading/ready/installing 중의 주기 확인은 상태를 바꾸지 않는다', async () => {
    const m = manualUpdate('0.2.0');
    const again = upd('0.2.0');
    let calls = 0;
    const check = start(async () => (calls++ === 0 ? m.u : again));
    await flush();
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS);
    expect(check).toHaveBeenCalledTimes(2);
    expect(again.close).toHaveBeenCalledTimes(1);
    expect(updateState()).toMatchObject({ kind: 'downloading', version: '0.2.0' });
    m.finish();
    await flush();
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS);
    expect(updateState()).toEqual({ kind: 'ready', version: '0.2.0' });
    let release!: () => void;
    m.u.install.mockImplementation(() => new Promise<void>((r) => (release = r)));
    const p = installUpdate(async () => true);
    await flush();
    expect(updateState()).toEqual({ kind: 'installing', version: '0.2.0' });
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS);
    expect(updateState()).toEqual({ kind: 'installing', version: '0.2.0' });
    release();
    await p;
  });

  it('같은 버전을 다시 찾으면 새 객체를 바로 닫는다', async () => {
    const first = upd('0.2.0');
    const second = upd('0.2.0');
    let calls = 0;
    start(async () => (calls++ === 0 ? first : second));
    await flush();
    expect(updateState()).toEqual({ kind: 'ready', version: '0.2.0' });
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS);
    expect(second.close).toHaveBeenCalledTimes(1);
    expect(second.download).not.toHaveBeenCalled();
    expect(first.close).not.toHaveBeenCalled();
    expect(updateState()).toEqual({ kind: 'ready', version: '0.2.0' });
  });

  it('ready 인데 더 새 버전이 나오면 옛 것을 닫고 새 것을 받는다', async () => {
    const first = upd('0.2.0');
    const second = upd('0.3.0');
    let calls = 0;
    start(async () => (calls++ === 0 ? first : second));
    await flush();
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS);
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(second.download).toHaveBeenCalledTimes(1);
    expect(updateState()).toEqual({ kind: 'ready', version: '0.3.0' });
  });

  it('주기 확인이 실패해도 ready 는 그대로다', async () => {
    let fail = false;
    start(async () => {
      if (fail) throw new Error('offline');
      return upd('0.2.0');
    });
    await flush();
    fail = true;
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS);
    expect(updateState()).toEqual({ kind: 'ready', version: '0.2.0' });
  });
});

describe('직접 확인 (checkForUpdatesNow)', () => {
  it('downloading/ready/installing 중에는 다시 확인하지 않는다', async () => {
    const m = manualUpdate('0.2.0');
    const check = start(async () => m.u);
    await flush();
    expect(await checkForUpdatesNow()).toMatchObject({ kind: 'downloading' });
    m.finish();
    await flush();
    expect(await checkForUpdatesNow()).toEqual({ kind: 'ready', version: '0.2.0' });
    let release!: () => void;
    m.u.install.mockImplementation(() => new Promise<void>((r) => (release = r)));
    const p = installUpdate(async () => true);
    await flush();
    expect(await checkForUpdatesNow()).toEqual({ kind: 'installing', version: '0.2.0' });
    expect(check).toHaveBeenCalledTimes(1);
    release();
    await p;
  });

  it('downloadFailed 중이면 확인 없이 다시 받는다', async () => {
    const u = upd('0.2.0');
    u.download.mockRejectedValueOnce(new Error('offline'));
    const check = start(async () => u);
    await flush();
    expect(updateState().kind).toBe('downloadFailed');
    const s = await checkForUpdatesNow();
    expect(s).toMatchObject({ kind: 'downloading', version: '0.2.0' });
    await flush();
    expect(check).toHaveBeenCalledTimes(1);
    expect(u.download).toHaveBeenCalledTimes(2);
    expect(updateState()).toEqual({ kind: 'ready', version: '0.2.0' });
    // 손으로 다시 받았으니 기다리던 자동 재시도는 없다
    await vi.advanceTimersByTimeAsync(DOWNLOAD_RETRY_MS[0]);
    expect(u.download).toHaveBeenCalledTimes(2);
  });

  it('installFailed 중이면 확인 없이 ready 로 돌아간다', async () => {
    const u = upd('0.2.0');
    u.install.mockRejectedValue(new Error('InvalidUpdaterFormat'));
    const check = start(async () => u);
    await flush();
    await installUpdate(async () => true);
    expect(updateState()).toEqual({ kind: 'installFailed', version: '0.2.0' });
    expect(await checkForUpdatesNow()).toEqual({ kind: 'ready', version: '0.2.0' });
    expect(check).toHaveBeenCalledTimes(1);
  });
});

describe('설치 (installUpdate)', () => {
  async function readyWith(u: FakeUpdate, restart = vi.fn(async () => {})) {
    stop = startUpdateChecks({ check: async () => u, now: () => Date.now(), restart });
    await flush();
    expect(updateState()).toEqual({ kind: 'ready', version: u.version });
    return restart;
  }

  it('저장이 false 면 ready 로 돌아가고 설치하지 않는다', async () => {
    const u = upd('0.2.0');
    const restart = await readyWith(u);
    await installUpdate(async () => false);
    expect(updateState()).toEqual({ kind: 'ready', version: '0.2.0' });
    expect(u.install).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
  });

  it('저장이 throw 하면 ready 로 돌아가고 설치하지 않는다', async () => {
    const u = upd('0.2.0');
    const restart = await readyWith(u);
    await installUpdate(async () => {
      throw new Error('disk full');
    });
    expect(updateState()).toEqual({ kind: 'ready', version: '0.2.0' });
    expect(u.install).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
  });

  it('저장한 뒤 install() 하고 다시 시작한다', async () => {
    const order: string[] = [];
    const u = upd('0.2.0');
    u.install.mockImplementation(async () => void order.push('install'));
    const restart = await readyWith(
      u,
      vi.fn(async () => void order.push('restart')),
    );
    await installUpdate(async () => {
      order.push('flush');
      expect(updateState()).toEqual({ kind: 'installing', version: '0.2.0' });
      return true;
    });
    expect(order).toEqual(['flush', 'install', 'restart']);
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('install() 이 throw 하면 installFailed, 다시 누르면 다시 설치한다', async () => {
    const u = upd('0.2.0');
    u.install.mockRejectedValueOnce(new Error('InvalidUpdaterFormat'));
    const restart = await readyWith(u);
    await installUpdate(async () => true);
    expect(updateState()).toEqual({ kind: 'installFailed', version: '0.2.0' });
    expect(restart).not.toHaveBeenCalled();
    await installUpdate(async () => true);
    expect(u.install).toHaveBeenCalledTimes(2);
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('ready 가 아니면 아무것도 하지 않는다', async () => {
    const flushAll = vi.fn(async () => true);
    await installUpdate(flushAll);
    expect(flushAll).not.toHaveBeenCalled();
    expect(updateState()).toEqual({ kind: 'idle' });
  });
});
