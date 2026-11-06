import { invoke as tauriInvoke } from '@tauri-apps/api/core';

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

/**
 * 보관함 이미지 한 장의 바이트(`vault_read_image`). Rust 가 경로를 보관함 안으로 가두고,
 * 이미지 확장자가 아니면 `notImage`, 20 MiB 를 넘으면 `tooLarge` 로 거부한다(`ERROR_KINDS`).
 * 응답은 JSON 이 아니라 원시 바이트라 ArrayBuffer 로 온다.
 */
export function readVaultImage(path: string, invoke: InvokeFn = tauriInvoke): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>('vault_read_image', { path });
}

/** 보관함의 모든 이미지 경로('/' 구분, 정렬). 점 폴더와 링크는 건너뛴다(`vault_list_images`). */
export function listVaultImages(invoke: InvokeFn = tauriInvoke): Promise<string[]> {
  return invoke<string[]>('vault_list_images', {});
}
