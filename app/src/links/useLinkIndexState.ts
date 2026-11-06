/**
 * React view of the app's `linkIndex` (plan SP4 Task 17).
 * `useSyncExternalStore` over the index's coalesced `subscribe`: a component re-renders when the index becomes
 * ready (or is cleared), when the file universe changes (`filesVersion`) or when a note's links change
 * (`linksVersion`). Reads such as `backlinks()` stay cheap because the reverse map is incremental (Task 5).
 */
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { linkIndex, type LinkIndex } from './linkIndex';

export interface LinkIndexState {
  ready: boolean;
  filesVersion: number;
  linksVersion: number;
}

function snapshotOf(index: LinkIndex): string {
  return `${index.ready() ? 1 : 0}:${index.filesVersion}:${index.linksVersion}`;
}

export function useLinkIndexState(index: LinkIndex = linkIndex): LinkIndexState {
  const subscribe = useCallback((fn: () => void) => index.subscribe(fn), [index]);
  const snapshot = useSyncExternalStore(subscribe, () => snapshotOf(index));
  return useMemo(() => {
    const [ready, filesVersion, linksVersion] = snapshot.split(':');
    return { ready: ready === '1', filesVersion: Number(filesVersion), linksVersion: Number(linksVersion) };
  }, [snapshot]);
}
