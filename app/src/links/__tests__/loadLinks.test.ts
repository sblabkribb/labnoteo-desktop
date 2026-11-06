import { beforeEach, describe, expect, it, vi } from 'vitest';
import { linkIndex } from '../linkIndex';
import { applyChanges, createLinkSync, loadAll, type LinkSourceApi } from '../loadLinks';
import type { BodyPage } from '../../search/indexApi';

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const key = (p: string) => p.toLowerCase();
const byKey = (a: string, b: string) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);

/** A LinkSourceApi over an in-memory note map, paged by key like Rust `index_bodies`. */
function fakeApi(notes: Record<string, string>, images: string[], opts: { tree?: { path: string; isDir: boolean }[] } = {}) {
  const state = { notes: { ...notes }, images: [...images] };
  const api = {
    calls: { bodies: 0, read: [] as string[] },
    failBodies: false,
    bodiesOnly: undefined as string[] | undefined,
    holdBodies: undefined as Promise<void> | undefined,
    add(path: string, text: string) {
      state.notes[path] = text;
    },
    remove(path: string) {
      delete state.notes[path];
    },
    addImage(path: string) {
      state.images.push(path);
    },
    async bodies(after: string | null, limit: number): Promise<BodyPage> {
      api.calls.bodies++;
      if (api.failBodies) throw new Error('no fts');
      const only = api.bodiesOnly?.map(key);
      const page = Object.entries(state.notes)
        .filter(([p]) => !only || only.includes(key(p)))
        .map(([p, body]) => ({ k: key(p), path: p, body }))
        .filter((n) => after === null || n.k > after)
        .sort((x, y) => (x.k < y.k ? -1 : x.k > y.k ? 1 : 0))
        .slice(0, limit);
      if (api.holdBodies) await api.holdBodies;
      return {
        items: page.map(({ path, body }) => ({ path, body })),
        next: page.length === limit ? page[page.length - 1].k : null,
      };
    },
    async tree() {
      if (opts.tree) return opts.tree;
      const dirs = new Set<string>();
      for (const p of Object.keys(state.notes)) {
        const parts = p.split('/');
        for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
      }
      return [
        ...[...dirs].map((path) => ({ path, isDir: true })),
        ...Object.keys(state.notes).map((path) => ({ path, isDir: false })),
      ].sort((a, b) => byKey(a.path, b.path));
    },
    async images() {
      return [...state.images].sort(byKey);
    },
    async read(path: string) {
      api.calls.read.push(path);
      const text = state.notes[path];
      if (text === undefined) throw { kind: 'notFound', message: path };
      return text;
    },
  };
  const typed: LinkSourceApi = api;
  void typed;
  return api;
}

describe('loadLinks', () => {
  let api: ReturnType<typeof fakeApi>;
  beforeEach(async () => {
    linkIndex.clear();
    api = fakeApi({ 'a.md': '[[b]]', 'b.md': 'x', 'c.md': '[[b]]' }, ['img/p.png']);
    await loadAll(linkIndex, api);
  });
  it('loads every body page, then is ready', () => {
    expect(linkIndex.ready()).toBe(true);
    expect(linkIndex.backlinks('b.md').map((b) => b.source)).toEqual(['a.md', 'c.md']);
    expect(linkIndex.files()).toContain('img/p.png');
    expect(api.calls.bodies).toBe(1); // 3 notes < BODY_PAGE
  });
  it('pages through more notes than one page holds', async () => {
    const many = Object.fromEntries(
      Array.from({ length: 450 }, (_, i) => [`n${String(i).padStart(3, '0')}.md`, '[[b]]']),
    );
    const big = fakeApi({ ...many, 'b.md': 'x' }, []);
    await loadAll(linkIndex, big);
    expect(big.calls.bodies).toBe(3);
    expect(big.calls.read).toEqual([]);
    expect(linkIndex.backlinks('b.md')).toHaveLength(450);
  });
  it('applies created, modified and removed paths', async () => {
    api.add('a.md', 'none');
    api.add('d.md', '[[b]]');
    api.remove('c.md');
    await applyChanges(linkIndex, api, [
      { path: 'a.md', kind: 'modified' },
      { path: 'd.md', kind: 'created' },
      { path: 'c.md', kind: 'removed' },
    ]);
    expect(linkIndex.backlinks('b.md').map((b) => b.source)).toEqual(['d.md']);
  });
  it('a created folder reads the notes under it; a removed folder drops them', async () => {
    api.add('f/x.md', '[[b]]');
    await applyChanges(linkIndex, api, [{ path: 'f', kind: 'created' }]);
    expect(linkIndex.backlinks('b.md').map((b) => b.source)).toContain('f/x.md');
    await applyChanges(linkIndex, api, [{ path: 'f', kind: 'removed' }]);
    expect(linkIndex.backlinks('b.md').map((b) => b.source)).not.toContain('f/x.md');
  });
  it('classifies image paths as images, not folders', async () => {
    api.addImage('img/q.png');
    await applyChanges(linkIndex, api, [{ path: 'img/q.png', kind: 'created' }]);
    expect(linkIndex.files()).toContain('img/q.png');
    await applyChanges(linkIndex, api, [{ path: 'img/q.png', kind: 'removed' }]);
    expect(linkIndex.files()).not.toContain('img/q.png');
  });
  it('a created folder also refreshes images', async () => {
    api.addImage('g/r.png');
    await applyChanges(linkIndex, api, [{ path: 'g', kind: 'created' }]);
    expect(linkIndex.files()).toContain('g/r.png');
  });
  it('an empty path reloads everything', async () => {
    await applyChanges(linkIndex, api, [{ path: '', kind: 'modified' }]);
    expect(api.calls.bodies).toBe(2);
  });
  it('a read that fails with notFound removes the note', async () => {
    linkIndex.addFiles(['gone.md']);
    linkIndex.setNote('gone.md', '[[b]]');
    expect(linkIndex.backlinks('b.md').map((b) => b.source)).toContain('gone.md');
    await applyChanges(linkIndex, api, [{ path: 'gone.md', kind: 'modified' }]);
    expect(linkIndex.files()).not.toContain('gone.md');
    expect(linkIndex.backlinks('b.md').map((b) => b.source)).not.toContain('gone.md');
  });
  it('skips body page entries that vault_tree does not list', async () => {
    const ghost = fakeApi({ 'a.md': '[[b]]', 'b.md': 'x', 'ghost.md': '[[b]]' }, [], {
      tree: [
        { path: 'a.md', isDir: false },
        { path: 'b.md', isDir: false },
      ],
    });
    await loadAll(linkIndex, ghost);
    expect(linkIndex.files()).not.toContain('ghost.md');
    expect(linkIndex.backlinks('b.md').map((b) => b.source)).toEqual(['a.md']);
  });
  it('a removed note that exists again on disk keeps its links', async () => {
    // remove + re-create collapsed by the watcher, or a removal reported late
    await applyChanges(linkIndex, api, [{ path: 'a.md', kind: 'removed' }]);
    expect(linkIndex.files()).toContain('a.md');
    expect(linkIndex.backlinks('b.md').map((b) => b.source)).toEqual(['a.md', 'c.md']);
  });
  it('the completion pass retries a failed read once before ready', async () => {
    api.failBodies = true;
    const read = vi.spyOn(api, 'read').mockRejectedValueOnce({ kind: 'io', message: 'locked' });
    await loadAll(linkIndex, api);
    expect(read.mock.calls.filter(([p]) => p === 'a.md')).toHaveLength(2);
    expect(linkIndex.backlinks('b.md').map((b) => b.source)).toEqual(['a.md', 'c.md']);
  });
  it('warns about notes the completion pass could not read', async () => {
    api.failBodies = true;
    const real = api.read.bind(api);
    vi.spyOn(api, 'read').mockImplementation(async (p: string) => {
      if (p === 'a.md') throw { kind: 'io', message: 'locked' };
      return real(p);
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await loadAll(linkIndex, api);
    expect(linkIndex.ready()).toBe(true);
    expect(warn.mock.calls.some((c) => JSON.stringify(c).includes('a.md'))).toBe(true);
    warn.mockRestore();
  });
  it('warns when a created folder cannot be listed', async () => {
    vi.spyOn(api, 'tree').mockRejectedValueOnce(new Error('tree failed'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await applyChanges(linkIndex, api, [{ path: 'f', kind: 'created' }]);
    expect(warn.mock.calls.some((c) => JSON.stringify(c).includes('f'))).toBe(true);
    warn.mockRestore();
  });
  it('a read that fails otherwise keeps what the index had', async () => {
    api.add('a.md', 'none'); // a successful read would drop a.md's link
    const read = vi
      .spyOn(api, 'read')
      .mockRejectedValueOnce({ kind: 'io', message: 'locked' })
      .mockRejectedValueOnce({ kind: 'io', message: 'locked' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await applyChanges(linkIndex, api, [{ path: 'a.md', kind: 'modified' }]);
    expect(read).toHaveBeenCalledTimes(2);
    expect(linkIndex.backlinks('b.md').map((b) => b.source)).toEqual(['a.md', 'c.md']);
    warn.mockRestore();
  });
  it('falls back to tree + read when index_bodies fails', async () => {
    api.failBodies = true;
    await loadAll(linkIndex, api);
    expect(linkIndex.backlinks('b.md').map((b) => b.source)).toEqual(['a.md', 'c.md']);
  });
  it('completes notes missing from the body pages', async () => {
    api.bodiesOnly = ['a.md', 'b.md']; // partial FTS table, or c.md over MAX_NOTE_BYTES
    await loadAll(linkIndex, api);
    expect(linkIndex.backlinks('b.md').map((b) => b.source)).toEqual(['a.md', 'c.md']);
    expect(api.calls.read).toEqual(['c.md']);
  });
  it('parses raw bodies through parseRaw', async () => {
    api.add('e.md', '﻿---\r\nauthor: "[[b]]"\r\n---\r\n');
    await loadAll(linkIndex, api);
    expect(linkIndex.links('e.md')[0]).toMatchObject({ target: 'b', inFrontmatter: true, line: 1 });
  });
  it('time-slices parsing inside a page', async () => {
    let t = 0;
    const pause = vi.fn(async () => {});
    const many = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`n${i}.md`, '[[b]]']));
    await loadAll(linkIndex, fakeApi(many, []), { pause, now: () => (t += 5) }); // every parse "takes" 5 ms
    expect(pause.mock.calls.length).toBeGreaterThan(1);
  });
  it('a watcher change during a load is not overwritten by an older page', async () => {
    const gate = deferred<void>();
    api.holdBodies = gate.promise; // the body page was read before the change...
    const sync = createLinkSync(linkIndex, api);
    const loading = sync.load();
    await new Promise((r) => setTimeout(r, 0)); // ...bodies() has taken its snapshot...
    api.add('a.md', 'none'); // ...the file changes on disk...
    const applying = sync.apply([{ path: 'a.md', kind: 'modified' }]);
    gate.resolve();
    await Promise.all([loading, applying]);
    expect(linkIndex.backlinks('b.md').map((b) => b.source)).toEqual(['c.md']);
  });
  it('a failed step does not stop the queue', async () => {
    const sync = createLinkSync(linkIndex, api);
    vi.spyOn(api, 'tree').mockRejectedValueOnce(new Error('tree failed'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await sync.load();
    api.add('a.md', 'none');
    await sync.apply([{ path: 'a.md', kind: 'modified' }]);
    expect(linkIndex.links('a.md')).toEqual([]);
    warn.mockRestore();
  });
  it('settled waits for the queue, including the wait before loading', async () => {
    const rebuild = deferred<void>();
    const sync = createLinkSync(linkIndex, api);
    linkIndex.clear();
    const tree = vi.spyOn(api, 'tree');
    const bodiesBefore = api.calls.bodies;
    void sync.load(rebuild.promise);
    let settled = false;
    void linkIndex.settled().then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 0));
    // The load must not start before the FTS rebuild: earlier body pages may be stale.
    expect(tree).not.toHaveBeenCalled();
    expect(api.calls.bodies).toBe(bodiesBefore);
    expect(settled).toBe(false);
    expect(linkIndex.ready()).toBe(false);
    rebuild.resolve();
    await linkIndex.whenReady();
    expect(tree).toHaveBeenCalled();
    expect(api.calls.bodies).toBe(bodiesBefore + 1);
    expect(linkIndex.ready()).toBe(true);
    await linkIndex.settled();
    expect(settled).toBe(true);
  });
  it('a disposed sync never writes into the index again', async () => {
    const gate = deferred<void>();
    api.holdBodies = gate.promise;
    const sync = createLinkSync(linkIndex, api);
    const loading = sync.load();
    await new Promise((r) => setTimeout(r, 0));
    sync.dispose();
    linkIndex.clear();
    gate.resolve();
    await loading;
    expect(linkIndex.files()).toEqual([]);
    expect(linkIndex.ready()).toBe(false);
  });
});
