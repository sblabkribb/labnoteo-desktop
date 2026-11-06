import { useEffect, useRef } from 'react';
import { listen as tauriListen, type UnlistenFn } from '@tauri-apps/api/event';

/** Rust 의 `Change`. `path` 는 vault-relative POSIX; 빈 문자열이면 "무엇이 바뀌었는지 놓쳤다 — 전부 다시 보라"는 뜻이다. */
export interface VaultChange {
  path: string;
  kind: 'created' | 'modified' | 'removed';
}

export const VAULT_CHANGED = 'vault://changed';

export type ListenFn = (
  event: string,
  handler: (e: { payload: VaultChange }) => void,
) => Promise<UnlistenFn>;

/** git pull 은 수천 개의 이벤트를 한꺼번에 보낸다: 마지막 이벤트 뒤 이만큼 조용하면 한 번만 부른다. */
export const SETTLE_MS = 100;

/**
 * 보관함 밖에서 파일이 바뀌면(Rust 가 200ms 디바운스 후 보낸다) `onChange` 를 부른다.
 * 이벤트가 몰려 와도 한 번만 부르고, 마운트가 끝나면 구독과 대기 중인 호출을 모두 거둔다.
 */
export function useVaultEvents(onChange: () => void, listen: ListenFn = tauriListen as ListenFn) {
  const latest = useRef(onChange);
  latest.current = onChange;

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unlisten: UnlistenFn | undefined;
    listen(VAULT_CHANGED, () => {
      if (!live) return;
      clearTimeout(timer);
      timer = setTimeout(() => live && latest.current(), SETTLE_MS);
    }).then(
      (fn) => (live ? (unlisten = fn) : fn()),
      () => undefined, // 감시가 없어도 앱은 쓸 수 있다: 다시 열 때 트리를 읽는다.
    );
    return () => {
      live = false;
      clearTimeout(timer);
      unlisten?.();
    };
  }, [listen]);
}
