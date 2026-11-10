import { invoke as tauriInvoke } from '@tauri-apps/api/core';

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

/** Rust 의 `SearchHit`. `path` 는 디스크에서 읽은 철자의 vault-relative POSIX 경로다. */
export interface SearchHit {
  path: string;
  title: string;
  snippet: string;
}

/** Rust 의 `SearchResults`. `truncated` 는 `hits` 보다 더 많은 노트가 일치했다는 뜻이다. */
export interface SearchResults {
  hits: SearchHit[];
  truncated: boolean;
}

/** Rust 의 `IndexStats`(camelCase). */
export interface IndexStats {
  indexed: number;
  skipped: number;
}

/** 보관함의 파일들로 색인을 처음부터 다시 만든다. 색인은 캐시일 뿐이라 언제 해도 안전하다. */
export function rebuildIndex(invoke: InvokeFn = tauriInvoke): Promise<IndexStats> {
  return invoke<IndexStats>('index_rebuild', {});
}

/** 노트 하나를 다시 읽어 색인에 반영한다 (저장·이름 바꾸기 뒤에). */
export function upsertNote(path: string, invoke: InvokeFn = tauriInvoke): Promise<void> {
  return invoke<void>('index_upsert', { path });
}

/** 노트(또는 폴더 아래 전부)를 색인에서 뺀다. 파일은 건드리지 않는다. */
export function removeNote(path: string, invoke: InvokeFn = tauriInvoke): Promise<void> {
  return invoke<void>('index_remove', { path });
}

export function searchNotes(query: string, limit: number, invoke: InvokeFn = tauriInvoke): Promise<SearchResults> {
  return invoke<SearchResults>('search', { query, limit });
}

/**
 * vault-relative 폴더 `prefix`(예: `labnote/001_A`) 안의 노트만 찾는다. `labnote/001_AB` 는 포함되지 않는다.
 * 빈 prefix, 앞의 `/`, `..`, 역슬래시, 드라이브는 Rust 가 `badInput` 으로 거부한다. `limit` 은 Rust 가 1..=200 으로 자른다.
 */
export function searchNotesIn(
  query: string,
  prefix: string,
  limit: number,
  invoke: InvokeFn = tauriInvoke,
): Promise<SearchResults> {
  return invoke<SearchResults>('index_search_in', { query, prefix, limit });
}

/** Rust 의 `BodyPage`. `next` 는 다음 쪽에 `after` 로 넘길 키(소문자 경로)이고, 마지막 쪽이면 `null` 이다. */
export interface BodyPage {
  items: { path: string; body: string }[];
  next: string | null;
}

/** 색인된 노트 본문을 키 순서로 한 쪽씩 읽는다(링크 색인 적재용). `limit` 은 Rust 가 1..=500 으로 자른다. */
export function indexBodies(after: string | null, limit: number, invoke: InvokeFn = tauriInvoke): Promise<BodyPage> {
  return invoke<BodyPage>('index_bodies', { after, limit });
}
