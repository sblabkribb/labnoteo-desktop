/**
 * 도우미의 읽기 전용 실험실 도구(partbank, Workflow 서버)가 쓰는 IPC(design §5, §8).
 *
 * - `partbankRead` 는 Rust `partbank_read` 다. 연결(웹·데스크톱)은 Rust 가 저장된 `partbankDefaultConnection` 으로 고른다:
 *   웹뷰는 슬롯을 고를 수 없다. Rust 의 읽기 전용 허용 목록(GET 몇 개와 읽기만 하는 `POST /search/global`)에 없는 요청은
 *   아무것도 보내지 않고 `forbiddenPath` 로 거절된다.
 * - `bfwRead` 는 Rust `bfw_request`(GET 만, 허용 목록)다.
 * - 키는 웹뷰로 오지 않는다. 두 커맨드 모두 요청 id 를 받지 않으므로, 실행의 취소 신호가 끊기면 웹뷰 쪽 약속만 곧바로
 *   `cancelled` 로 거절한다(Rust 의 답은 버린다).
 */
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { bfwRequest, NetError, toNetError, vaultSignal, type InvokeFn } from '../integrations/netIpc';

/** Rust `partbank::PbResponse`. */
export interface PbReadResponse {
  status: number;
  json: unknown;
}

export type QueryPairs = Array<[string, string]>;

export interface LabIpc {
  /** `path` 는 `/api/v1` 아래(`/groups/`, `/search/global` …). `body` 는 `POST /search/global` 에만. */
  partbankRead(method: 'GET' | 'POST', path: string, query?: QueryPairs, body?: unknown): Promise<PbReadResponse>;
  /** `path` 는 `/api/…` 전체. */
  bfwRead(path: string, query?: QueryPairs): Promise<unknown>;
}

/** Rust `partbank_read` 의 타입 있는 래퍼. */
export async function partbankRead(
  a: { method: 'GET' | 'POST'; path: string; query?: QueryPairs; body?: unknown },
  invoke: InvokeFn = tauriInvoke,
): Promise<PbReadResponse> {
  try {
    return await invoke<PbReadResponse>('partbank_read', {
      method: a.method,
      path: a.path,
      query: a.query ?? null,
      body: a.body ?? null,
    });
  } catch (e) {
    throw toNetError(e);
  }
}

/** `signal`(또는 보관함 신호)이 끊기면 곧바로 `cancelled` 로 거절한다. */
function cancellable<T>(signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
  const vault = vaultSignal();
  if (signal?.aborted || vault.aborted) return Promise.reject(new NetError('cancelled', 'cancelled'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      done();
      reject(new NetError('cancelled', 'cancelled'));
    };
    const done = () => {
      signal?.removeEventListener('abort', onAbort);
      vault.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    vault.addEventListener('abort', onAbort, { once: true });
    run().then(
      (v) => {
        done();
        resolve(v);
      },
      (e: unknown) => {
        done();
        reject(toNetError(e));
      },
    );
  });
}

/** `invoke` 와 실행의 취소 신호에 묶인 `LabIpc`. */
export function labIpcFor(invoke: InvokeFn = tauriInvoke, signal?: AbortSignal): LabIpc {
  return {
    partbankRead: (method, path, query, body) =>
      cancellable(signal, () => partbankRead({ method, path, ...(query ? { query } : {}), ...(body !== undefined ? { body } : {}) }, invoke)),
    bfwRead: (path, query) => cancellable(signal, () => bfwRequest({ path, ...(query ? { query } : {}) }, invoke)),
  };
}
