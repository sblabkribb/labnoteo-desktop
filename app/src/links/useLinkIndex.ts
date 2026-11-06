/**
 * Keeps the app's `linkIndex` loaded for the open vault (plan SP4 Task 6, D1).
 * Clears it on a vault change (during render, so `ready()` is false from the new vault's first render),
 * loads it once the FTS rebuild is done, and follows `vault://changed` through one serial `LinkSync`.
 */
import { useEffect, useMemo, useRef } from 'react';
import { listen as tauriListen } from '@tauri-apps/api/event';
import { createSettler, subscribeVaultChanges, type ListenFn, type VaultChange } from '../vault/useVaultEvents';
import { linkIndex } from './linkIndex';
import { createLinkSync, tauriLinkSource, type LinkSourceApi } from './loadLinks';

export function useLinkIndex(
  root: string,
  rebuildDone: Promise<unknown> | undefined,
  listen: ListenFn = tauriListen as ListenFn,
  api?: LinkSourceApi,
): void {
  const source = useMemo(() => api ?? tauriLinkSource(), [api]);
  // Before anything else of the new vault: no component may see the old vault's links as ready.
  const clearedFor = useRef<string>();
  if (clearedFor.current !== root) {
    clearedFor.current = root;
    linkIndex.clear();
  }
  // One sync per vault and rebuild: its cleanup (vault change, unmount, StrictMode's second run) disposes it,
  // so a load still running for an old vault never writes into the index again.
  useEffect(() => {
    const sync = createLinkSync(linkIndex, source);
    if (rebuildDone) void sync.load(rebuildDone);
    let changes: VaultChange[] = [];
    const settler = createSettler(() => {
      const batch = changes;
      changes = [];
      void sync.apply(batch);
    });
    const unsubscribe = subscribeVaultChanges(listen, (change) => {
      changes.push(change);
      settler.poke();
    });
    return () => {
      settler.cancel();
      unsubscribe();
      sync.dispose();
      linkIndex.clear();
    };
  }, [root, rebuildDone, source, listen]);
}
