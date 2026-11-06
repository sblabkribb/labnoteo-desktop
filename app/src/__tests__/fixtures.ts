import { readFileSync } from 'node:fs';

/** Rust 와 공유하는 픽스처. 두 언어가 각자 자기 상수만 비교하면 한쪽 오타가 모든 테스트를 통과한다. */
function load<T>(name: string): T {
  return JSON.parse(readFileSync(`src-tauri/tests/${name}`, 'utf-8')) as T;
}

/** `FsError` 의 `kind` 값. 키는 의미, 값은 Rust 가 선으로 보내는 문자열. */
export const ERROR_KINDS_FIXTURE = load<Record<string, string>>('ipc-errors.json');

export const EVENTS_FIXTURE = load<{
  vaultChanged: {
    name: string;
    payload: { fields: Record<'path' | 'kind', string>; kinds: Record<'created' | 'modified' | 'removed', string> };
  };
}>('ipc-events.json');

/**
 * `VaultView` 가 열릴 때마다 부르는 커맨드(보관함별 설정)에 답한다: 저장된 설정 없음, 가져올 data.json 없음, 저장 성공.
 * 그 밖의 커맨드에는 `undefined` 를 돌려주므로, 부르는 쪽은 이 뒤에 자기 "unexpected command" 던지기를 그대로 둔다.
 */
export function baseInvoke(cmd: string, _args?: unknown): unknown {
  if (cmd === 'settings_vault_read' || cmd === 'settings_import_plugin' || cmd === 'settings_vault_write') return null;
  return undefined;
}
