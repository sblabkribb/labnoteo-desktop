import { invoke as tauriInvoke } from '@tauri-apps/api/core';

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

/**
 * 링크 고침 기록(D15)의 IPC 껍데기. 기록은 보관함 밖(`app_local_data_dir/link-journal/<vault_key>/`)에
 * `header.json` 과 노트마다 `<n>.json` 으로 남는다. 내용은 Rust 가 해석하지 않는 JSON 문자열이다.
 * 기록의 의미(머리말·노트 기록의 모양, 용량 상한)는 `journal.ts` 가 맡는다.
 */
export interface JournalFiles {
  header: string;
  /** n 오름차순. */
  notes: string[];
}

/** 열린 보관함의 기록. 머리말이 없으면(기록이 없거나 지워졌으면) `null`. */
export function readLinkJournal(invoke: InvokeFn = tauriInvoke): Promise<JournalFiles | null> {
  return invoke<JournalFiles | null>('link_journal_read', {});
}

/** 머리말을 쓴다(임시 파일 뒤 이름 바꾸기라 반쯤 쓰인 채로 남지 않는다). */
export function writeLinkJournalHeader(content: string, invoke: InvokeFn = tauriInvoke): Promise<void> {
  return invoke<void>('link_journal_write_header', { content });
}

/** 노트 기록 `<n>.json` 을 쓴다. */
export function writeLinkJournalNote(n: number, content: string, invoke: InvokeFn = tauriInvoke): Promise<void> {
  return invoke<void>('link_journal_write_note', { n, content });
}

/** 기록 전체를 지운다. 없어도 괜찮다. */
export function clearLinkJournal(invoke: InvokeFn = tauriInvoke): Promise<void> {
  return invoke<void>('link_journal_clear', {});
}
