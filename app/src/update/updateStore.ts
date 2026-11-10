import { check as pluginCheck } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

/**
 * 새 버전 확인과 조용한 내려받기 (B-R8, spec §3.2). 시작할 때, 그 뒤 6시간마다, 마지막 확인이 1시간 넘게
 * 지난 뒤 창으로 돌아왔을 때, 그리고 사용자가 직접 확인할 때 확인한다. 새 버전을 찾으면 바로 뒤에서 내려받고,
 * 다 받으면 `ready` 가 된다. 설치는 사용자가 왼쪽 아래 버튼을 누를 때만 한다 (installUpdate).
 */

/** plugin-updater 의 내려받기 이벤트. */
export type DownloadEvent =
  | { event: 'Started'; data: { contentLength?: number } }
  | { event: 'Progress'; data: { chunkLength: number } }
  | { event: 'Finished' };

/** plugin-updater 의 `Update` 중 쓰는 부분만. 상태에는 넣지 않고 이 모듈만 쥔다. */
export interface PendingUpdate {
  version: string;
  download(onEvent?: (e: DownloadEvent) => void): Promise<void>;
  install(): Promise<void>;
  close?(): Promise<void>;
}

export type UpdateState =
  | { kind: 'idle' }
  | { kind: 'checking'; manual: boolean }
  | { kind: 'upToDate'; manual: boolean }
  | { kind: 'failed'; manual: boolean }
  | { kind: 'downloading'; version: string; received: number; total?: number }
  | { kind: 'ready'; version: string }
  | { kind: 'downloadFailed'; version: string; attempts: number }
  | { kind: 'installing'; version: string }
  | { kind: 'installFailed'; version: string };

export interface UpdateDeps {
  check: () => Promise<PendingUpdate | null>;
  now: () => number;
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
  /** 설치 뒤 다시 켠다. Windows 에서는 설치 프로그램이 앱을 끝내므로 닿지 않는다. */
  restart: () => Promise<void>;
}

export const CHECK_EVERY_MS = 6 * 3600_000;
export const FOCUS_RECHECK_AFTER_MS = 3600_000;
/** 내려받기가 실패한 뒤 다시 받을 때까지 기다리는 시간. 처음 시도까지 모두 3번. */
export const DOWNLOAD_RETRY_MS = [60_000, 600_000];
/** 진행 알림은 이 간격에 한 번만 (Finished 는 바로). */
export const PROGRESS_EMIT_MS = 250;

/** 플러그인의 `Update` 를 감싼다. close 를 그대로 넘겨 Rust 쪽 자원을 풀 수 있게 한다. */
async function checkWithPlugin(): Promise<PendingUpdate | null> {
  const u = await pluginCheck();
  if (!u) return null;
  return {
    version: u.version,
    download: (onEvent) => u.download(onEvent),
    install: () => u.install(),
    close: async () => {
      await u.close?.();
    },
  };
}

function defaultDeps(): UpdateDeps {
  return {
    check: checkWithPlugin,
    now: () => Date.now(),
    // 가짜 타이머가 바꾼 전역을 부를 때 가져오도록 감싼다.
    setInterval: ((fn: () => void, ms?: number) => setInterval(fn, ms)) as typeof setInterval,
    clearInterval: ((id: ReturnType<typeof setInterval>) => clearInterval(id)) as typeof clearInterval,
    setTimeout: ((fn: () => void, ms?: number) => setTimeout(fn, ms)) as typeof setTimeout,
    clearTimeout: ((id: ReturnType<typeof setTimeout>) => clearTimeout(id)) as typeof clearTimeout,
    restart: () => relaunch(),
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
/** 받고 있거나 받은 새 버전. React 가 플러그인 자원을 쥐지 않게 상태 밖에 둔다. */
let pending: PendingUpdate | null = null;
/** 지금 버전으로 이어서 실패한 내려받기 횟수. */
let attempts = 0;
/** 내려받기마다 늘린다. 옛 내려받기의 늦은 이벤트를 버린다. */
let downloadGen = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let progressTimer: ReturnType<typeof setTimeout> | null = null;
let lastProgressEmitAt = 0;
/** startUpdateChecks 가 멈추면 새 재시도를 잡지 않는다. */
let running = false;

function setState(next: UpdateState) {
  state = next;
  for (const fn of [...listeners]) fn(next);
}

/** 내려받기 진행을 알림 없이 적어 둔다. emitProgress 가 알린다. */
function setQuiet(next: UpdateState) {
  state = next;
}

function emitProgress() {
  if (progressTimer !== null) {
    deps.clearTimeout(progressTimer);
    progressTimer = null;
  }
  lastProgressEmitAt = deps.now();
  setState(state);
}

function clearRetry() {
  if (retryTimer !== null) {
    deps.clearTimeout(retryTimer);
    retryTimer = null;
  }
}

function closeQuietly(u: PendingUpdate | null) {
  if (!u?.close) return;
  void u.close().catch(() => {});
}

function isBusy(s: UpdateState): boolean {
  return s.kind === 'downloading' || s.kind === 'ready' || s.kind === 'installing';
}

function hasPending(s: UpdateState): boolean {
  return isBusy(s) || s.kind === 'downloadFailed' || s.kind === 'installFailed';
}

function startDownload(u: PendingUpdate) {
  clearRetry();
  pending = u;
  const gen = ++downloadGen;
  const version = u.version;
  let received = 0;
  let total: number | undefined;
  const snapshot = (): UpdateState =>
    total === undefined ? { kind: 'downloading', version, received } : { kind: 'downloading', version, received, total };
  lastProgressEmitAt = deps.now();
  setState(snapshot());
  const onEvent = (e: DownloadEvent) => {
    if (gen !== downloadGen) return;
    if (e.event === 'Started') {
      total = typeof e.data.contentLength === 'number' ? e.data.contentLength : undefined;
    } else if (e.event === 'Progress') {
      received += e.data.chunkLength;
    }
    setQuiet(snapshot());
    if (e.event === 'Finished') {
      emitProgress();
      return;
    }
    const wait = PROGRESS_EMIT_MS - (deps.now() - lastProgressEmitAt);
    if (wait <= 0) emitProgress();
    else if (progressTimer === null) {
      progressTimer = deps.setTimeout(() => {
        progressTimer = null;
        if (gen === downloadGen && state.kind === 'downloading') emitProgress();
      }, wait);
    }
  };
  void (async () => {
    try {
      await u.download(onEvent);
      if (gen !== downloadGen) return;
      attempts = 0;
      if (progressTimer !== null) {
        deps.clearTimeout(progressTimer);
        progressTimer = null;
      }
      setState({ kind: 'ready', version });
    } catch {
      // 잘못된 서명도 여기로 온다 (plugin 2.14.1 은 내려받기에서 검사한다). 오류는 조용히 둔다.
      if (gen !== downloadGen) return;
      if (progressTimer !== null) {
        deps.clearTimeout(progressTimer);
        progressTimer = null;
      }
      attempts += 1;
      setState({ kind: 'downloadFailed', version, attempts });
      const wait = DOWNLOAD_RETRY_MS[attempts - 1];
      if (running && wait !== undefined) {
        retryTimer = deps.setTimeout(() => {
          retryTimer = null;
          if (state.kind === 'downloadFailed' && pending === u) startDownload(u);
        }, wait);
      }
    }
  })();
}

/** 확인이 새 버전을 찾았을 때. 지금 상태에 맞춰 받거나, 새 객체를 닫는다. */
function onFound(u: PendingUpdate) {
  const s = state;
  if (s.kind === 'downloading' || s.kind === 'installing') {
    closeQuietly(u);
    return;
  }
  if (s.kind === 'ready' || s.kind === 'installFailed') {
    if (u.version === s.version) {
      closeQuietly(u);
      return;
    }
  }
  if (pending && pending !== u) closeQuietly(pending);
  attempts = 0;
  startDownload(u);
}

function runCheck(manual: boolean): Promise<UpdateState> {
  if (inflight) {
    if (manual) inflightManual = true;
    return inflight;
  }
  inflightManual = manual;
  lastCheckAt = deps.now();
  // 받는 중이거나 받은 새 버전이 있으면 다시 확인하는 동안에도 그대로 둔다 — 깜빡이지 않게.
  if (!hasPending(state)) setState({ kind: 'checking', manual });
  const check = deps.check;
  const p = (async (): Promise<UpdateState> => {
    let found: PendingUpdate | null = null;
    let failed = false;
    try {
      found = await check();
    } catch {
      failed = true;
    }
    const m = inflightManual;
    inflight = null;
    inflightManual = false;
    if (found) onFound(found);
    else if (!hasPending(state)) setState(failed ? { kind: 'failed', manual: m } : { kind: 'upToDate', manual: m });
    return state;
  })();
  inflight = p;
  return p;
}

/**
 * 지금 확인하고, 6시간마다, 그리고 창으로 돌아왔을 때(포커스 또는 다시 보이게 됨) 마지막 확인이
 * 1시간 넘게 지났으면 다시 확인한다. 돌려받은 함수로 멈춘다 (기다리던 재시도도 멈춘다).
 */
export function startUpdateChecks(over: Partial<UpdateDeps> = {}): () => void {
  deps = { ...defaultDeps(), ...over };
  const d = deps;
  running = true;
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
    running = false;
    d.clearInterval(timer);
    clearRetry();
    if (hasWindow) window.removeEventListener('focus', onBack);
    if (hasDocument) document.removeEventListener('visibilitychange', onBack);
  };
}

/**
 * 사용자가 직접 확인한다. 받는 중·받음·설치 중이면 다시 확인하지 않고 지금 상태를 돌려준다.
 * 내려받기가 실패해 있으면 다시 받고, 설치가 실패해 있으면 `ready` 로 돌아간다.
 */
export function checkForUpdatesNow(): Promise<UpdateState> {
  if (isBusy(state)) return Promise.resolve(state);
  if (state.kind === 'downloadFailed') {
    retryUpdate();
    return Promise.resolve(state);
  }
  if (state.kind === 'installFailed') {
    setState({ kind: 'ready', version: state.version });
    return Promise.resolve(state);
  }
  return runCheck(true);
}

/** `downloadFailed` 에서 다시 받는다 (버튼을 누르거나 직접 확인할 때). */
export function retryUpdate(): void {
  if (state.kind !== 'downloadFailed' || !pending) return;
  attempts = 0;
  startDownload(pending);
}

/**
 * 받은 새 버전을 설치하고 다시 켠다. 먼저 열린 노트를 모두 저장한다(flushAll): 하나라도 false 이거나
 * throw 하면 설치하지 않고 `ready` 로 돌아간다. install()/restart() 가 throw 하면 `installFailed`.
 */
export async function installUpdate(flushAll: () => Promise<boolean>): Promise<void> {
  if ((state.kind !== 'ready' && state.kind !== 'installFailed') || !pending) return;
  const u = pending;
  const version = state.version;
  setState({ kind: 'installing', version });
  let saved = false;
  try {
    saved = (await flushAll()) === true;
  } catch {
    saved = false;
  }
  if (!saved) {
    setState({ kind: 'ready', version });
    return;
  }
  try {
    await u.install();
    await deps.restart();
  } catch {
    setState({ kind: 'installFailed', version });
  }
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
  clearRetry();
  if (progressTimer !== null) deps.clearTimeout(progressTimer);
  progressTimer = null;
  deps = defaultDeps();
  state = { kind: 'idle' };
  listeners.clear();
  lastCheckAt = null;
  inflight = null;
  inflightManual = false;
  pending = null;
  attempts = 0;
  downloadGen++;
  lastProgressEmitAt = 0;
  running = false;
}

/** 테스트 전용: 상태를 바로 정한다. `pending` 을 주면 그 객체를 받은 새 버전으로 쥔다. */
export function setUpdateStateForTest(next: UpdateState, withPending?: PendingUpdate): void {
  if (withPending) pending = withPending;
  setState(next);
}
