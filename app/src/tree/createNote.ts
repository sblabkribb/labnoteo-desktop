import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { ERROR_KINDS, hasErrorKind } from '../fs/errorKinds';

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

/** 이 앱이 만드는 노트의 확장자. 트리는 `.md` 전부를 보이지만, 새 노트는 언제나 이 확장자다. */
export const NOTE_EXT = '.labnote.md';

export type CreateFailure = 'empty' | 'separator' | 'invalid' | 'exists' | 'failed';
export type CreateResult = { ok: true; path: string } | { ok: false; reason: CreateFailure };

/** 사용자가 쓴 이름에서 확장자(`.labnote.md` 또는 `.md`)와 앞뒤 공백을 뗀 몸통. */
function stemOf(input: string): string {
  return input
    .trim()
    .replace(/\.labnote\.md$/i, '')
    .replace(/\.md$/i, '');
}

/** 사용자가 쓴 이름 → 파일 이름. 확장자는 한 번만 붙는다. */
export function noteFileName(input: string): string {
  return stemOf(input) + NOTE_EXT;
}

/**
 * 보관함 맨 위(또는 `dir` 폴더 안)에 빈 노트를 만든다. `dir` 은 트리가 준 vault-relative 경로이고, 구분자 규칙은 이름에만 적용된다. 경로 규칙(이탈, Windows 금지 이름, `.obsidian`)은 Rust 의
 * `confine` 이 정하고 여기서는 다시 구현하지 않는다 — 그 거절(`escape`/`forbidden`)을 말로 바꿀 뿐이다.
 * 여기서 직접 막는 것은 `confine` 이 막지 않는 두 가지다: `/` (하위 폴더가 만들어진다)와
 * 점으로 시작하는 이름(트리가 숨겨서 만든 노트가 안 보인다).
 *
 * 같은 이름 확인은 `vault_exists` 로 하고(NTFS 라 대소문자 무관), 쓰기는 `vault_modify` 에
 * `expectedBefore: ''` 로 보낸다: 확인과 쓰기 사이에 내용이 있는 노트가 생기면 Rust 가 경로 잠금
 * 안에서 Conflict 로 돌려주고 덮어쓰지 않는다. (`vault_write` 는 덮어쓰므로 쓰지 않는다.)
 */
export async function createNote(input: string, invoke: InvokeFn = tauriInvoke, dir = ''): Promise<CreateResult> {
  const stem = stemOf(input);
  if (stem === '') return { ok: false, reason: 'empty' };
  if (stem.includes('/') || stem.includes('\\')) return { ok: false, reason: 'separator' };
  if (stem.startsWith('.')) return { ok: false, reason: 'invalid' };

  const path = dir ? `${dir}/${stem}${NOTE_EXT}` : stem + NOTE_EXT;
  try {
    if (await invoke<boolean>('vault_exists', { path })) return { ok: false, reason: 'exists' };
    const result = await invoke<{ kind: 'ok' } | { kind: 'conflict' }>('vault_modify', {
      path,
      content: '',
      expectedBefore: '',
    });
    return result.kind === 'ok' ? { ok: true, path } : { ok: false, reason: 'exists' };
  } catch (e) {
    const refused = hasErrorKind(e, ERROR_KINDS.escape) || hasErrorKind(e, ERROR_KINDS.forbidden);
    return { ok: false, reason: refused ? 'invalid' : 'failed' };
  }
}
