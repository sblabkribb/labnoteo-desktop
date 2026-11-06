// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SETTLE_MS, VAULT_CHANGED, useVaultEvents, type VaultChange } from '../useVaultEvents';
import { EVENTS_FIXTURE } from '../../__tests__/fixtures';
import { useTree, type TreeEntry } from '../../tree/useTree';

// 공유 픽스처. Rust 쪽 tests/ipc.rs 가 같은 파일을 읽어 `EVENT` 가 이 문자열인지 본다.
// 두 언어가 각자 자기 상수만 비교하면 한쪽 오타가 모든 테스트를 통과한다.
const EVENT_NAME: string = EVENTS_FIXTURE.vaultChanged.name;

type Handler = (e: { payload: VaultChange }) => void;

function fakeListen() {
  const handlers = new Set<Handler>();
  const unlisten = vi.fn();
  const listen = vi.fn(async (event: string, h: Handler) => {
    expect(event).toBe(EVENT_NAME);
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

  it('구독하는 이벤트 이름은 Rust 가 보내는 이름과 같다', () => {
    expect(EVENT_NAME).toBe('vault://changed');
    expect(VAULT_CHANGED).toBe(EVENT_NAME);
  });

  it('vault://changed 를 받으면 트리를 새로 고친다', async () => {
    const f = fakeListen();
    const row = (path: string): TreeEntry => ({ path, name: path, isDir: false, depth: 0 });
    let finish: (v: TreeEntry[]) => void = () => {};
    let calls = 0;
    const invoke = vi.fn(async () => {
      if (calls++ === 0) return [row('a.md')];
      return new Promise<TreeEntry[]>((r) => (finish = r));
    }) as never;
    const { result } = renderHook(() => {
      const tree = useTree('V', invoke);
      useVaultEvents(tree.reload, f.listen as never);
      return tree;
    });
    await vi.waitFor(() => expect(result.current.entries.map((e) => e.path)).toEqual(['a.md']));

    await act(async () => {
      f.emit({ path: 'b.md', kind: 'created' });
      await vi.advanceTimersByTimeAsync(SETTLE_MS);
    });
    // 새 목록이 오기 전에 이미 다시 읽기를 시작했고, 그 사이 줄은 비지 않는다.
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(result.current.entries.map((e) => e.path)).toEqual(['a.md']);
    await act(async () => finish([row('a.md'), row('b.md')]));
    await vi.waitFor(() => expect(result.current.entries.map((e) => e.path)).toEqual(['a.md', 'b.md']));
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
