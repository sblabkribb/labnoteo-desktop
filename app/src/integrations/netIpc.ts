import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { listen as tauriListen } from '@tauri-apps/api/event';
import type { SecretStatus, Slot } from './secretsEvents';

/**
 * SP6 net 커맨드의 타입 있는 래퍼. 네트워크는 모두 Rust 가 한다: 웹뷰는 커맨드만 부르고, 주소와 키는
 * Rust 가 저장된 설정과 Windows 자격 증명 관리자에서 직접 읽는다. 키 값은 이 파일을 거쳐 Rust 로 갈 수는
 * 있어도(setSecret, 연결 시험) 돌아오지 않는다.
 *
 * 래퍼는 모두 `toNetError(e)` 로 거절한다. `NetError.message` 는 Rust 의 원래 글이라 사용자에게 보이지 않는다:
 * 보이는 글은 `kind` 에서 번역 키로 만든다.
 */

export type { KeySlot, SecretStatus, Slot } from './secretsEvents';

export type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

export type NetErrorKind =
  | 'notConfigured'
  | 'keyMissing'
  | 'invalidUrl'
  | 'forbiddenPath'
  | 'offline'
  | 'timeout'
  | 'tls'
  | 'redirect'
  | 'status'
  | 'notJson'
  | 'tooLarge'
  | 'cancelled'
  | 'keychain'
  | 'badInput'
  | 'remote'
  | 'noResult'
  | 'insecure'
  | 'io';

/** Rust `NetErrorKind` 의 직렬화 값 전부(`src-tauri/tests/ipc-net-errors.json`). 빠짐없는 대응 테스트에 쓴다. */
export const NET_ERROR_KINDS: readonly NetErrorKind[] = [
  'notConfigured',
  'keyMissing',
  'invalidUrl',
  'forbiddenPath',
  'offline',
  'timeout',
  'tls',
  'redirect',
  'status',
  'notJson',
  'tooLarge',
  'cancelled',
  'keychain',
  'badInput',
  'remote',
  'noResult',
  'insecure',
  'io',
];

/** Rust `NetError` `{kind, message, status?, body?, location?}`. `body` 와 `message` 는 Rust 가 이미 키를 가렸다. */
export class NetError extends Error {
  constructor(
    readonly kind: NetErrorKind,
    message: string,
    readonly status?: number,
    readonly body?: string,
    readonly location?: string,
  ) {
    super(message);
    this.name = 'NetError';
  }
}

function isKind(k: unknown): k is NetErrorKind {
  return typeof k === 'string' && (NET_ERROR_KINDS as readonly string[]).includes(k);
}

/** Rust 가 거절한 값을 `NetError` 로. `NetError` 는 그대로, 모양이 다르면 `badInput`. */
export function toNetError(e: unknown): NetError {
  if (e instanceof NetError) return e;
  if (e && typeof e === 'object' && !(e instanceof Error)) {
    const o = e as Record<string, unknown>;
    const message = typeof o.message === 'string' ? o.message : '';
    if (isKind(o.kind)) {
      return new NetError(
        o.kind,
        message,
        typeof o.status === 'number' ? o.status : undefined,
        typeof o.body === 'string' ? o.body : undefined,
        typeof o.location === 'string' ? o.location : undefined,
      );
    }
    return new NetError('badInput', message || String(o.kind ?? 'unknown error'));
  }
  return new NetError('badInput', String(e));
}

function cancelled(): NetError {
  return new NetError('cancelled', 'cancelled');
}

/** invoke 를 부르고, 거절은 `NetError` 로 바꾼다. */
async function call<T>(invoke: InvokeFn, cmd: string, args: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw toNetError(e);
  }
}

// ── 키(자격 증명 관리자) ───────────────────────────────────────────

export function secretStatus(invoke: InvokeFn = tauriInvoke): Promise<SecretStatus> {
  return call<SecretStatus>(invoke, 'secret_status', {});
}

/** 키를 저장한다. 거절 글에 값이 들어가지 않는다(Rust 도 값을 글에 넣지 않는다). */
export async function setSecret(slot: Slot, value: string, invoke: InvokeFn = tauriInvoke): Promise<void> {
  try {
    await invoke<null>('secret_set', { slot, value });
  } catch (e) {
    const err = toNetError(e);
    if (value && (err.message.includes(value) || (err.body ?? '').includes(value))) {
      throw new NetError(err.kind, err.message.split(value).join('***'), err.status);
    }
    throw err;
  }
}

export async function clearSecret(slot: Slot, invoke: InvokeFn = tauriInvoke): Promise<void> {
  await call<null>(invoke, 'secret_clear', { slot });
}

// ── 요청 추적과 취소 ──────────────────────────────────────────────

/** 아직 끝나지 않은 요청 id. 취소를 보낸 id 는 곧바로 빠지므로 같은 요청을 두 번 취소하지 않는다. */
const openRequests = new Set<string>();
let vaultController = new AbortController();

/** 지금 보관함의 신호. 보관함을 바꾸면(`cancelAllRequests`) 끊기고 새 신호가 생긴다. */
export function vaultSignal(): AbortSignal {
  return vaultController.signal;
}

function sendCancel(id: string, invoke: InvokeFn): Promise<void> {
  return invoke<boolean>('net_cancel', { requestId: id }).then(
    () => undefined,
    () => undefined, // 취소가 실패해도 웹뷰 쪽 약속은 이미 끝났다
  );
}

/**
 * 요청 id 를 만들어 `run` 에 넘기고, 끝날 때까지 추적한다. `signal` 이나 보관함 신호가 끊기면 Rust 에
 * `net_cancel` 을 보내고 Rust 를 기다리지 않고 곧바로 `NetError('cancelled')` 로 거절한다.
 * 이미 끊긴 신호면 아무것도 부르지 않는다.
 */
export function trackRequest<T>(
  signal: AbortSignal | undefined,
  run: (requestId: string) => Promise<T>,
  invoke: InvokeFn = tauriInvoke,
): Promise<T> {
  const vault = vaultSignal();
  if (signal?.aborted || vault.aborted) return Promise.reject(cancelled());
  const id = crypto.randomUUID();
  openRequests.add(id);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    /** 한 번만 끝낸다. 이 요청이 아직 추적 중이었으면 true(취소를 보낼 차례). */
    const finish = (): boolean => {
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      vault.removeEventListener('abort', onAbort);
      return openRequests.delete(id);
    };
    function onAbort() {
      if (settled) return;
      if (finish()) void sendCancel(id, invoke);
      reject(cancelled());
    }
    signal?.addEventListener('abort', onAbort);
    vault.addEventListener('abort', onAbort);
    let started: Promise<T>;
    try {
      started = run(id);
    } catch (e) {
      started = Promise.reject(e);
    }
    started.then(
      (v) => {
        if (settled) return; // 이미 취소로 거절했다
        finish();
        resolve(v);
      },
      (e: unknown) => {
        if (settled) return;
        finish();
        reject(toNetError(e));
      },
    );
  });
}

/** 보관함을 바꿀 때: 보관함 신호를 끊고, 열린 요청마다 `net_cancel` 을 한 번 보내고, 새 신호를 만든다. */
export async function cancelAllRequests(invoke: InvokeFn = tauriInvoke): Promise<void> {
  const ids = [...openRequests];
  openRequests.clear();
  const old = vaultController;
  vaultController = new AbortController();
  old.abort();
  await Promise.all(ids.map((id) => sendCancel(id, invoke)));
}

/** 네트워크를 기다린 뒤 쓰기 전에 `check()` 를 부른다(D11). 보관함이 바뀌었으면 `cancelled` 로 던진다. */
export interface VaultGuard {
  readonly signal: AbortSignal;
  readonly root: string | undefined;
  check(): Promise<void>;
}

async function currentRoot(invoke: InvokeFn): Promise<string | undefined> {
  const v = await call<{ root?: string } | null>(invoke, 'vault_current', {});
  return v?.root ?? undefined;
}

export async function vaultGuard(invoke: InvokeFn = tauriInvoke): Promise<VaultGuard> {
  const signal = vaultSignal();
  const root = await currentRoot(invoke);
  return {
    signal,
    root,
    async check() {
      if (signal.aborted) throw cancelled();
      const now = await currentRoot(invoke);
      if (signal.aborted || now !== root) throw cancelled();
    },
  };
}

// ── 서비스 커맨드 ────────────────────────────────────────────────

export type ListenFn = typeof import('@tauri-apps/api/event').listen;

export function partbankRequest(
  a: {
    connection: 'desktop' | 'web';
    method: 'GET' | 'POST' | 'PUT';
    path: string;
    query?: Array<[string, string]>;
    body?: unknown;
  },
  invoke: InvokeFn = tauriInvoke,
): Promise<{ status: number; json: unknown }> {
  return call(invoke, 'partbank_request', {
    connection: a.connection,
    method: a.method,
    path: a.path,
    query: a.query ?? null,
    body: a.body ?? null,
  });
}

export function partbankProbe(
  a: { connection: 'desktop' | 'web'; url: string; apiKey?: string },
  invoke: InvokeFn = tauriInvoke,
): Promise<unknown> {
  return call(invoke, 'partbank_probe', { connection: a.connection, url: a.url, apiKey: a.apiKey ?? null });
}

export function llmChat(
  a: { provider: 'ollama' | 'openai'; body: unknown; signal?: AbortSignal },
  invoke: InvokeFn = tauriInvoke,
): Promise<{ status: number; text: string }> {
  return trackRequest(
    a.signal,
    (requestId) =>
      call<{ status: number; text: string }>(invoke, 'llm_chat', { requestId, provider: a.provider, body: a.body }),
    invoke,
  );
}

export interface LlmProbe {
  models: string[];
  modelFound: boolean;
}

export function llmProbe(
  a: { provider: 'ollama' | 'openai'; endpoint: string; model: string; apiKey?: string },
  invoke: InvokeFn = tauriInvoke,
): Promise<LlmProbe> {
  return call(invoke, 'llm_probe', {
    provider: a.provider,
    endpoint: a.endpoint,
    model: a.model,
    apiKey: a.apiKey ?? null,
  });
}

export function bfwRequest<T = unknown>(
  a: { path: string; query?: Array<[string, string]> },
  invoke: InvokeFn = tauriInvoke,
): Promise<T> {
  return call<T>(invoke, 'bfw_request', { path: a.path, query: a.query ?? null });
}

export interface BfwProbe {
  user: string;
  read: boolean;
  ai: 'ok' | 'noScope' | 'adminOnly';
}

export function bfwProbe(
  a: { connection: 'server' | 'desktop'; url?: string; apiKey?: string },
  invoke: InvokeFn = tauriInvoke,
): Promise<BfwProbe> {
  return call(invoke, 'bfw_probe', { connection: a.connection, url: a.url ?? null, apiKey: a.apiKey ?? null });
}

export function bfwBase(invoke: InvokeFn = tauriInvoke): Promise<string> {
  return call<string>(invoke, 'bfw_base', {});
}

/** `bfworkflow://notes` 이벤트의 모양(`src-tauri/tests/ipc-events.json`). */
export interface NotesProgress {
  requestId: string;
  step: string;
  message: string;
}

const NOTES_EVENT = 'bfworkflow://notes';

/** 설계에서 노트를 만든다(SSE). 진행 이벤트는 이 요청의 id 것만 `onProgress` 로 넘기고, 끝나면 구독을 푼다. */
export async function bfwGenerateNotes(
  a: {
    design: unknown;
    language: 'ko' | 'en';
    perWorkflow: boolean;
    signal?: AbortSignal;
    onProgress(p: NotesProgress): void;
  },
  invoke: InvokeFn = tauriInvoke,
  listen: ListenFn = tauriListen,
): Promise<unknown> {
  if (a.signal?.aborted || vaultSignal().aborted) throw cancelled();
  let own: string | undefined;
  let unlisten: () => void;
  try {
    unlisten = await listen<NotesProgress>(NOTES_EVENT, (e) => {
      const p = e.payload;
      if (own !== undefined && p && p.requestId === own) a.onProgress(p);
    });
  } catch (e) {
    throw toNetError(e);
  }
  try {
    return await trackRequest(
      a.signal,
      (requestId) => {
        own = requestId;
        return call<unknown>(invoke, 'bfw_generate_notes', {
          requestId,
          design: a.design,
          language: a.language,
          perWorkflow: a.perWorkflow,
        });
      },
      invoke,
    );
  } finally {
    unlisten();
  }
}

// ── Slack(SP7 B6) ──────────────────────────────────────────────

/** Rust `SlackMethod`: 부를 수 있는 Slack Web API 메서드 전부. 주소는 Rust 가 만든다. */
export type SlackMethod = 'authTest' | 'conversationsHistory' | 'conversationsList' | 'chatPostMessage' | 'reactionsAdd';

/** Rust `SlackReply`. 2xx 와 429 가 답이다. 429 면 `retryAfter`(초)가 있다. 토큰은 Rust 가 이미 가렸다. */
export interface SlackReply {
  status: number;
  json: unknown;
  scopes?: string;
  retryAfter?: number;
}

/** Slack Web API 를 부른다. 토큰은 Rust 가 자격 증명 관리자에서 읽는다. 읽기 메서드의 `params` 는 문자열과 숫자만. */
export function slackCall(
  a: { method: SlackMethod; params?: Record<string, unknown>; signal?: AbortSignal },
  invoke: InvokeFn = tauriInvoke,
): Promise<SlackReply> {
  return trackRequest(
    a.signal,
    (requestId) => call<SlackReply>(invoke, 'slack_call', { requestId, method: a.method, params: a.params ?? {} }),
    invoke,
  );
}

/**
 * Slack 비공개 파일(`https://files.slack.com/files-pri/…`)을 받는다. 다른 주소는 Rust 가 아무것도 보내지 않고
 * `forbiddenPath` 로 거절한다. 리디렉트는 `redirect`, HTML 페이지는 `notJson`, 그 밖의 실패 응답은 `status` 다.
 */
export function slackDownload(
  a: { url: string; signal?: AbortSignal },
  invoke: InvokeFn = tauriInvoke,
): Promise<ArrayBuffer> {
  return trackRequest(
    a.signal,
    (requestId) => call<ArrayBuffer>(invoke, 'slack_download', { requestId, url: a.url }),
    invoke,
  );
}

// ── 앱 데이터 저장소 ──────────────────────────────────────────────

export function partbankCatalogList(invoke: InvokeFn = tauriInvoke): Promise<string[]> {
  return call<string[]>(invoke, 'partbank_catalog_list', {});
}

export function partbankCatalogRead(name: string, invoke: InvokeFn = tauriInvoke): Promise<string | null> {
  return call<string | null>(invoke, 'partbank_catalog_read', { name });
}

export async function partbankCatalogWrite(
  name: string,
  content: string,
  invoke: InvokeFn = tauriInvoke,
): Promise<void> {
  await call<null>(invoke, 'partbank_catalog_write', { name, content });
}

export type StateName = 'partbankUsage' | 'bfwCatalogCache' | 'scanFolderHistory' | 'slackLink';

export function integrationStateRead(name: StateName, invoke: InvokeFn = tauriInvoke): Promise<string | null> {
  return call<string | null>(invoke, 'integration_state_read', { name });
}

export async function integrationStateWrite(
  name: StateName,
  content: string,
  invoke: InvokeFn = tauriInvoke,
): Promise<void> {
  await call<null>(invoke, 'integration_state_write', { name, content });
}
