import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { listen as tauriListen } from '@tauri-apps/api/event';
import type { SecretStatus, Slot } from './secretsEvents';
import type { McpCallResult, McpSecretFlag, McpServerInfo } from './mcpClient/types';

/**
 * SP6 net 커맨드의 타입 있는 래퍼. 네트워크는 모두 Rust 가 한다: 웹뷰는 커맨드만 부르고, 주소와 키는
 * Rust 가 저장된 설정과 Windows 자격 증명 관리자에서 직접 읽는다. 키 값은 이 파일을 거쳐 Rust 로 갈 수는
 * 있어도(setSecret, 연결 시험) 돌아오지 않는다.
 *
 * 래퍼는 모두 `toNetError(e)` 로 거절한다. `NetError.message` 는 Rust 의 원래 글이라 사용자에게 보이지 않는다:
 * 보이는 글은 `kind` 에서 번역 키로 만든다.
 */

export type { SecretStatus, Slot } from './secretsEvents';

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
  | 'io'
  | 'mcpAuth'
  | 'mcpProtocol'
  | 'mcpModernOnly'
  | 'mcpToolError'
  | 'jsonDisabled'
  | 'rateLimited'
  | 'enginesDown'
  | 'blocked'
  | 'unsupportedType';

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
  'mcpAuth',
  'mcpProtocol',
  'mcpModernOnly',
  'mcpToolError',
  'jsonDisabled',
  'rateLimited',
  'enginesDown',
  'blocked',
  'unsupportedType',
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
 * 이미 끊긴 신호면 아무것도 부르지 않는다. `requestId` 를 주면 그 id 를 쓴다(이미 추적 중인 id 면 `badInput`).
 */
export function trackRequest<T>(
  signal: AbortSignal | undefined,
  run: (requestId: string) => Promise<T>,
  invoke: InvokeFn = tauriInvoke,
  requestId?: string,
): Promise<T> {
  const vault = vaultSignal();
  if (signal?.aborted || vault.aborted) return Promise.reject(cancelled());
  if (requestId !== undefined && (requestId === '' || openRequests.has(requestId))) {
    return Promise.reject(new NetError('badInput', 'request id in use'));
  }
  const id = requestId ?? crypto.randomUUID();
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

/** `llm://frame` 이벤트의 모양(`src-tauri/tests/ipc-events.json`): SSE `data` 하나, 또는 NDJSON 한 줄. */
export interface LlmFrame {
  requestId: string;
  data: string;
}

export const LLM_FRAME_EVENT = 'llm://frame';

/**
 * `llm_chat_stream` 의 끝: 프레임을 다 보낸 뒤 `{status, done: true, frames}`, 또는 2xx 가 아닌 답의 앞부분
 * `{status, text}`(이때 프레임은 없다), 또는 `stream: true` 를 무시한 서버의 JSON 답 전체 `{status: 2xx, text}`.
 */
export interface LlmStreamEnd {
  status: number;
  text?: string;
  done?: boolean;
  frames?: number;
}

/** 명령 결과가 이벤트를 앞질렀을 때 남은 프레임을 기다리는 시간. */
const FRAME_WAIT_MS = 2000;

/**
 * 스트리밍 채팅(spec §6.2). 이 요청 id 의 `llm://frame` 만 차례로 `onFrame` 에 넘긴다. Rust 가 답한 프레임 수보다
 * 받은 것이 적으면 `frameWaitMs` 까지 기다리고, 그래도 모자라면 `NetError('noResult')`. 끝나거나 취소되면 구독을
 * 풀고, 그 뒤 프레임은 버린다. `onFrame` 이 던지면(예: 스트림 가운데 온 `{error}` 프레임) 첫 오류를 간직하고,
 * 남은 프레임은 버리고, 요청을 멈춘 뒤 그 오류로 거절한다. 기다리는 동안 취소하면 곧바로 `cancelled`.
 */
export async function llmChatStream(
  a: {
    provider: 'ollama' | 'openai';
    body: unknown;
    signal?: AbortSignal;
    onFrame(data: string): void;
    frameWaitMs?: number;
  },
  invoke: InvokeFn = tauriInvoke,
  listen: ListenFn = tauriListen,
): Promise<LlmStreamEnd> {
  const vault = vaultSignal();
  if (a.signal?.aborted || vault.aborted) throw cancelled();
  let own: string | undefined;
  let open = true;
  let received = 0;
  let wake: (() => void) | undefined;
  /** 첫 프레임 오류. 있으면 `stop` 으로 요청을 끊는다. */
  let frameError: { error: unknown } | undefined;
  const stop = new AbortController();
  const forward = () => stop.abort();
  a.signal?.addEventListener('abort', forward);
  let unlisten: () => void;
  try {
    unlisten = await listen<LlmFrame>(LLM_FRAME_EVENT, (e) => {
      const f = e.payload;
      if (!open || frameError || own === undefined || !f || f.requestId !== own || typeof f.data !== 'string') return;
      received += 1;
      try {
        a.onFrame(f.data);
      } catch (err) {
        frameError = { error: err };
        stop.abort();
      }
      wake?.();
    });
  } catch (e) {
    a.signal?.removeEventListener('abort', forward);
    throw toNetError(e);
  }
  const userCancelled = () => a.signal?.aborted === true || vault.aborted;
  try {
    let end: LlmStreamEnd;
    try {
      end = await trackRequest(
        stop.signal,
        (requestId) => {
          own = requestId;
          return call<LlmStreamEnd>(invoke, 'llm_chat_stream', { requestId, provider: a.provider, body: a.body });
        },
        invoke,
      );
    } catch (e) {
      if (frameError && !userCancelled()) throw frameError.error;
      throw e;
    }
    if (frameError) throw frameError.error;
    const expected = end.done ? (end.frames ?? 0) : 0;
    if (received < expected) {
      await new Promise<void>((resolve, reject) => {
        const done = () => {
          clearTimeout(timer);
          stop.signal.removeEventListener('abort', onAbort);
          vault.removeEventListener('abort', onAbort);
        };
        const onAbort = () => {
          done();
          if (frameError && !userCancelled()) reject(frameError.error);
          else reject(cancelled());
        };
        const timer = setTimeout(() => {
          done();
          resolve();
        }, a.frameWaitMs ?? FRAME_WAIT_MS);
        wake = () => {
          if (received >= expected) {
            done();
            resolve();
          }
        };
        stop.signal.addEventListener('abort', onAbort);
        vault.addEventListener('abort', onAbort);
        if (stop.signal.aborted || vault.aborted) onAbort();
      });
      // 기다리는 동안 생긴 프레임 오류(위 onAbort 가 먼저 거절하지만, 좁혀진 타입을 다시 넓혀 확인한다).
      const late = frameError as { error: unknown } | undefined;
      if (late) throw late.error;
      if (received < expected) throw new NetError('noResult', 'some of the streamed answer did not arrive');
    }
    return end;
  } finally {
    open = false;
    a.signal?.removeEventListener('abort', forward);
    unlisten();
  }
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

// ── MCP 클라이언트(외부 MCP 서버, spec §4.5) ──────────────────────────
//
// 서버는 id 로만 고른다: 주소는 Rust 가 저장된 설정에서 읽고, 웹뷰는 주소를 넘기지 않는다. 토큰은
// `mcpClientSecretSet` 으로 한 번 Rust 에 가고 다시 오지 않는다.

/** 토큰을 저장한다(앞의 `Bearer ` 는 Rust 가 지운다). 거절 글에 값이 남지 않는다. */
export async function mcpClientSecretSet(id: string, value: string, invoke: InvokeFn = tauriInvoke): Promise<void> {
  try {
    await invoke<null>('mcp_client_secret_set', { id, value });
  } catch (e) {
    const err = toNetError(e);
    if (value && (err.message.includes(value) || (err.body ?? '').includes(value))) {
      throw new NetError(err.kind, err.message.split(value).join('***'), err.status);
    }
    throw err;
  }
}

export async function mcpClientSecretClear(id: string, invoke: InvokeFn = tauriInvoke): Promise<void> {
  await call<null>(invoke, 'mcp_client_secret_clear', { id });
}

/** 서버 id → 토큰이 저장됐는지와 epoch. 값은 오지 않는다. */
export async function mcpClientSecretStatus(invoke: InvokeFn = tauriInvoke): Promise<Record<string, McpSecretFlag>> {
  return (await call<Record<string, McpSecretFlag> | null>(invoke, 'mcp_client_secret_status', {})) ?? {};
}

/** 연결해 서버 정보와 도구 목록을 받는다. Rust 가 도구 목록을 캐시한다. */
export function mcpClientConnect(id: string, invoke: InvokeFn = tauriInvoke): Promise<McpServerInfo> {
  return call<McpServerInfo>(invoke, 'mcp_client_connect', { id });
}

/**
 * 도구를 부른다. `trackRequest` 를 거치므로 `signal`(에이전트의 취소)과 보관함 바꾸기가 `net_cancel` 로 Rust 에 닿는다.
 * `requestId` 를 주면 그 id 로 추적한다(없으면 새로 만든다).
 */
export function mcpClientCall(
  id: string,
  tool: string,
  args: Record<string, unknown>,
  requestId?: string,
  invoke: InvokeFn = tauriInvoke,
  signal?: AbortSignal,
): Promise<McpCallResult> {
  return trackRequest(
    signal,
    (rid) => call<McpCallResult>(invoke, 'mcp_client_call', { id, tool, args, requestId: rid }),
    invoke,
    requestId,
  );
}

export async function mcpClientDisconnect(id: string, invoke: InvokeFn = tauriInvoke): Promise<void> {
  await call<null>(invoke, 'mcp_client_disconnect', { id });
}

/** 서버를 지우기 전에 부른다: 토큰 조각, 캐시, 세션을 지운다(Rust 는 저장된 설정에서 origin 을 찾는다). */
export async function mcpClientForget(id: string, invoke: InvokeFn = tauriInvoke): Promise<void> {
  await call<null>(invoke, 'mcp_client_forget', { id });
}

/** 캐시된 도구 목록(서버 id → 정보). 웹뷰는 읽기만 한다. */
export async function mcpClientToolsCached(invoke: InvokeFn = tauriInvoke): Promise<Record<string, McpServerInfo>> {
  return (await call<Record<string, McpServerInfo> | null>(invoke, 'mcp_client_tools_cached', {})) ?? {};
}

/** 새 서버 id: 8자리 소문자 16진수(`crypto.getRandomValues`). */
export function newServerId(): string {
  const b = new Uint8Array(4);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/**
 * 경로 조각 하나가 비밀처럼 보인다: `[A-Za-z0-9_-]` 24자 이상이고 글자와 숫자가 섞였다(Rust
 * `config::is_secret_looking_url` 과 같은 규칙, spec §5.1). 주소가 아니면 false.
 */
export function isSecretLookingUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return false;
  }
  return u.pathname
    .split('/')
    .some((seg) => seg.length >= 24 && /^[A-Za-z0-9_-]+$/.test(seg) && /[A-Za-z]/.test(seg) && /[0-9]/.test(seg));
}
