// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import {
  MAX_SETTLE_MS,
  SETTLE_MS,
  VAULT_CHANGED,
  VAULT_LABSAMPLES_CHANGED,
  type VaultChange,
} from '../../../vault/useVaultEvents';
import { touchesDir, useVaultChanges } from '../useVaultChanges';

type Handler = (e: { payload: VaultChange }) => void;

function fakeListen() {
  const handlers = new Set<Handler>();
  const byEvent = new Map<string, Set<Handler>>();
  const listen = vi.fn(async (event: string, h: Handler) => {
    handlers.add(h);
    const set = byEvent.get(event) ?? new Set<Handler>();
    set.add(h);
    byEvent.set(event, set);
    return () => {
      handlers.delete(h);
      set.delete(h);
    };
  });
  const emitOn = (event: string, path: string) =>
    byEvent.get(event)?.forEach((h) => h({ payload: { path, kind: 'modified' } }));
  const emit = (path: string) => emitOn(VAULT_CHANGED, path);
  return { listen, emit, emitOn, handlers };
}

describe('useVaultChanges', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('a burst arrives once, after it settles, with every changed path once', async () => {
    const f = fakeListen();
    const onChanges = vi.fn();
    renderHook(() => useVaultChanges(onChanges, f.listen as never));
    await act(async () => undefined);
    f.emit('labnote/001_A/README.labnote.md');
    f.emit('labnote/002_B/x.labnote.md');
    f.emit('labnote/001_A/README.labnote.md');
    await act(async () => void (await vi.advanceTimersByTimeAsync(SETTLE_MS - 1)));
    expect(onChanges).not.toHaveBeenCalled();
    await act(async () => void (await vi.advanceTimersByTimeAsync(1)));
    expect(onChanges).toHaveBeenCalledTimes(1);
    expect(onChanges).toHaveBeenCalledWith(['labnote/001_A/README.labnote.md', 'labnote/002_B/x.labnote.md']);
  });

  it("an empty path (Rust lost track) means 'all'", async () => {
    const f = fakeListen();
    const onChanges = vi.fn();
    renderHook(() => useVaultChanges(onChanges, f.listen as never));
    await act(async () => undefined);
    f.emit('a.md');
    f.emit('');
    await act(async () => void (await vi.advanceTimersByTimeAsync(SETTLE_MS)));
    expect(onChanges).toHaveBeenCalledWith('all');
  });

  it('an endless stream still reports within MAX_SETTLE_MS, and unmount unsubscribes', async () => {
    const f = fakeListen();
    const onChanges = vi.fn();
    const { unmount } = renderHook(() => useVaultChanges(onChanges, f.listen as never));
    await act(async () => undefined);
    for (let t = 0; t < MAX_SETTLE_MS + 200; t += 50) {
      f.emit(`n${t}.md`);
      await act(async () => void (await vi.advanceTimersByTimeAsync(50)));
    }
    expect(onChanges).toHaveBeenCalled();
    unmount();
    expect(f.handlers.size).toBe(0);
  });

  it('with { labsamples: true } registry JSON changes come through the same batching; without it that event is not subscribed', async () => {
    const f = fakeListen();
    const onChanges = vi.fn();
    const { unmount } = renderHook(() => useVaultChanges(onChanges, f.listen as never, { labsamples: true }));
    await act(async () => undefined);
    expect(f.listen.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining([VAULT_CHANGED, VAULT_LABSAMPLES_CHANGED]));
    f.emitOn(VAULT_LABSAMPLES_CHANGED, 'resources/labsamples/DNA.json');
    await act(async () => void (await vi.advanceTimersByTimeAsync(SETTLE_MS)));
    expect(onChanges).toHaveBeenCalledTimes(1);
    expect(onChanges).toHaveBeenCalledWith(['resources/labsamples/DNA.json']);
    unmount();
    expect(f.handlers.size).toBe(0);

    const g = fakeListen();
    renderHook(() => useVaultChanges(vi.fn(), g.listen as never));
    await act(async () => undefined);
    expect(g.listen.mock.calls.map((c) => c[0])).toEqual([VAULT_CHANGED]);
  });
});

describe('touchesDir', () => {
  it('is true for a path inside the directory, the directory itself or an ancestor, ignoring case', () => {
    expect(touchesDir(['resources/workflows/workflows.json'], 'resources/workflows')).toBe(true);
    expect(touchesDir(['Resources/Workflows/hw.json'], 'resources/workflows')).toBe(true);
    expect(touchesDir(['resources/workflows'], 'resources/workflows')).toBe(true);
    expect(touchesDir(['resources'], 'resources/workflows')).toBe(true);
    expect(touchesDir(['labnote/001_A/README.labnote.md'], 'resources/workflows')).toBe(false);
    expect(touchesDir(['resources/workflows-old/x.json'], 'resources/workflows')).toBe(false);
    expect(touchesDir([], 'resources/workflows')).toBe(false);
  });
});
