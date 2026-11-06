// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SETTLE_MS, VAULT_CHANGED, useVaultEvents, type VaultChange } from '../useVaultEvents';
import { useTree, type TreeEntry } from '../../tree/useTree';

type Handler = (e: { payload: VaultChange }) => void;

function fakeListen() {
  const handlers = new Set<Handler>();
  const unlisten = vi.fn();
  const listen = vi.fn(async (event: string, h: Handler) => {
    expect(event).toBe(VAULT_CHANGED);
    handlers.add(h);
    return () => {
      unlisten();
      handlers.delete(h);
    };
  });
  const emit = (payload: VaultChange) => handlers.forEach((h) => h({ payload }));
  return { listen, emit, unlisten, handlers };
}

describe('보관함 이벤트 훅', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('vault://changed 를 받으면 트리를 새로 고친다', async () => {
    const f = fakeListen();
    const row = (path: string): TreeEntry => ({ path, name: path, isDir: false, depth: 0 });
    let disk = [row('a.md')];
    const invoke = vi.fn(async () => disk) as never;
    const { result } = renderHook(() => {
      const tree = useTree('V', invoke);
      useVaultEvents(tree.reload, f.listen as never);
      return tree;
    });
    await vi.waitFor(() => expect(result.current.entries.map((e) => e.path)).toEqual(['a.md']));

    disk = [row('a.md'), row('b.md')];
    await act(async () => {
      f.emit({ path: 'b.md', kind: 'created' });
      await vi.advanceTimersByTimeAsync(SETTLE_MS);
    });
    await vi.waitFor(() => expect(result.current.entries.map((e) => e.path)).toEqual(['a.md', 'b.md']));
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('몰려 온 이벤트는 한 번의 호출로 합친다', async () => {
    const f = fakeListen();
    const onChange = vi.fn();
    renderHook(() => useVaultEvents(onChange, f.listen as never));
    await vi.waitFor(() => expect(f.handlers.size).toBe(1));
    await act(async () => {
      for (let i = 0; i < 500; i++) f.emit({ path: `n${i}.md`, kind: 'modified' });
      await vi.advanceTimersByTimeAsync(SETTLE_MS - 1);
    });
    expect(onChange).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('언마운트하면 구독을 풀고 대기 중이던 호출도 버린다', async () => {
    const f = fakeListen();
    const onChange = vi.fn();
    const { unmount } = renderHook(() => useVaultEvents(onChange, f.listen as never));
    await vi.waitFor(() => expect(f.handlers.size).toBe(1));
    f.emit({ path: 'a.md', kind: 'modified' });
    unmount();
    expect(f.unlisten).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(SETTLE_MS * 3);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('구독이 끝나기 전에 언마운트해도 구독이 남지 않는다', async () => {
    const unlisten = vi.fn();
    let resolve: (fn: () => void) => void = () => {};
    const listen = vi.fn(() => new Promise<() => void>((r) => (resolve = r)));
    const { unmount } = renderHook(() => useVaultEvents(() => {}, listen as never));
    unmount();
    resolve(unlisten);
    await vi.waitFor(() => expect(unlisten).toHaveBeenCalledTimes(1));
  });
});
