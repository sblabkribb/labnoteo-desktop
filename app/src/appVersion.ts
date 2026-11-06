import { invoke as tauriInvoke } from '@tauri-apps/api/core';

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

/** 앱 버전. 못 읽으면 빈 문자열: 화면 표시용일 뿐이라 시작을 막지 않는다. */
export async function fetchAppVersion(invoke: InvokeFn = tauriInvoke): Promise<string> {
  try {
    return await invoke<string>('app_version', {});
  } catch {
    return '';
  }
}
