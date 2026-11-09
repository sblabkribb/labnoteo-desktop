// @vitest-environment jsdom
import type { PendingUpdate } from '../UpdateBanner';
import {
  CHECK_EVERY_MS,
  FOCUS_RECHECK_AFTER_MS,
  checkForUpdatesNow,
  dismissUpdate,
  resetUpdateStoreForTest,
  startUpdateChecks,
  subscribeUpdate,
  updateState,
  type UpdateState,
} from '../updateStore';

vi.mock('@tauri-apps/plugin-updater', () => ({ check: vi.fn(async () => null) }));

const MIN = 60_000;

function upd(version: string): PendingUpdate {
  return { version, download: vi.fn(async () => {}), install: vi.fn(async () => {}) };
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
    expect(seen).toEqual(['checking', 'available']);
    off();
    await checkForUpdatesNow();
    expect(seen).toEqual(['checking', 'available']);
  });
});

describe('나중에 (B-R10)', () => {
  it('나중에 누른 같은 버전은 주기 확인에서 다시 나오지 않는다', async () => {
    start(async () => upd('0.2.0'));
    await flush();
    expect(updateState()).toMatchObject({ kind: 'available', dismissed: false });
    dismissUpdate();
    expect(updateState()).toMatchObject({ kind: 'available', dismissed: true });
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS);
    expect(updateState()).toMatchObject({ kind: 'available', dismissed: true });
    await vi.advanceTimersByTimeAsync(61 * MIN);
    focusWindow();
    await flush();
    expect(updateState()).toMatchObject({ kind: 'available', dismissed: true });
  });

  it('더 새 버전이 나오면 다시 보인다', async () => {
    let version = '0.2.0';
    start(async () => upd(version));
    await flush();
    dismissUpdate();
    version = '0.3.0';
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS);
    const s = updateState();
    expect(s).toMatchObject({ kind: 'available', dismissed: false });
    expect(s.kind === 'available' && s.update.version).toBe('0.3.0');
  });

  it('직접 확인하면 나중에를 지우고 다시 보인다', async () => {
    start(async () => upd('0.2.0'));
    await flush();
    dismissUpdate();
    expect(await checkForUpdatesNow()).toMatchObject({ kind: 'available', dismissed: false });
  });

  it('주기 확인이 잠깐 실패해도 이미 보인 새 버전 알림은 사라지지 않는다', async () => {
    let fail = false;
    start(async () => {
      if (fail) throw new Error('offline');
      return upd('0.2.0');
    });
    await flush();
    fail = true;
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS);
    expect(updateState()).toMatchObject({ kind: 'available', dismissed: false });
  });
});
