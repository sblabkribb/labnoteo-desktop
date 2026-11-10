/**
 * 실험 폴더별 대화 기록의 IPC 클라이언트(assistant spec §6.1, plan Task 8). 저장소는 Rust
 * (`src-tauri/src/assistant/history.rs`)에 있고, 앱 데이터 폴더(`assistant/history/<key>.json`)에만 쓴다. 보관함에는 쓰지 않는다.
 *
 * - 웹뷰는 보관함 상대 폴더(NFC)와, 읽을 때 받은 토큰과, 문서만 보낸다. 보관함 루트나 키나 경로는 보내지 않는다:
 *   Rust 가 열린 보관함과 검사한 폴더로 키를 만든다.
 * - 쓸 때 토큰이 지금 보관함의 키와 다르면 Rust 가 `vaultChanged` 로 거절한다(보관함이 바뀐 뒤 끝난 답).
 * - 문서는 알려진 필드만 보낸다(`toWireDoc`). Rust 는 모르는 필드를 거절한다. 도구 결과나 가져온 페이지 글은 담지 않는다.
 */
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import type { InvokeFn } from '../integrations/netIpc';
import type { StoredMessage } from './runtime';
import type { Source } from './sources';

/** Rust `AssistantErrorKind` (`src-tauri/tests/ipc-assistant-errors.json`). */
export type AssistantHistoryErrorKind = 'noVault' | 'badFolder' | 'tooLarge' | 'vaultChanged' | 'io';

export const ASSISTANT_HISTORY_ERROR_KINDS: readonly AssistantHistoryErrorKind[] = [
  'noVault',
  'badFolder',
  'tooLarge',
  'vaultChanged',
  'io',
];

export class AssistantHistoryError extends Error {
  constructor(
    readonly kind: AssistantHistoryErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'AssistantHistoryError';
  }
}

/** Rust 의 거절 `{kind, message}` 를 `AssistantHistoryError` 로. 모르는 것은 `io`. */
export function toHistoryError(e: unknown): AssistantHistoryError {
  if (e instanceof AssistantHistoryError) return e;
  if (e && typeof e === 'object') {
    const o = e as { kind?: unknown; message?: unknown };
    const message = typeof o.message === 'string' ? o.message : String(e);
    const kind = ASSISTANT_HISTORY_ERROR_KINDS.includes(o.kind as AssistantHistoryErrorKind)
      ? (o.kind as AssistantHistoryErrorKind)
      : 'io';
    return new AssistantHistoryError(kind, message);
  }
  return new AssistantHistoryError('io', String(e));
}

/** 압축된 앞 대화(spec §6.3). `covers` 는 요약이 대신하는 메시지 수. */
export interface HistorySummary {
  text: string;
  /** 바깥 내용(웹·MCP·논문)이 닿은 메시지에서 나온 요약인지. */
  tainted: boolean;
  covers: number;
}

export interface HistoryDoc {
  version: 1;
  /** 보관함 상대 폴더. Rust 가 검사한 인자로 채운다. */
  folder: string;
  /** 마지막으로 쓴 때(ms). */
  updated: number;
  summary?: HistorySummary;
  messages: StoredMessage[];
}

export interface HistoryRead {
  doc: HistoryDoc;
  /** 이 보관함·폴더의 키. 쓸 때 그대로 돌려준다(경로로 쓰이지 않고 비교만 된다). */
  token: string;
}

export interface HistoryStats {
  /** 기록이 있는 폴더 수(모든 보관함). */
  folders: number;
  bytes: number;
}

/** Rust 한도(spec §6.1). JS 는 넘기 전에 압축한다(Task 9). */
export const HISTORY_MAX_MESSAGES = 300;
export const HISTORY_MAX_BYTES = 384 * 1024;

function nfc(folder: string): string {
  return folder.normalize('NFC');
}

export function emptyHistory(folder: string): HistoryDoc {
  return { version: 1, folder: nfc(folder), updated: 0, messages: [] };
}

function wireSource(s: Source): Source {
  return { kind: s.kind, label: s.label, target: s.target };
}

function wireMessage(m: StoredMessage): StoredMessage {
  const out: StoredMessage = { id: m.id, role: m.role, text: m.text, ts: m.ts };
  if (m.tainted !== undefined) out.tainted = m.tainted;
  if (m.sources !== undefined) out.sources = m.sources.map(wireSource);
  if (m.chip !== undefined) out.chip = m.chip;
  return out;
}

/** Rust 가 받는 모양 그대로: 알려진 필드만, 없는 선택 필드는 빼고. 입력은 바꾸지 않는다. */
export function toWireDoc(doc: HistoryDoc): HistoryDoc {
  const out: HistoryDoc = { version: 1, folder: nfc(doc.folder), updated: doc.updated, messages: doc.messages.map(wireMessage) };
  if (doc.summary !== undefined) {
    out.summary = { text: doc.summary.text, tainted: doc.summary.tainted, covers: doc.summary.covers };
  }
  return out;
}

/** Rust 가 받을 JSON 의 UTF-8 바이트 수(한도 `HISTORY_MAX_BYTES` 와 견준다). 압축 판단에 쓴다(`compact.ts`). */
export function historyBytes(doc: HistoryDoc): number {
  return new TextEncoder().encode(JSON.stringify(toWireDoc(doc))).length;
}

async function call<T>(invoke: InvokeFn, cmd: string, args: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw toHistoryError(e);
  }
}

/** 이 폴더의 기록과 토큰. 아직 기록이 없으면 빈 문서. */
export function readHistory(folder: string, invoke: InvokeFn = tauriInvoke): Promise<HistoryRead> {
  return call<HistoryRead>(invoke, 'assistant_history_read', { folder: nfc(folder) });
}

/** 읽을 때 받은 `token` 과 함께 쓴다. 보관함이 바뀌었으면 `vaultChanged` 로 거절되고 아무것도 쓰이지 않는다. */
export async function writeHistory(folder: string, token: string, doc: HistoryDoc, invoke: InvokeFn = tauriInvoke): Promise<void> {
  const f = nfc(folder);
  await call<null>(invoke, 'assistant_history_write', { folder: f, token, doc: { ...toWireDoc(doc), folder: f } });
}

/** 이 폴더의 기록을 지운다. */
export async function clearHistory(folder: string, invoke: InvokeFn = tauriInvoke): Promise<void> {
  await call<null>(invoke, 'assistant_history_clear', { folder: nfc(folder) });
}

/** 모든 폴더(모든 보관함)의 기록을 지운다. 지운 파일 수. */
export function clearAllHistory(invoke: InvokeFn = tauriInvoke): Promise<number> {
  return call<number>(invoke, 'assistant_history_clear_all', {});
}

export function historyStats(invoke: InvokeFn = tauriInvoke): Promise<HistoryStats> {
  return call<HistoryStats>(invoke, 'assistant_history_stats', {});
}
