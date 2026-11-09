import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { open as pickFile } from '@tauri-apps/plugin-dialog';
import type { IntegrationSettingsValue } from './probes';
import { toNetError, type InvokeFn } from './netIpc';

/**
 * "파일에서 가져오기"(연동 설정). 웹뷰는 경로만 고른다: 파일을 읽고, 주소와 키를 검사하고, 키를 자격 증명 관리자에
 * 저장하는 일은 모두 Rust(`integration_import_file`)가 한다. 돌아오는 것은 요약(부분별 코드)과 저장할 설정뿐이다.
 * 키와 파일 내용은 IPC 를 건너오지 않는다. 설정은 대화상자가 늘 쓰는 저장 흐름으로 저장한다(하나의 원천).
 */

export type ImportPart = 'llm' | 'partbank' | 'bfworkflow';

export type ImportRefusal = 'insideVault' | 'tooLarge' | 'unreadable' | 'notText' | 'unrecognized';

export type ImportProblem =
  | 'badUrl'
  | 'badKey'
  | 'badModel'
  | 'badProvider'
  | 'badConnection'
  | 'notText'
  | 'noUrl'
  | 'keyNotUsed'
  | 'keychain';

/** Rust `ImportOutcome`. `settings` 는 키가 아닌 연동 설정만 담는다. */
export type ImportOutcome =
  | { status: 'refused'; reason: ImportRefusal }
  | {
      status: 'done';
      imported: Array<{ part: ImportPart; keySaved: boolean }>;
      invalid: Array<{ part: ImportPart; field: string; reason: ImportProblem }>;
      settings: Partial<IntegrationSettingsValue>;
    };

/** Rust `DeleteOutcome`. `trashUnavailable` 이면 아무것도 지우지 않았다(영구 삭제는 다시 묻는다). */
export type DeleteOutcome = 'trashed' | 'trashUnavailable' | 'deleted' | 'gone';

/** 저장해도 되는 설정 이름. Rust 가 보낸 다른 이름은 버린다. */
const IMPORTABLE: ReadonlyArray<keyof IntegrationSettingsValue> = [
  'llmProvider',
  'llmEndpointOpenai',
  'llmEndpointOllama',
  'llmModel',
  'partbankDefaultConnection',
  'partbankWebUrl',
  'partbankDesktopUrl',
  'bfwConnection',
  'bfwUrl',
];

export async function importConnectionsFile(path: string, invoke: InvokeFn = tauriInvoke): Promise<ImportOutcome> {
  let out: ImportOutcome;
  try {
    out = await invoke<ImportOutcome>('integration_import_file', { path });
  } catch (e) {
    throw toNetError(e);
  }
  if (out.status !== 'done') return out;
  const settings: Record<string, unknown> = {};
  for (const k of IMPORTABLE) {
    const v = (out.settings as Record<string, unknown>)[k];
    if (typeof v === 'string') settings[k] = v;
  }
  return { ...out, settings: settings as Partial<IntegrationSettingsValue> };
}

/** 마지막으로 가져온 파일을 지운다. Rust 가 그 경로만 기억하고, 웹뷰는 경로를 보내지 않는다. */
export async function deleteImportedFile(permanent: boolean, invoke: InvokeFn = tauriInvoke): Promise<DeleteOutcome> {
  try {
    return await invoke<DeleteOutcome>('integration_import_delete', { permanent });
  } catch (e) {
    throw toNetError(e);
  }
}

/** 파일 고르기(json, env, txt). 취소하면 null. */
export async function pickConnectionsFile(title: string): Promise<string | null> {
  const picked = await pickFile({
    title,
    multiple: false,
    directory: false,
    filters: [{ name: 'JSON / .env', extensions: ['json', 'env', 'txt'] }],
  });
  return typeof picked === 'string' ? picked : null;
}
