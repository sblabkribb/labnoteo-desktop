import { useEffect, useRef, useState } from 'react';
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { migrateSettings, type LabnoteSettings } from '../../vendor/labnoteo/src/settings';

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

/**
 * 앱이 보관함마다 기억하는 설정. 플러그인 설정 가운데 앱이 쓰는 것만 고른다.
 * 비밀 값(llmApiKey, mcpToken, partbank 키)은 이 Pick 에 없으므로 저장소로 갈 수 없다: 키링 하위 프로젝트를 기다린다.
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
> & { schemaVersion: number; importedFromPlugin?: boolean };

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
] as const satisfies ReadonlyArray<keyof AppSettings>;

function pick(s: LabnoteSettings): AppSettings {
  const out = {} as Record<string, unknown>;
  for (const k of KEYS) out[k] = s[k];
  return out as AppSettings;
}

/** 플러그인의 data.json(또는 아무 값)을 플러그인의 `migrateSettings` 로 고친 뒤 앱 키만 고른다. */
export function fromPluginData(raw: unknown): AppSettings {
  return pick(migrateSettings(raw));
}

/** 저장해 둔 설정: 같은 이주를 거치고, 가져온 적이 있다는 표시만 따로 지킨다. */
function fromStored(raw: unknown): AppSettings {
  const settings = fromPluginData(raw);
  if (raw && typeof raw === 'object' && (raw as { importedFromPlugin?: unknown }).importedFromPlugin === true) {
    settings.importedFromPlugin = true;
  }
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
): Promise<{ settings: AppSettings; imported: boolean }> {
  let stored: string | null = null;
  try {
    stored = await invoke<string | null>('settings_vault_read', {});
  } catch {
    return { settings: fromPluginData(undefined), imported: false };
  }
  // 손상된 저장 파일은 Rust 가 없는 것으로 돌려준다. 여기서 읽지 못한 값은 기본값이 된다.
  if (stored != null) return { settings: fromStored(parse(stored)), imported: false };

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
  return { settings, imported };
}

/**
 * `VaultView` 용: 보관함이 바뀌면 그 보관함의 설정을 읽는다. `imported` 는 이번에 플러그인 설정을
 * 처음 가져왔을 때만 true 다(다음 실행부터는 저장된 설정을 읽으므로 false).
 */
export function useVaultSettings(vaultRoot: string): {
  settings: AppSettings | undefined;
  imported: boolean;
  update(patch: Partial<AppSettings>): void;
} {
  const [settings, setSettings] = useState<AppSettings>();
  const [imported, setImported] = useState(false);
  const current = useRef<AppSettings>();
  useEffect(() => {
    let live = true;
    current.current = undefined;
    setSettings(undefined);
    setImported(false);
    loadVaultSettings().then((r) => {
      if (!live) return;
      current.current = r.settings;
      setSettings(r.settings);
      setImported(r.imported);
    });
    return () => {
      live = false;
    };
  }, [vaultRoot]);
  const update = (patch: Partial<AppSettings>) => {
    if (!current.current) return;
    const next = { ...current.current, ...patch };
    current.current = next;
    setSettings(next);
    saveVaultSettings(next).catch(() => undefined);
  };
  return { settings, imported, update };
}
