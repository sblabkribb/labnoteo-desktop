// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { MAX_SETTLE_MS, SETTLE_MS, type VaultChange } from '../../../vault/useVaultEvents';
import { useVaultChanges } from '../useVaultChanges';

type Handler = (e: { payload: VaultChange }) => void;

function fakeListen() {
  const handlers = new Set<Handler>();
  const listen = vi.fn(async (_event: string, h: Handler) => {
    handlers.add(h);
    return () => void handlers.delete(h);
  });
  const emit = (path: string) => handlers.forEach((h) => h({ payload: { path, kind: 'modified' } }));
  return { listen, emit, handlers };
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
});
