import { useEffect, useRef } from 'react';
import { listen as tauriListen, type UnlistenFn } from '@tauri-apps/api/event';
import { vaultImages } from '../editor/live/vaultImages';

/** Rust 의 `Change`. `path` 는 vault-relative POSIX; 빈 문자열이면 "무엇이 바뀌었는지 놓쳤다 — 전부 다시 보라"는 뜻이다. */
export interface VaultChange {
  path: string;
  kind: 'created' | 'modified' | 'removed';
}

export const VAULT_CHANGED = 'vault://changed';

/** Rust 의 `LABSAMPLES_EVENT`: 샘플 레지스트리(`<…>/labsamples/<name>.json`)가 밖에서 바뀌었다. 노트가 아니라 트리·색인에는 없다. 페이로드는 `VaultChange` 와 같다. */
export const VAULT_LABSAMPLES_CHANGED = 'vault://labsamples-changed';

export type ListenFn = (
  event: string,
  handler: (e: { payload: VaultChange }) => void,
) => Promise<UnlistenFn>;

/** git pull 은 수천 개의 이벤트를 한꺼번에 보낸다: 마지막 이벤트 뒤 이만큼 조용하면 한 번만 부른다. */
export const SETTLE_MS = 100;

/**
 * 이벤트가 끝없이 이어져도(긴 동기화) 첫 이벤트로부터 이만큼 안에는 한 번 부른다.
 * Rust 쪽 `MAX_WAIT` 과 같은 이유다: 바쁜 폴더가 트리 새로 고침을 끝없이 미루면 안 된다.
 */
export const MAX_SETTLE_MS = 1000;

/**
 * 이벤트 묶음을 한 번의 호출로 모은다: 마지막 이벤트 뒤 `SETTLE_MS` 조용하면, 끝없이 이어지면 첫 이벤트로부터
 * `MAX_SETTLE_MS` 안에 `fire` 를 부른다. `useVaultEvents` 와 Workflows 패널의 `useVaultChanges` 가 같이 쓴다.
 */
export function createSettler(fire: () => void): { poke(): void; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let burstStart: number | undefined; // 아직 알리지 않은 첫 이벤트의 시각
  return {
    poke() {
      clearTimeout(timer);
      const now = Date.now();
      burstStart ??= now;
      const wait = Math.min(SETTLE_MS, Math.max(0, burstStart + MAX_SETTLE_MS - now));
      timer = setTimeout(() => {
        burstStart = undefined;
        fire();
      }, wait);
    },
    cancel() {
      clearTimeout(timer);
      burstStart = undefined;
    },
  };
}

/**
 * `event`(기본 `vault://changed`)를 구독해 각 변경을 `onEvent` 로 넘긴다. 돌려준 함수가 구독을 거둔다(구독이 늦게 끝나도).
 * 감시가 없어도(구독 실패) 조용히 지나간다: 앱은 쓸 수 있고, 다시 열 때 다시 읽는다.
 */
export function subscribeVaultChanges(
  listen: ListenFn,
  onEvent: (change: VaultChange) => void,
  event: string = VAULT_CHANGED,
): () => void {
  let live = true;
  let unlisten: UnlistenFn | undefined;
  listen(event, (e) => {
    if (live) onEvent(e.payload);
  }).then(
    (fn) => (live ? (unlisten = fn) : fn()),
    () => undefined,
  );
  return () => {
    live = false;
    unlisten?.();
  };
}

/**
 * 이 묶음이 트리의 모양을 바꿀 수 있는가. 노트가 아닌 파일(그림, 표, 첨부)의 `modified` 만 있으면 줄이 그대로이므로 아니다(명세 §10.3).
 * 감시(watcher.rs)는 이름 바꾸기를 `removed` + `created` 로 보내고 폴더를 `modified` 로 보내지 않는다. `.md` 는 제목·종류가 바뀔 수 있어
 * 다시 읽고, 빈 경로(Rust 의 "다시 훑어라")도 다시 읽는다.
 */
export function changesTreeShape(changes: readonly VaultChange[]): boolean {
  return !changes.every((c) => c.kind === 'modified' && c.path !== '' && !/\.md$/i.test(c.path));
}

/**
 * 보관함 밖에서 파일이 바뀌면(Rust 가 200ms 디바운스 후 보낸다) 트리 모양이 바뀔 수 있을 때 `onChange` 를 부른다. 그 전에 바뀐 경로들을
 * `vaultImages.onChanged` 에 넘겨 이름 색인을 버리고(묶음마다) 지워진 이미지의 blob: URL 을 거둔다.
 * 이벤트가 몰려 와도 한 번만 부르되(끝없이 이어지면 `MAX_SETTLE_MS` 마다), 마운트가 끝나면 구독과 대기 중인 호출을 모두 거둔다.
 */
export function useVaultEvents(onChange: () => void, listen: ListenFn = tauriListen as ListenFn) {
  const latest = useRef(onChange);
  latest.current = onChange;

  useEffect(() => {
    // 한 묶음에서 바뀐 것들: 이름 색인은 묶음마다 버리고, 이미지 캐시는 그 이미지 경로만 버린다('' 이면 모두).
    // 트리는 모양이 바뀔 수 있을 때만 다시 읽는다(노트가 아닌 파일의 수정만이면 건너뛴다).
    let batch: VaultChange[] = [];
    const settler = createSettler(() => {
      const changed = batch;
      batch = [];
      vaultImages.onChanged(changed.map((c) => c.path));
      if (changesTreeShape(changed)) latest.current();
    });
    const unsubscribe = subscribeVaultChanges(listen, (change) => {
      batch.push(change);
      settler.poke();
    });
    return () => {
      settler.cancel();
      unsubscribe();
    };
  }, [listen]);
}
