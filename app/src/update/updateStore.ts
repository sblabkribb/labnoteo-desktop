import { check as pluginCheck } from '@tauri-apps/plugin-updater';
import type { PendingUpdate } from './UpdateBanner';

/**
 * 새 버전 확인 상태 (B-R8, B-R10). 시작할 때, 그 뒤 6시간마다, 마지막 확인이 1시간 넘게 지난 뒤
 * 창으로 돌아왔을 때, 그리고 사용자가 직접 확인할 때 확인한다. 확인만 한다 — 내려받기와 설치는
 * 사용자가 알림에서 누를 때만 한다 (B-R9).
 */
export type UpdateState =
  | { kind: 'idle' }
  | { kind: 'checking'; manual: boolean }
  | { kind: 'upToDate'; manual: boolean }
  | { kind: 'failed'; manual: boolean }
  | { kind: 'available'; update: PendingUpdate; dismissed: boolean };

export interface UpdateDeps {
  check: () => Promise<PendingUpdate | null>;
  now: () => number;
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
}

export const CHECK_EVERY_MS = 6 * 3600_000;
export const FOCUS_RECHECK_AFTER_MS = 3600_000;

function defaultDeps(): UpdateDeps {
  return {
    check: pluginCheck,
    now: () => Date.now(),
    // 가짜 타이머가 바꾼 전역을 부를 때 가져오도록 감싼다.
    setInterval: ((fn: () => void, ms?: number) => setInterval(fn, ms)) as typeof setInterval,
    clearInterval: ((id: ReturnType<typeof setInterval>) => clearInterval(id)) as typeof clearInterval,
  };
}

let deps: UpdateDeps = defaultDeps();
let state: UpdateState = { kind: 'idle' };
const listeners = new Set<(s: UpdateState) => void>();
/** 마지막 확인을 시작한 시각. 아직 없으면 null. */
let lastCheckAt: number | null = null;
/** 진행 중인 확인. 겹친 요청은 이 약속 하나를 같이 기다린다. */
let inflight: Promise<UpdateState> | null = null;
/** 진행 중인 확인에 직접 확인이 끼었는지. */
let inflightManual = false;
/** "나중에"를 누른 버전. 앱을 다시 켜거나 직접 확인하면 지워진다 (B-R10). */
let dismissedVersion: string | null = null;

function setState(next: UpdateState) {
  state = next;
  for (const fn of [...listeners]) fn(next);
}

function runCheck(manual: boolean): Promise<UpdateState> {
  if (manual) dismissedVersion = null;
  if (inflight) {
    if (manual) inflightManual = true;
    return inflight;
  }
  inflightManual = manual;
  lastCheckAt = deps.now();
  // 이미 보인 새 버전 알림은 다시 확인하는 동안에도 그대로 둔다 — 깜빡이지 않게.
  if (state.kind !== 'available') setState({ kind: 'checking', manual });
  const check = deps.check;
  const p = (async (): Promise<UpdateState> => {
    let next: UpdateState;
    try {
      const update = await check();
      const m = inflightManual;
      if (update) {
        next = { kind: 'available', update, dismissed: !m && update.version === dismissedVersion };
      } else {
        next = { kind: 'upToDate', manual: m };
      }
    } catch {
      const m = inflightManual;
      // 잠깐의 오프라인 때문에 이미 알린 새 버전을 감추지 않는다.
      next =
        state.kind === 'available'
          ? { ...state, dismissed: !m && state.update.version === dismissedVersion }
          : { kind: 'failed', manual: m };
    }
    inflight = null;
    inflightManual = false;
    setState(next);
    return next;
  })();
  inflight = p;
  return p;
}

/**
 * 지금 확인하고, 6시간마다, 그리고 창으로 돌아왔을 때(포커스 또는 다시 보이게 됨) 마지막 확인이
 * 1시간 넘게 지났으면 다시 확인한다. 돌려받은 함수로 멈춘다.
 */
export function startUpdateChecks(over: Partial<UpdateDeps> = {}): () => void {
  deps = { ...defaultDeps(), ...over };
  const d = deps;
  void runCheck(false);
  const timer = d.setInterval(() => void runCheck(false), CHECK_EVERY_MS);
  const onBack = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    if (lastCheckAt !== null && d.now() - lastCheckAt < FOCUS_RECHECK_AFTER_MS) return;
    void runCheck(false);
  };
  const hasWindow = typeof window !== 'undefined';
  const hasDocument = typeof document !== 'undefined';
  if (hasWindow) window.addEventListener('focus', onBack);
  if (hasDocument) document.addEventListener('visibilitychange', onBack);
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    d.clearInterval(timer);
    if (hasWindow) window.removeEventListener('focus', onBack);
    if (hasDocument) document.removeEventListener('visibilitychange', onBack);
  };
}

/** 사용자가 직접 확인한다. "나중에"를 지운다. */
export function checkForUpdatesNow(): Promise<UpdateState> {
  return runCheck(true);
}

/** "나중에": 이 버전 알림을 앱을 다시 켜거나 직접 확인할 때까지 감춘다 (B-R10). */
export function dismissUpdate(): void {
  if (state.kind !== 'available') return;
  dismissedVersion = state.update.version;
  setState({ ...state, dismissed: true });
}

export function subscribeUpdate(fn: (s: UpdateState) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function updateState(): UpdateState {
  return state;
}

/** 테스트 전용: 모듈 상태를 처음으로 되돌린다. */
export function resetUpdateStoreForTest(): void {
  deps = defaultDeps();
  state = { kind: 'idle' };
  listeners.clear();
  lastCheckAt = null;
  inflight = null;
  inflightManual = false;
  dismissedVersion = null;
}

/** 테스트 전용: 상태를 바로 정한다. */
export function setUpdateStateForTest(next: UpdateState): void {
  if (next.kind === 'available' && next.dismissed) dismissedVersion = next.update.version;
  setState(next);
}
