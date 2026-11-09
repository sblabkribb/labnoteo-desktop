import { useEffect, useRef, useState } from 'react';
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { migrateSettings, type LabnoteSettings } from '../../vendor/labnoteo/src/settings';

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

/**
 * 앱이 보관함마다 기억하는 설정. 플러그인 설정 가운데 앱이 쓰는 것만 고른다.
 * 비밀 값(llmApiKey, mcpToken, partbank·bfworkflow 키)은 이 Pick 에 없으므로 저장소로 갈 수 없다:
 * 키는 Windows 자격 증명 관리자에만 있고(Rust secret_* 커맨드), 웹뷰는 '설정됨' 여부만 안다.
 * 연동 주소(partbank, LLM, bfworkflow)는 비밀이 아니라 여기 저장하며, Rust 가 요청마다 이 저장본에서 읽는다.
 */
export type AppSettings = Pick<
  LabnoteSettings,
  | 'autoSyncUnitOpToc'
  | 'autoUpdateLastUpdated'
  | 'customSampleTypes'
  | 'globalSampleFolder'
  | 'sampleTracking'
  | 'workflowViewGroupBy'
  | 'catalogNoticeHash'
  | 'partbankDesktopUrl'
  | 'partbankWebUrl'
  | 'partbankDefaultConnection'
  | 'partbankSendUsages'
  | 'llmProvider'
  | 'llmEndpointOllama'
  | 'llmEndpointOpenai'
  | 'llmModel'
  | 'worksheetPaperSize'
  | 'mcpEnabled'
> & {
  schemaVersion: number;
  importedFromPlugin?: boolean;
  /** 앱에만 있는 키: "예전 형식 노트 바꾸기" 제안에서 "이 보관함에서는 다시 묻지 않기"를 골랐다. 기본 false. */
  legacyNotesOfferDismissed: boolean;
  /** 앱에만 있는 키: bfworkflow 서버 주소(origin). 올바르지 않으면 기본값. */
  bfwUrl: string;
  /** 앱에만 있는 키: bfworkflow 를 서버로 쓸지, 이 PC 의 데스크톱 앱으로 쓸지. */
  bfwConnection: 'server' | 'desktop';
  /** 앱에만 있는 키: 암호화 없이(http) 키를 보내도 된다고 사용자가 허락한 origin 들. 기본 []. */
  allowHttpOrigins: string[];
  /** 앱에만 있는 키(SP7 Part C): MCP 서버가 듣는 127.0.0.1 포트. 1024-65535 정수, 아니면 3987. */
  mcpPort: number;
};

/** MCP 서버의 기본 포트(플러그인과 같다). */
export const MCP_DEFAULT_PORT = 3987;

/** MCP 서버가 쓸 수 있는 포트: 1024-65535 정수(Rust `check_port` 와 같은 범위). */
export function isMcpPort(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1024 && v <= 65535;
}

/** bfworkflow 서버의 기본 주소. */
export const BFW_DEFAULT_URL = 'https://workflow.kbiofoundry.kr';

/**
 * 연동 주소로 쓸 수 있는 URL: http(s), 호스트가 있고, 사용자 정보·쿼리·조각이 없다.
 * Rust `net::config::parse_service_url` 과 같은 규칙이다(두 쪽 테스트가 같은 값을 고정한다).
 */
export function isServiceUrl(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const raw = v.trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (!url.hostname) return false;
  if (url.username || url.password) return false;
  // URL 은 빈 '?' 와 '#' 를 search/hash 에서 지우므로 원문으로도 본다.
  if (url.search || url.hash || raw.includes('?') || raw.includes('#')) return false;
  return true;
}

/** `isServiceUrl` 이면서 경로가 비었거나 `/` 뿐이다(Rust `parse_origin_url`). partbank 와 bfworkflow 주소. */
export function isOriginUrl(v: unknown): v is string {
  if (!isServiceUrl(v)) return false;
  const path = new URL(v.trim()).pathname;
  return path === '' || path === '/';
}

/** `http://` origin 만 남긴다(중복 없이). 다른 값은 버린다. */
function httpOrigins(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const e of v) {
    if (isOriginUrl(e) && new URL(e.trim()).protocol === 'http:') {
      const o = e.trim();
      if (!out.includes(o)) out.push(o);
    }
  }
  return out;
}

/** 고르는 키. 저장하기 전에도 이 목록으로 다시 걸러, 타입을 우회해 섞여 든 키도 저장되지 않게 한다. */
const KEYS = [
  'schemaVersion',
  'autoSyncUnitOpToc',
  'autoUpdateLastUpdated',
  'customSampleTypes',
  'globalSampleFolder',
  'sampleTracking',
  'workflowViewGroupBy',
  'catalogNoticeHash',
  'legacyNotesOfferDismissed',
  'partbankDesktopUrl',
  'partbankWebUrl',
  'partbankDefaultConnection',
  'partbankSendUsages',
  'llmProvider',
  'llmEndpointOllama',
  'llmEndpointOpenai',
  'llmModel',
  'bfwUrl',
  'bfwConnection',
  'allowHttpOrigins',
  // SP7 Part A: 실험 워크시트 용지(a4 | letter). 플러그인 migrateSettings 가 기본값과 검사를 맡는다.
  'worksheetPaperSize',
  // SP7 Part C: MCP 서버. mcpEnabled 는 플러그인 키지만 가져올 때는 늘 끈다(C6). mcpPort 는 앱 키.
  'mcpEnabled',
  'mcpPort',
] as const satisfies ReadonlyArray<keyof AppSettings>;

/** 플러그인에 없는 앱 키의 기본값. */
const APP_DEFAULTS = {
  legacyNotesOfferDismissed: false,
  bfwUrl: BFW_DEFAULT_URL,
  bfwConnection: 'server',
  mcpPort: MCP_DEFAULT_PORT,
} as const;

function pick(s: LabnoteSettings): AppSettings {
  const out = {} as Record<string, unknown>;
  for (const k of KEYS) out[k] = k in APP_DEFAULTS ? APP_DEFAULTS[k as keyof typeof APP_DEFAULTS] : s[k as keyof LabnoteSettings];
  // 배열 기본값은 부를 때마다 새로 만든다(설정끼리 같은 배열을 나눠 쓰지 않게).
  out.allowHttpOrigins = [];
  return out as AppSettings;
}

/**
 * 플러그인의 data.json(또는 아무 값)을 플러그인의 `migrateSettings` 로 고친 뒤 앱 키만 고른다.
 * 그 뒤 앱이 다르게 정한 것: `partbankSendUsages` 는 값이 꼭 true 일 때만 켠다(플러그인 기본은 true, D12).
 * bfworkflow 키와 `allowHttpOrigins` 는 플러그인 이주가 모르므로 여기서 직접 읽고 검사한다.
 */
export function fromPluginData(raw: unknown): AppSettings {
  const settings = pick(migrateSettings(raw));
  const data = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  settings.partbankSendUsages = data.partbankSendUsages === true;
  if (isOriginUrl(data.bfwUrl)) settings.bfwUrl = data.bfwUrl.trim();
  if (data.bfwConnection === 'server' || data.bfwConnection === 'desktop') settings.bfwConnection = data.bfwConnection;
  settings.allowHttpOrigins = httpOrigins(data.allowHttpOrigins);
  // 가져오기는 리스너를 열지 않는다(C6): 플러그인에서 켜 두었어도 앱에서는 꺼진 채로 시작한다.
  settings.mcpEnabled = false;
  return settings;
}

/** 저장해 둔 설정: 같은 이주를 거치고, 가져온 적이 있다는 표시만 따로 지킨다. */
export function fromStored(raw: unknown): AppSettings {
  const settings = fromPluginData(raw);
  if (raw && typeof raw === 'object' && (raw as { importedFromPlugin?: unknown }).importedFromPlugin === true) {
    settings.importedFromPlugin = true;
  }
  // 앱 키는 migrateSettings 가 모른다: 저장된 값이 참일 때만 살린다.
  if (raw && typeof raw === 'object' && (raw as { legacyNotesOfferDismissed?: unknown }).legacyNotesOfferDismissed === true) {
    settings.legacyNotesOfferDismissed = true;
  }
  // MCP(C6): 앱이 저장한 값이 꼭 true 일 때만 켜고, 범위 안의 정수 포트만 살린다.
  if (raw && typeof raw === 'object' && (raw as { mcpEnabled?: unknown }).mcpEnabled === true) settings.mcpEnabled = true;
  const port = raw && typeof raw === 'object' ? (raw as { mcpPort?: unknown }).mcpPort : undefined;
  if (isMcpPort(port)) settings.mcpPort = port;
  return settings;
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** 지금 열린 보관함의 설정을 저장한다(앱 설정 폴더, 보관함 밖). 앱 키만 쓴다. */
export async function saveVaultSettings(s: AppSettings, invoke: InvokeFn = tauriInvoke): Promise<void> {
  const clean: Record<string, unknown> = {};
  for (const k of KEYS) clean[k] = s[k];
  if (s.importedFromPlugin === true) clean.importedFromPlugin = true;
  await invoke<void>('settings_vault_write', { content: JSON.stringify(clean) });
}

/**
 * 지금 열린 보관함의 설정을 읽는다. 저장된 것이 있으면 그것, 없으면 Obsidian 플러그인의
 * data.json 을 한 번 가져와 저장한다(`imported: true`), 그것도 없으면 기본값을 저장한다.
 * 던지지 않는다: 읽거나 쓰지 못하면 기본값으로 계속한다.
 */
export async function loadVaultSettings(
  invoke: InvokeFn = tauriInvoke,
): Promise<{ settings: AppSettings; imported: boolean; foundLlmKey: boolean }> {
  let stored: string | null = null;
  try {
    stored = await invoke<string | null>('settings_vault_read', {});
  } catch {
    return { settings: fromPluginData(undefined), imported: false, foundLlmKey: false };
  }
  // 손상된 저장 파일은 Rust 가 없는 것으로 돌려준다. 여기서 읽지 못한 값은 기본값이 된다.
  if (stored != null) return { settings: fromStored(parse(stored)), imported: false, foundLlmKey: false };

  let plugin: string | null = null;
  try {
    plugin = await invoke<string | null>('settings_import_plugin', {});
  } catch {
    plugin = null;
  }
  const raw = plugin != null ? parse(plugin) : undefined;
  const imported = raw !== undefined && raw !== null && typeof raw === 'object' && !Array.isArray(raw);
  const settings = imported ? { ...fromPluginData(raw), importedFromPlugin: true } : fromPluginData(undefined);
  try {
    await saveVaultSettings(settings, invoke);
  } catch {
    // 저장하지 못해도 이번 실행은 이 값으로 쓴다. 다음에 다시 가져온다.
  }
  // Rust 는 가져온 설정에서 키를 지워 돌려준다(D9). LLM 키가 있었는지만 따로 묻는다(값은 오지 않는다).
  let foundLlmKey = false;
  if (imported) {
    try {
      foundLlmKey = (await invoke<boolean>('settings_plugin_llm_key', {})) === true;
    } catch {
      foundLlmKey = false;
    }
  }
  return { settings, imported, foundLlmKey };
}

/**
 * `VaultView` 용: 보관함이 바뀌면 그 보관함의 설정을 읽는다. `imported` 는 이번에 플러그인 설정을
 * 처음 가져왔을 때만 true 다(다음 실행부터는 저장된 설정을 읽으므로 false). `foundLlmKey` 는 그때
 * 플러그인 data.json 에 아직 저장하지 않은 LLM 키가 있었다는 뜻이다(App 이 저장을 제안한다).
 */
export function useVaultSettings(vaultRoot: string): {
  settings: AppSettings | undefined;
  imported: boolean;
  foundLlmKey: boolean;
  update(patch: Partial<AppSettings>): Promise<void>;
} {
  const [settings, setSettings] = useState<AppSettings>();
  const [imported, setImported] = useState(false);
  const [foundLlmKey, setFoundLlmKey] = useState(false);
  const current = useRef<AppSettings>();
  useEffect(() => {
    let live = true;
    current.current = undefined;
    setSettings(undefined);
    setImported(false);
    setFoundLlmKey(false);
    loadVaultSettings().then((r) => {
      if (!live) return;
      current.current = r.settings;
      setSettings(r.settings);
      setImported(r.imported);
      setFoundLlmKey(r.foundLlmKey);
    });
    return () => {
      live = false;
    };
  }, [vaultRoot]);
  /** 바꾼 값을 곧바로 보이고 저장한다. 저장이 끝나면(실패해도) 풀린다: 연동 설정은 Rust 가 저장본을 읽은 뒤에 고리를 부른다. */
  const update = (patch: Partial<AppSettings>): Promise<void> => {
    if (!current.current) return Promise.resolve();
    const next = { ...current.current, ...patch };
    current.current = next;
    setSettings(next);
    return saveVaultSettings(next).catch(() => undefined);
  };
  return { settings, imported, foundLlmKey, update };
}
