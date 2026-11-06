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
