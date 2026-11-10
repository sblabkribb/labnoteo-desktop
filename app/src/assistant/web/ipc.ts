/**
 * `web_search` 커맨드(Rust `net/web_search.rs`)의 타입 있는 래퍼(assistant spec §7.1, plan Task 12).
 *
 * 웹뷰는 검색어와 선택 사항만 보낸다. SearXNG 주소는 Rust 가 이 PC 의 `assistant.json` 에서 매번 직접 읽는다(D8):
 * 주소가 없으면 `notConfigured`. 요청마다 `trackRequest` 를 거치므로 실행 취소와 보관함 바꾸기가 `net_cancel` 로 Rust 에 닿는다.
 * 결과 글(제목·요약)은 웹의 것이라 믿지 않는다: 모델에 줄 때는 늘 `fenceUntrusted` 로 감싼다(Task 14).
 */
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { trackRequest, type InvokeFn } from '../../integrations/netIpc';

/** Rust `web_search::MAX_QUERY`. 넘으면 Rust 가 `badInput` 으로 거절한다. */
export const MAX_WEB_QUERY = 200;

/** Rust `web_search::Hit`. */
export interface WebHit {
  title: string;
  /** http/https, 조각(#…) 없음. */
  url: string;
  snippet: string;
  engine: string;
}

/** Rust `web_search::SearchResult`. */
export interface WebSearchResult {
  hits: WebHit[];
  /** 일부 검색 엔진이 답하지 않았다(결과가 모자랄 수 있다). */
  enginesDown: boolean;
}

/** Rust `web_search::SearchOpts`. 모르는 필드는 Rust 가 거절한다. */
export interface WebSearchOpts {
  /** `ko`, `en-US`, `all`(기본) 같은 언어 태그. */
  language?: string;
  timeRange?: 'day' | 'week' | 'month' | 'year';
  categories?: Array<'general' | 'science' | 'it' | 'news'>;
}

export interface WebIpc {
  search(query: string, opts?: WebSearchOpts, requestId?: string): Promise<WebSearchResult>;
}

/** `invoke` 와 실행의 취소 신호(`signal`)에 묶인 래퍼. */
export function webIpcFor(invoke: InvokeFn = tauriInvoke, signal?: AbortSignal): WebIpc {
  return {
    search: (query, opts, requestId) =>
      trackRequest(signal, (rid) => invoke<WebSearchResult>('web_search', { requestId: rid, query, opts: opts ?? {} }), invoke, requestId),
  };
}
