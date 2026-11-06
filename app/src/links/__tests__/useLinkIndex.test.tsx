// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { StrictMode, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { linkIndex } from '../linkIndex';
import type { LinkSourceApi } from '../loadLinks';
import { useLinkIndex } from '../useLinkIndex';
import type { ListenFn, VaultChange } from '../../vault/useVaultEvents';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));

function source(notes: Record<string, string>): LinkSourceApi {
  return {
    bodies: async () => ({ items: Object.entries(notes).map(([path, body]) => ({ path, body })), next: null }),
    tree: async () => Object.keys(notes).map((path) => ({ path, isDir: false })),
    images: async () => [],
    read: async (path) => {
      if (!(path in notes)) throw { kind: 'notFound' };
      return notes[path];
    },
  };
}

function watcher() {
  const handlers = new Set<(e: { payload: VaultChange }) => void>();
  const listen: ListenFn = async (_event, h) => {
    handlers.add(h);
    return () => {
      handlers.delete(h);
    };
  };
  return { listen, emit: (payload: VaultChange) => handlers.forEach((h) => h({ payload })) };
}

const strict = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;

afterEach(() => {
  linkIndex.clear();
});

describe('useLinkIndex', () => {
  it('loads after the rebuild and follows watcher changes (StrictMode)', async () => {
    const notes: Record<string, string> = { 'a.md': '[[b]]', 'b.md': 'x' };
    const api = source(notes);
    const w = watcher();
    const done = Promise.resolve();
    renderHook(() => useLinkIndex('D:/v', done, w.listen, api), { wrapper: strict });
    await waitFor(() => expect(linkIndex.ready()).toBe(true));
    expect(linkIndex.backlinks('b.md').map((b) => b.source)).toEqual(['a.md']);

    notes['c.md'] = '[[b]]';
    act(() => w.emit({ path: 'c.md', kind: 'created' }));
    await waitFor(() => expect(linkIndex.backlinks('b.md').map((b) => b.source)).toEqual(['a.md', 'c.md']));
  });
  it('is not ready from the first render of a new vault, and clears on unmount', async () => {
    const api = source({ 'a.md': '[[b]]', 'b.md': 'x' });
    const w = watcher();
    const done = Promise.resolve();
    // `ready()` as each render saw it, before that render's effects (and their cleanups) ran
    const seen: { root: string; ready: boolean }[] = [];
    const { result, rerender, unmount } = renderHook(
      ({ root, rebuild }: { root: string; rebuild: Promise<unknown> | undefined }) => {
        useLinkIndex(root, rebuild, w.listen, api);
        const ready = linkIndex.ready();
        seen.push({ root, ready });
        return ready;
      },
      { initialProps: { root: 'D:/one', rebuild: done as Promise<unknown> | undefined } },
    );
    await waitFor(() => expect(linkIndex.ready()).toBe(true));
    rerender({ root: 'D:/two', rebuild: undefined });
    expect(result.current).toBe(false);
    expect(seen.filter((s) => s.root === 'D:/two').map((s) => s.ready)).toEqual([false]);
    expect(linkIndex.ready()).toBe(false);
    expect(linkIndex.files()).toEqual([]);
    rerender({ root: 'D:/two', rebuild: Promise.resolve() });
    await waitFor(() => expect(linkIndex.ready()).toBe(true));
    unmount();
    expect(linkIndex.ready()).toBe(false);
    expect(linkIndex.files()).toEqual([]);
  });
  it("an old vault's load that finishes after a vault switch never writes into the index", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const held = source({ 'old.md': '[[b]]', 'b.md': 'x' });
    const heldApi: LinkSourceApi = {
      ...held,
      bodies: async (after, limit) => {
        await gate;
        return held.bodies(after, limit);
      },
    };
    const w = watcher();
    const { rerender } = renderHook(
      ({ root, rebuild }: { root: string; rebuild: Promise<unknown> | undefined }) =>
        useLinkIndex(root, rebuild, w.listen, heldApi),
      { initialProps: { root: 'D:/old', rebuild: Promise.resolve() as Promise<unknown> | undefined } },
    );
    await new Promise((r) => setTimeout(r, 0)); // the old load is waiting on its body page
    rerender({ root: 'D:/new', rebuild: undefined });
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(linkIndex.files()).toEqual([]);
    expect(linkIndex.ready()).toBe(false);
  });
});
