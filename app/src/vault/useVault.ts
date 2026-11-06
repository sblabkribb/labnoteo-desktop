import { useCallback, useEffect, useState } from 'react';
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { t } from '../i18n/t';

/** Rust 의 `VaultInfo` 직렬화 모양(camelCase). `root` 는 표시용이다. */
export interface VaultInfo {
  root: string;
  name: string;
  hasObsidianConfig: boolean;
}

export type VaultStatus =
  | { status: 'loading' }
  | { status: 'picker'; error?: string }
  | { status: 'ready'; vault: VaultInfo };

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

/**
 * 시작할 때 한 번: 마지막 보관함이 아직 열리면 바로 준비 상태, 아니면 선택 화면.
 * 폴더가 지워졌거나 옮겨졌거나 파일이 됐거나 설정이 깨졌을 때 Rust 는 null 을 준다.
 * 호출 자체가 실패해도 앱은 선택 화면으로 뜬다 — 시작을 막지 않는다.
 */
export async function restoreVault(invoke: InvokeFn = tauriInvoke): Promise<VaultStatus> {
  try {
    const vault = await invoke<VaultInfo | null>('vault_current', {});
    return vault ? { status: 'ready', vault } : { status: 'picker' };
  } catch {
    return { status: 'picker' };
  }
}

/** 고른 폴더를 열거나(`vault_open`) 새로 만들어 연다(`vault_create`). 거부되면 선택 화면에 남고 사용자에게 보일 문구를 준다. */
async function enter(invoke: InvokeFn, cmd: 'vault_open' | 'vault_create', path: string): Promise<VaultStatus> {
  try {
    const vault = await invoke<VaultInfo>(cmd, { path });
    return { status: 'ready', vault };
  } catch (e) {
    const kind = e && typeof e === 'object' && 'kind' in e ? (e as { kind: unknown }).kind : undefined;
    const missing = kind === 'vaultNotFound' || kind === 'notFound';
    return { status: 'picker', error: t(missing ? 'vault.error.missing' : 'vault.error.generic') };
  }
}

export function openVault(invoke: InvokeFn, path: string): Promise<VaultStatus> {
  return enter(invoke, 'vault_open', path);
}

/** 저장 대화상자가 고른 경로에 폴더 하나를 만들고 연다. 상위 폴더는 이미 있어야 한다. */
export function createVault(invoke: InvokeFn, path: string): Promise<VaultStatus> {
  return enter(invoke, 'vault_create', path);
}

export function useVault(invoke: InvokeFn = tauriInvoke) {
  const [state, setState] = useState<VaultStatus>({ status: 'loading' });

  useEffect(() => {
    let live = true;
    restoreVault(invoke).then((s) => {
      if (live) setState(s);
    });
    return () => {
      live = false;
    };
  }, [invoke]);

  const open = useCallback(
    async (path: string) => {
      setState(await openVault(invoke, path));
    },
    [invoke],
  );

  const create = useCallback(
    async (path: string) => {
      setState(await createVault(invoke, path));
    },
    [invoke],
  );

  return { state, open, create };
}
