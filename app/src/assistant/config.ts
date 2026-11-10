/**
 * 이 PC 의 `assistant.json`(웹 검색 주소, 갤러리 주소)의 IPC 클라이언트(assistant spec §7.1, plan Task 12, R9).
 *
 * - 파일은 Rust(`src-tauri/src/assistant/config.rs`)가 앱 설정 폴더의 `settings.json` 옆에 둔다. 보관함에도, 보관함별
 *   설정에도 두지 않는다: 함께 쓰는 보관함이 이 PC 의 검색어가 갈 곳을 정하면 안 된다.
 * - Rust 가 쓸 때 주소를 검사한다(http/https, 계정 정보·쿼리·조각 없음, 평문 http 는 이 컴퓨터나 허용한 주소만). 틀리면 `badUrl`.
 * - 쓰기는 두 필드를 늘 함께 보낸다. 빠진 필드는 Rust 에서 지워지므로, 한 필드만 바꿀 때는 `updateAssistantConfig` 를 쓴다.
 * - `probeWebSearch` 는 저장하지 않은 주소로 시험 검색을 한 번 한다(설정의 "확인" 단추).
 */
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { toNetError, type InvokeFn } from '../integrations/netIpc';
import { toHistoryError } from './history';
import type { WebSearchResult } from './web/ipc';

export interface AssistantConfig {
  searxngUrl?: string;
  galleryUrl?: string;
}

function clean(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

function fromWire(v: unknown): AssistantConfig {
  const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  const out: AssistantConfig = {};
  const s = clean(o.searxngUrl);
  const g = clean(o.galleryUrl);
  if (s) out.searxngUrl = s;
  if (g) out.galleryUrl = g;
  return out;
}

/** 저장된 설정. 읽지 못하면 빈 설정(아무 주소도 없음). */
export async function readAssistantConfig(invoke: InvokeFn = tauriInvoke): Promise<AssistantConfig> {
  try {
    return fromWire(await invoke<unknown>('assistant_config_read', {}));
  } catch (e) {
    console.warn('[labnoteo] assistant config read failed:', e);
    return {};
  }
}

/** 설정 전체를 쓴다(없는 필드는 지운다). Rust 가 정리해 저장한 값을 돌려준다. 거절은 `AssistantHistoryError`(`badUrl`, `io`). */
export async function writeAssistantConfig(cfg: AssistantConfig, invoke: InvokeFn = tauriInvoke): Promise<AssistantConfig> {
  try {
    const stored = await invoke<unknown>('assistant_config_write', {
      cfg: { searxngUrl: cfg.searxngUrl ?? null, galleryUrl: cfg.galleryUrl ?? null },
    });
    return fromWire(stored);
  } catch (e) {
    throw toHistoryError(e);
  }
}

/** 한 필드만 바꾼다: 읽고, 합쳐서, 쓴다. */
export async function updateAssistantConfig(patch: AssistantConfig, invoke: InvokeFn = tauriInvoke): Promise<AssistantConfig> {
  const current = await readAssistantConfig(invoke);
  return writeAssistantConfig({ ...current, ...patch }, invoke);
}

/** 저장하지 않은 주소로 시험 검색을 한 번 한다. 거절은 `NetError`(`jsonDisabled`, `invalidUrl`, `insecure`, …). */
export async function probeWebSearch(url: string, invoke: InvokeFn = tauriInvoke): Promise<WebSearchResult> {
  try {
    return await invoke<WebSearchResult>('web_search_probe', { url });
  } catch (e) {
    throw toNetError(e);
  }
}
