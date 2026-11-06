import { useCallback, useEffect, useState } from 'react';
import { invoke as tauriInvoke } from '@tauri-apps/api/core';

/** Rust 의 `TreeEntry` 직렬화 모양(camelCase). `path` 는 vault-relative POSIX 경로다. */
export interface TreeEntry {
  path: string;
  name: string;
  isDir: boolean;
  depth: number;
}

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

/** 보관함의 노트 트리를 평평한 깊이 우선 목록으로 가져온다. */
export function fetchTree(invoke: InvokeFn = tauriInvoke): Promise<TreeEntry[]> {
  return invoke<TreeEntry[]>('vault_tree', {});
}

/** `vaultKey` 가 바뀔 때마다(다른 보관함을 열었을 때) 트리를 다시 읽는다. */
export function useTree(vaultKey: string, invoke: InvokeFn = tauriInvoke) {
  const [entries, setEntries] = useState<TreeEntry[]>([]);
  const [failed, setFailed] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let live = true;
    // 다른 보관함의 줄을 새 걸음이 끝날 때까지 남겨 두면 존재하지 않는 경로가 선택될 수 있다.
    setEntries([]);
    setFailed(false);
    fetchTree(invoke).then(
      (e) => live && setEntries(e),
      () => live && (setEntries([]), setFailed(true)),
    );
    return () => {
      live = false;
    };
  }, [vaultKey, invoke, version]);

  const reload = useCallback(() => setVersion((v) => v + 1), []);
  return { entries, failed, reload };
}
