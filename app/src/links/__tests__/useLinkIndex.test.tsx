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
    const { rerender, unmount } = renderHook(
      ({ root, rebuild }: { root: string; rebuild: Promise<unknown> | undefined }) => {
        useLinkIndex(root, rebuild, w.listen, api);
        return linkIndex.ready();
      },
      { initialProps: { root: 'D:/one', rebuild: done as Promise<unknown> | undefined } },
    );
    await waitFor(() => expect(linkIndex.ready()).toBe(true));
    rerender({ root: 'D:/two', rebuild: undefined });
    expect(linkIndex.ready()).toBe(false);
    expect(linkIndex.files()).toEqual([]);
    rerender({ root: 'D:/two', rebuild: Promise.resolve() });
    await waitFor(() => expect(linkIndex.ready()).toBe(true));
    unmount();
    expect(linkIndex.ready()).toBe(false);
    expect(linkIndex.files()).toEqual([]);
  });
});
