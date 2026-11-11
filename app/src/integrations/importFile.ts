import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import type { IntegrationSettingsValue } from './probes';
import { toNetError, type InvokeFn } from './netIpc';
import type { RawInvoke } from '../fs/vaultImage';

/**
 * "파일에서 가져오기"(연동 설정). 웹뷰는 경로를 보내지 않는다: 고르기 창을 띄우고, 파일을 읽고, 주소와 키를 검사하고,
 * 키를 자격 증명 관리자에 저장하는 일은 모두 Rust(`integration_import_pick`)가 한다. 대화상자에 끌어 놓은 파일은 경로가
 * 없으므로 바이트를 한 번 원시 본문으로 보낸다(`integration_import_bytes`, 같은 검사와 해석). 돌아오는 것은 요약(부분별
 * 코드)과 저장할 설정뿐이다. 키는 IPC 를 건너 돌아오지 않는다. 설정은 대화상자가 늘 쓰는 저장 흐름으로 저장한다(하나의 원천).
 */

/** `mcpServer`: Claude-Desktop 모양 JSON 의 `mcpServers`(또는 VS Code 의 `servers`) 항목 하나. */
/** `github`: 토큰은 자격 증명 관리자의 GitHub 칸에, Client ID 는 앱 전체 GitHub 설정에(Rust). 볼트 설정에는 아무것도 오지 않는다. */
export type ImportPart = 'llm' | 'partbank' | 'bfworkflow' | 'mcpServer' | 'github';

export type ImportRefusal = 'insideVault' | 'tooLarge' | 'unreadable' | 'notText' | 'unrecognized' | 'wrongType';

/** 가져올 수 있는 파일의 가장 큰 크기(Rust `MAX_IMPORT_BYTES`). */
export const MAX_IMPORT_BYTES = 64 * 1024;

export type ImportProblem =
  | 'badUrl'
  | 'badKey'
  | 'badModel'
  | 'badProvider'
  | 'badConnection'
  | 'notText'
  | 'noUrl'
  | 'keyNotUsed'
  | 'keychain'
  // MCP 서버 항목만(spec §6.2): 로컬 명령(stdio)과 예전 SSE 는 건너뛰고, 다른 헤더는 가져오지 않는다.
  | 'stdioSkipped'
  | 'sseSkipped'
  | 'badType'
  | 'otherHeaders'
  | 'needsToken'
  | 'urlSecret'
  | 'tooMany'
  // GitHub 항목(feat/github-upload)
  | 'badToken'
  | 'badClientId'
  | 'appData';

/** 가져온 MCP 서버 하나(Rust `McpImported`). 토큰도 헤더 값도 없다. */
export interface McpImported {
  id: string;
  /** 파일의 키에서 온, 다듬은 이름(평문으로만 보인다). */
  name: string;
  origin: string;
  preset?: 'rapid' | 'biomodel';
  tokenStored: boolean;
  needsToken: boolean;
}

/** Rust `ImportOutcome`. `settings` 는 키가 아닌 연동 설정만 담는다. */
export type ImportOutcome =
  | { status: 'refused'; reason: ImportRefusal }
  | {
      status: 'done';
      imported: Array<{ part: ImportPart; keySaved: boolean }>;
      /** `name` 은 MCP 서버 항목에만 있다. */
      invalid: Array<{ part: ImportPart; field: string; reason: ImportProblem; name?: string }>;
      /** 더하거나 고친 MCP 서버. 예전 답에는 없을 수 있다. */
      mcp?: McpImported[];
      /** `mcpClientServers` 가 있으면 저장된 것과 가져온 것을 합친 전체 목록이다. */
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

/** Rust 가 보낸 설정 가운데 연결 설정만 남긴다. */
function keepImportable(out: ImportOutcome): ImportOutcome {
  if (out.status !== 'done') return out;
  const settings: Record<string, unknown> = {};
  for (const k of IMPORTABLE) {
    const v = (out.settings as Record<string, unknown>)[k];
    if (typeof v === 'string') settings[k] = v;
  }
  // 대화상자가 저장하기 전에 `cleanMcpServers` 로 한 번 더 거른다.
  const servers = (out.settings as Record<string, unknown>).mcpClientServers;
  if (Array.isArray(servers)) settings.mcpClientServers = servers;
  return { ...out, settings: settings as Partial<IntegrationSettingsValue> };
}

/** Rust 가 고르기 창(제목 `title`)을 띄우고 고른 파일을 가져온다. 취소하면 null. */
export async function importConnectionsFile(title: string, invoke: InvokeFn = tauriInvoke): Promise<ImportOutcome | null> {
  let out: ImportOutcome | null;
  try {
    out = await invoke<ImportOutcome | null>('integration_import_pick', { title });
  } catch (e) {
    throw toNetError(e);
  }
  return out ? keepImportable(out) : null;
}

/**
 * 끌어 놓은 파일의 바이트를 한 번 보낸다(원시 본문, 이름은 퍼센트 인코딩한 `x-lno-name`). 보낸 뒤에는 성공해도
 * 실패해도 버퍼를 0 으로 지운다. 키가 든 바이트를 오래 쥐고 있지 않기 위해서다.
 */
export async function importConnectionsBytes(
  name: string,
  bytes: Uint8Array,
  invoke: RawInvoke = tauriInvoke as RawInvoke,
): Promise<ImportOutcome> {
  try {
    const out = await invoke<ImportOutcome>('integration_import_bytes', bytes, {
      headers: { 'x-lno-name': encodeURIComponent(name) },
    });
    return keepImportable(out);
  } catch (e) {
    throw toNetError(e);
  } finally {
    bytes.fill(0);
  }
}

/** 끌어 놓을 수 있는 확장자: .env, .json, .txt, 또는 확장자 없음(`.env` 자체도). Rust `format_for` 와 같다. */
function acceptedName(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower === '.env') return true;
  const dot = lower.lastIndexOf('.');
  if (dot < 0) return lower.length > 0;
  return ['env', 'json', 'txt'].includes(lower.slice(dot + 1));
}

/** 끌어 놓은 파일들을 미리 검사한다: 정확히 하나, 64 KiB 이하, 받는 확장자. 바이트는 읽지 않는다. */
export function checkDroppedFiles(
  files: ArrayLike<File>,
): { file: File } | { refused: 'oneFile' | 'tooLarge' | 'wrongType' } {
  if (files.length !== 1) return { refused: 'oneFile' };
  const file = files[0]!;
  if (!acceptedName(file.name)) return { refused: 'wrongType' };
  if (file.size > MAX_IMPORT_BYTES) return { refused: 'tooLarge' };
  return { file };
}

/** 마지막으로 가져온 파일을 지운다. Rust 가 그 경로만 기억하고, 웹뷰는 경로를 보내지 않는다. */
export async function deleteImportedFile(permanent: boolean, invoke: InvokeFn = tauriInvoke): Promise<DeleteOutcome> {
  try {
    return await invoke<DeleteOutcome>('integration_import_delete', { permanent });
  } catch (e) {
    throw toNetError(e);
  }
}
