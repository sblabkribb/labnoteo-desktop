/**
 * `web_search`(Rust `net/web_search.rs`, spec §7.1, plan Task 12)와 `fetch_page`(Rust `net/fetch_page.rs`, spec §7.2,
 * plan Task 13) 커맨드의 타입 있는 래퍼.
 *
 * 웹뷰는 검색어와 선택 사항만 보낸다. SearXNG 주소는 Rust 가 이 PC 의 `assistant.json` 에서 매번 직접 읽는다(D8):
 * 주소가 없으면 `notConfigured`. 요청마다 `trackRequest` 를 거치므로 실행 취소와 보관함 바꾸기가 `net_cancel` 로 Rust 에 닿는다.
 * 결과 글(제목·요약·본문)은 웹의 것이라 믿지 않는다: 모델에 줄 때는 늘 `fenceUntrusted` 로 감싼다(Task 14).
 * `fetch_page` 는 사설·루프백 주소와 다른 포트·스킴을 Rust 가 막는다(`blocked`); 어떤 주소를 열어도 되는지(검색 결과나
 * 사용자가 친 주소만)는 Task 14 의 허용 목록이 IPC 전에 가린다.
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

/** Rust `fetch_page::FetchResult`. `url` 은 리디렉션을 따라간 최종 주소(조각 없음). */
export type FetchPageResult =
  | { kind: 'ok'; title: string; url: string; text: string }
  /** 읽을 글이 없거나(짧음·JavaScript 필요·meta refresh) 해석하지 못했다: 링크만 사용자에게 건넨다. */
  | { kind: 'blocked_or_js_required'; url: string };

export interface WebIpc {
  search(query: string, opts?: WebSearchOpts, requestId?: string): Promise<WebSearchResult>;
  fetchPage(url: string, requestId?: string): Promise<FetchPageResult>;
}

/** `invoke` 와 실행의 취소 신호(`signal`)에 묶인 래퍼. */
export function webIpcFor(invoke: InvokeFn = tauriInvoke, signal?: AbortSignal): WebIpc {
  return {
    search: (query, opts, requestId) =>
      trackRequest(signal, (rid) => invoke<WebSearchResult>('web_search', { requestId: rid, query, opts: opts ?? {} }), invoke, requestId),
    fetchPage: (url, requestId) =>
      trackRequest(signal, (rid) => invoke<FetchPageResult>('fetch_page', { requestId: rid, url }), invoke, requestId),
  };
}
