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

/**
 * 바뀐 경로 중 하나가 `dir`(vault-relative POSIX) 안이거나, `dir` 자체거나, 그 위 폴더인가. 대소문자는 가리지 않는다(Windows).
 * Workflows 패널이 카탈로그 폴더가 밖에서 바뀌었을 때(git pull, 다른 편집기) 카탈로그를 다시 읽는 데 쓴다.
 */
export function touchesDir(paths: readonly string[], dir: string): boolean {
  const d = dir.toLowerCase();
  return paths.some((path) => {
    const p = path.toLowerCase();
    return p === d || p.startsWith(`${d}/`) || d.startsWith(`${p}/`);
  });
}
