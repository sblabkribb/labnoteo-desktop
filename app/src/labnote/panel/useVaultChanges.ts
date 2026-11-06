import { useEffect, useRef } from 'react';
import { listen as tauriListen } from '@tauri-apps/api/event';
import { createSettler, subscribeVaultChanges, type ListenFn } from '../../vault/useVaultEvents';

/**
 * 보관함 밖의 변경을 `useVaultEvents` 와 같은 간격으로 모아, 바뀐 경로들(한 번씩, 받은 순서)과 함께 부른다.
 * 빈 경로(Rust 가 무엇이 바뀌었는지 놓쳤다)가 하나라도 섞이면 'all' 이다. Workflows 패널이 바뀐 실험만 다시 읽는 데 쓴다.
 */
export function useVaultChanges(onChanges: (paths: string[] | 'all') => void, listen: ListenFn = tauriListen as ListenFn): void {
  const latest = useRef(onChanges);
  latest.current = onChanges;

  useEffect(() => {
    let paths = new Set<string>();
    let all = false;
    const settler = createSettler(() => {
      const out: string[] | 'all' = all ? 'all' : [...paths];
      paths = new Set();
      all = false;
      latest.current(out);
    });
    const unsubscribe = subscribeVaultChanges(listen, (change) => {
      if (change.path === '') all = true;
      else paths.add(change.path);
      settler.poke();
    });
    return () => {
      settler.cancel();
      unsubscribe();
    };
  }, [listen]);
}
