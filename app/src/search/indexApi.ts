import { invoke as tauriInvoke } from '@tauri-apps/api/core';

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

/** Rust 의 `SearchHit`. `path` 는 디스크에서 읽은 철자의 vault-relative POSIX 경로다. */
export interface SearchHit {
  path: string;
  title: string;
  snippet: string;
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

export function searchNotes(query: string, limit: number, invoke: InvokeFn = tauriInvoke): Promise<SearchHit[]> {
  return invoke<SearchHit[]>('search', { query, limit });
}
