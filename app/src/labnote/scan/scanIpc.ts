import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import {
  NetError,
  integrationStateRead,
  integrationStateWrite,
  toNetError,
  type InvokeFn,
} from '../../integrations/netIpc';

/**
 * 스캔 폴더 커맨드(`src-tauri/src/scan`)와 스캔 앱 데이터 상태의 타입 있는 래퍼.
 * 스캔 폴더는 Rust 가 고르고(자기 대화 상자), 나열하고, 읽고, 옮기고, 지켜본다. 웹뷰는 경로를 보내지 않고
 * 폴더 안의 파일 이름만 보낸다. 래퍼는 모두 `toNetError(e)` 로 거절한다.
 *
 * Slack 연결 상태와 공유 폴더의 90일 기록은 SP6 앱 데이터 상태(`scan/<vaultKey>/slack-link.json`,
 * `history.json`)에 둔다. Slack 토큰은 자격 증명 관리자에만 있고 여기에는 절대 쓰지 않는다.
 */

export type ScanMode = 'dedicated' | 'shared';

/** Rust `ScanFolderStatus`. `path` 가 `null` 이면 이 보관함에는 스캔 폴더가 없다. */
export interface ScanFolderStatus {
  path: string | null;
  mode: ScanMode;
  exists: boolean;
  insideVault: boolean;
  since: number | null;
  baseline: string[] | null;
}

/** Rust `ScanEntry`: 스캔 폴더 맨 위의 파일 하나. */
export interface ScanEntry {
  name: string;
  size: number;
  mtimeMs: number;
  birthtimeMs: number | null;
}

/** Rust 가 스캔 폴더에 무언가 바뀌었을 때 보내는 이벤트(`src-tauri/tests/ipc-events.json`). 본문은 없다. */
export const SCAN_FOLDER_CHANGED = 'scan://folder-changed';

async function call<T>(invoke: InvokeFn, cmd: string, args: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw toNetError(e);
  }
}

// ── 스캔 폴더 ─────────────────────────────────────────────────────

/** Rust 의 폴더 고르기 대화 상자를 연다. 취소하면 이전 상태 그대로를 돌려준다. */
export function scanFolderChoose(invoke: InvokeFn = tauriInvoke): Promise<ScanFolderStatus> {
  return call<ScanFolderStatus>(invoke, 'scan_folder_choose', {});
}

export async function scanFolderClear(invoke: InvokeFn = tauriInvoke): Promise<void> {
  await call<null>(invoke, 'scan_folder_clear', {});
}

export async function scanFolderSetMode(mode: ScanMode, invoke: InvokeFn = tauriInvoke): Promise<void> {
  await call<null>(invoke, 'scan_folder_set_mode', { mode });
}

export function scanFolderStatus(invoke: InvokeFn = tauriInvoke): Promise<ScanFolderStatus> {
  return call<ScanFolderStatus>(invoke, 'scan_folder_status', {});
}

export function scanFolderList(invoke: InvokeFn = tauriInvoke): Promise<ScanEntry[]> {
  return call<ScanEntry[]>(invoke, 'scan_folder_list', {});
}

/** 지금 폴더에 있는 기록 키(`present`)만 남기도록 기준선을 줄인다. 남은 기준선(없으면 `null`)을 돌려준다. */
export function scanFolderPruneBaseline(present: string[], invoke: InvokeFn = tauriInvoke): Promise<string[] | null> {
  return call<string[] | null>(invoke, 'scan_folder_prune_baseline', { present });
}

/** 폴더 안 파일 하나의 바이트. `name` 은 폴더 맨 위의 이름이다(경로가 아니다). */
export function scanFolderRead(name: string, invoke: InvokeFn = tauriInvoke): Promise<ArrayBuffer> {
  return call<ArrayBuffer>(invoke, 'scan_folder_read', { name });
}

/** 전용 폴더의 원본을 `labnote-processed` 나 `labnote-failed` 로 옮기고(덮어쓰지 않는다) 새 상대 경로를 돌려준다. */
export function scanFolderMove(
  name: string,
  outcome: 'processed' | 'failed',
  invoke: InvokeFn = tauriInvoke,
): Promise<string> {
  return call<string>(invoke, 'scan_folder_move', { name, outcome });
}

/** 지금 보관함의 스캔 폴더를 (다시) 지켜보기 시작한다. 폴더가 없으면 지켜보기를 멈춘다. */
export async function scanFolderWatch(invoke: InvokeFn = tauriInvoke): Promise<void> {
  await call<null>(invoke, 'scan_folder_watch', {});
}

// ── 앱 데이터 상태 ────────────────────────────────────────────────

/** Slack 받은 편지함 연결. 토큰은 들어가지 않는다. */
export interface SlackLink {
  enabled: boolean;
  mode: 'dm' | 'channel';
  channelId: string;
  linkCode: string;
  userId: string;
  lastTs: string;
  claimedTs: string[];
}

/** `xoxb-`, `xoxp-`, `xoxa-`, `xoxr-` 처럼 생긴 Slack 토큰. */
const SLACK_TOKEN_RE = /xox[abpr]-/;

function parseObject(text: string | null): Record<string, unknown> | undefined {
  if (text === null) return undefined;
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** 저장된 연결. 없거나 JSON 객체가 아니면 `undefined`, 빠지거나 타입이 틀린 칸은 기본값으로 채운다. */
export async function readSlackLink(invoke: InvokeFn = tauriInvoke): Promise<SlackLink | undefined> {
  const o = parseObject(await integrationStateRead('slackLink', invoke));
  if (!o) return undefined;
  return {
    enabled: o.enabled === true,
    mode: o.mode === 'channel' ? 'channel' : 'dm',
    channelId: str(o.channelId),
    linkCode: str(o.linkCode),
    userId: str(o.userId),
    lastTs: str(o.lastTs),
    claimedTs: Array.isArray(o.claimedTs) ? o.claimedTs.filter((x): x is string => typeof x === 'string') : [],
  };
}

/** 연결을 저장한다. 토큰처럼 보이는 글이 어디든 들어 있으면 아무것도 쓰지 않고 `badInput` 으로 거절한다. */
export async function writeSlackLink(link: SlackLink, invoke: InvokeFn = tauriInvoke): Promise<void> {
  const content = JSON.stringify(link);
  if (SLACK_TOKEN_RE.test(content)) throw new NetError('badInput', 'the Slack link must not hold a token');
  await integrationStateWrite('slackLink', content, invoke);
}

/** 공유 폴더의 90일 기록 `{기록 키: 본 시각(ms)}`. 없거나 읽을 수 없으면 빈 기록, 숫자가 아닌 값은 버린다. */
export async function readScanHistory(invoke: InvokeFn = tauriInvoke): Promise<Record<string, number>> {
  const o = parseObject(await integrationStateRead('scanFolderHistory', invoke));
  const out: Record<string, number> = {};
  if (!o) return out;
  for (const [k, v] of Object.entries(o)) if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  return out;
}

export async function writeScanHistory(h: Record<string, number>, invoke: InvokeFn = tauriInvoke): Promise<void> {
  await integrationStateWrite('scanFolderHistory', JSON.stringify(h), invoke);
}
