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

/** 원시 본문과 헤더를 보낼 수 있는 invoke(`@tauri-apps/api/core` 의 invoke 와 호환). */
export type RawInvoke = <T>(
  cmd: string,
  args?: Record<string, unknown> | Uint8Array,
  options?: { headers?: Record<string, string> },
) => Promise<T>;

/**
 * 붙여 넣거나 끌어 놓은 이미지를 보관함 폴더 `dir` 에 새 파일로 쓴다(`vault_write_image`).
 * 바이트는 JSON 배열이 아니라 원시 본문으로, 폴더와 이름은 퍼센트 인코딩한 헤더로 보낸다
 * (헤더 값은 ASCII 만 되므로 한글 이름도 이렇게 실린다). Rust 가 이름을 검사하고 기존 파일을
 * 절대 덮어쓰지 않으며(`이름 1.png` .. `이름 99.png`), 실제로 쓴 보관함 경로를 돌려준다.
 */
export function writeVaultImage(
  dir: string,
  name: string,
  bytes: Uint8Array,
  invoke: RawInvoke = tauriInvoke as RawInvoke,
): Promise<string> {
  return invoke<string>('vault_write_image', bytes, {
    headers: { 'x-lno-dir': encodeURIComponent(dir), 'x-lno-name': encodeURIComponent(name) },
  });
}
