import { invoke as tauriInvoke } from '@tauri-apps/api/core';

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

/**
 * 보관함 파일 하나를 시스템의 기본 앱으로 연다(`vault_open_default`). Rust 가 경로를 보관함 안으로 가두고,
 * 실행 파일과 스크립트(.exe, .ps1, .bat …), 폴더, 없는 파일은 거부한다. JS 의 opener 권한은 URL 만이다(R7).
 */
export function openWithDefaultApp(path: string, invoke: InvokeFn = tauriInvoke): Promise<void> {
  return invoke<void>('vault_open_default', { path });
}

/** 보관함 파일이나 폴더를 탐색기에서 골라 보인다(`vault_reveal`). 보관함 밖은 거부한다. */
export function revealInFolder(path: string, invoke: InvokeFn = tauriInvoke): Promise<void> {
  return invoke<void>('vault_reveal', { path });
}
