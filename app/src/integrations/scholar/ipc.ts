/**
 * 문헌 검색 커맨드(`scholar_search`, `scholar_get`, Rust `net/scholar`)의 타입 있는 래퍼(spec §8).
 *
 * 웹뷰는 출처 이름과 검색어나 id 만 보낸다. 주소는 Rust 의 상수이고, NCBI API 키는 Rust 가 자격 증명 관리자에서 직접 읽는다.
 * 요청마다 `trackRequest` 를 거치므로 에이전트의 취소와 보관함 바꾸기가 `net_cancel` 로 Rust 에 닿는다.
 * 인자 이름은 늘 다 보낸다(빈 값은 undefined, Rust 에는 None): `src-tauri/tests/ipc-args.json` 과 같다.
 */
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { trackRequest, type InvokeFn } from '../netIpc';

/** Rust `scholar::SOURCES`. */
export type ScholarSource = 'pubmed' | 'europepmc' | 'crossref' | 'biorxiv';

/** Rust `scholar::Hit`(camelCase). 글은 서비스의 것이라 믿지 않는다. */
export interface ScholarHit {
  source: ScholarSource;
  /** 이 출처의 `scholar_get` 에 넘기는 id(Europe PMC 는 `MED:123` 처럼). */
  id: string;
  pmid?: string;
  doi?: string;
  title: string;
  authors: string;
  venue: string;
  year?: number;
  url: string;
}

/** Rust `scholar::Abstract`. */
export interface ScholarAbstract {
  hit: ScholarHit;
  text: string;
  truncated: boolean;
}

export interface ScholarIpc {
  search(source: ScholarSource, query: string, limit?: number, preprintsOnly?: boolean, requestId?: string): Promise<ScholarHit[]>;
  get(source: ScholarSource, id: string, requestId?: string): Promise<ScholarAbstract>;
}

/** `invoke` 와 실행의 취소 신호(`signal`)에 묶인 래퍼. */
export function scholarIpcFor(invoke: InvokeFn = tauriInvoke, signal?: AbortSignal): ScholarIpc {
  return {
    search: (source, query, limit, preprintsOnly, requestId) =>
      trackRequest(
        signal,
        (rid) => invoke<ScholarHit[]>('scholar_search', { source, query, limit, preprintsOnly, requestId: rid }),
        invoke,
        requestId,
      ),
    get: (source, id, requestId) =>
      trackRequest(signal, (rid) => invoke<ScholarAbstract>('scholar_get', { source, id, requestId: rid }), invoke, requestId),
  };
}

/** 앱의 기본 래퍼(Tauri invoke, 보관함 신호만). */
export const scholarIpc: ScholarIpc = scholarIpcFor();
