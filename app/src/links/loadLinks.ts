/**
 * Loading the link index and keeping it fresh (plan SP4 Task 6, decision D1).
 *
 * - `loadAll` fills the index from the FTS body pages (`index_bodies`), then reads every `.md` note from
 *   `vault_tree` that no page returned (a failed or partial FTS rebuild, notes over `MAX_NOTE_BYTES`),
 *   and only then marks the index ready.
 * - `applyChanges` follows watcher changes by re-reading only the changed paths.
 * - `createLinkSync` puts every load and change on one serial queue, so a body page read before a
 *   watcher event can never be applied after it. Every step is `track()`ed, so `settled()` covers it.
 */
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { parseRaw } from '../editor/documentIo';
import { ERROR_KINDS, hasErrorKind } from '../fs/errorKinds';
import { listVaultImages } from '../fs/vaultImage';
import { indexBodies, type BodyPage } from '../search/indexApi';
import type { VaultChange } from '../vault/useVaultEvents';
import type { LinkIndex } from './linkIndex';
import { IMAGE_EXTS, linkKey } from './resolve';

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

/** Notes per `index_bodies` page. */
export const BODY_PAGE = 200;
/** Parse time per loader slice (ms) before yielding to the UI. */
export const SLICE_MS = 8;
/** Notes read at once by `vault_read` (completion pass, created folders). */
const READ_PARALLEL = 8;

export interface LinkSourceApi {
  bodies(after: string | null, limit: number): Promise<BodyPage>;
  tree(): Promise<{ path: string; isDir: boolean }[]>;
  images(): Promise<string[]>;
  read(path: string): Promise<string>;
}

export interface LoadClock {
  pause(): Promise<void>;
  now(): number;
}

/** Yields one macrotask (MessageChannel, so not clamped like setTimeout) and reads `performance.now`. */
export const defaultClock: LoadClock = {
  pause: () =>
    new Promise<void>((resolve) => {
      if (typeof MessageChannel === 'undefined') {
        setTimeout(resolve, 0);
        return;
      }
      const ch = new MessageChannel();
      ch.port1.onmessage = () => {
        ch.port1.close();
        ch.port2.close();
        resolve();
      };
      ch.port2.postMessage(null);
    }),
  now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
};

const isNote = (path: string) => /\.md$/i.test(path);

function extOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

const isImage = (path: string) => IMAGE_EXTS.has(extOf(path));

function under(path: string, folder: string): boolean {
  const p = linkKey(path);
  const f = linkKey(folder.replace(/\/+$/, ''));
  return p === f || p.startsWith(`${f}/`);
}

/** Runs `fn` over `items`, `limit` at a time, in order of start. */
async function eachLimited<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * Reads one note from disk into the index. A note that is gone (`notFound`) is dropped; any other
 * failure leaves what the index had (the next change or a reload will read it again).
 */
async function readNote(ix: LinkIndex, api: LinkSourceApi, path: string): Promise<void> {
  let raw: string;
  try {
    raw = await api.read(path);
  } catch (e) {
    if (hasErrorKind(e, ERROR_KINDS.notFound)) ix.removeTree(path);
    return;
  }
  ix.addFiles([path]);
  ix.setNote(path, parseRaw(path, raw).text);
}

/** Clears the index, loads the universe and every note, then marks it ready. */
export async function loadAll(ix: LinkIndex, api: LinkSourceApi, clock: LoadClock = defaultClock): Promise<void> {
  ix.clear();
  const [tree, images] = await Promise.all([api.tree(), api.images().catch(() => [] as string[])]);
  const notes = tree.filter((e) => !e.isDir && isNote(e.path)).map((e) => e.path);
  ix.setFiles([...notes, ...images]);
  // The tree is the truth about which notes exist: a body page entry outside it is skipped.
  const wanted = new Map(notes.map((p) => [linkKey(p), p]));
  const seen = new Set<string>();

  let sliceStart = clock.now();
  try {
    let after: string | null = null;
    for (;;) {
      const page: BodyPage = await api.bodies(after, BODY_PAGE);
      for (const { path, body } of page.items) {
        const key = linkKey(path);
        const known = wanted.get(key);
        if (known === undefined || seen.has(key)) continue;
        seen.add(key);
        ix.setNote(known, parseRaw(known, body).text);
        if (clock.now() - sliceStart >= SLICE_MS) {
          await clock.pause();
          sliceStart = clock.now();
        }
      }
      if (page.next === null || page.items.length === 0) break;
      after = page.next;
    }
  } catch {
    // No FTS bodies: the completion pass below reads every note it lacks.
  }

  const missing = notes.filter((p) => !seen.has(linkKey(p)));
  await eachLimited(missing, READ_PARALLEL, (p) => readNote(ix, api, p));
  ix.markReady();
}

/** Diffs `images()` against the index's image files. */
export async function refreshImages(ix: LinkIndex, api: LinkSourceApi): Promise<void> {
  let images: string[];
  try {
    images = await api.images();
  } catch {
    return;
  }
  const now = new Set(images.map(linkKey));
  for (const f of ix.files().filter(isImage)) if (!now.has(linkKey(f))) ix.removeTree(f);
  ix.addFiles(images);
}

/** Follows watcher changes (D1): notes are re-read, images added or removed, anything else is a folder. */
export async function applyChanges(
  ix: LinkIndex,
  api: LinkSourceApi,
  changes: readonly VaultChange[],
  clock: LoadClock = defaultClock,
): Promise<void> {
  if (changes.some((c) => c.path === '')) {
    await loadAll(ix, api, clock);
    return;
  }
  // The last change per path wins (a remove then a create in one burst is a create).
  const last = new Map<string, VaultChange>();
  for (const c of changes) {
    last.delete(linkKey(c.path));
    last.set(linkKey(c.path), c);
  }
  const notes: string[] = [];
  const createdFolders: string[] = [];
  for (const { path, kind } of last.values()) {
    if (isNote(path)) notes.push(path);
    else if (isImage(path)) {
      if (kind === 'created') ix.addFiles([path]);
      else if (kind === 'removed') ix.removeTree(path);
    } else if (kind === 'removed') ix.removeTree(path);
    else if (kind === 'created') createdFolders.push(path);
  }
  await eachLimited(notes, READ_PARALLEL, (p) => readNote(ix, api, p));
  if (createdFolders.length === 0) return;
  let tree: { path: string; isDir: boolean }[];
  try {
    tree = await api.tree();
  } catch {
    tree = [];
  }
  const inside = tree
    .filter((e) => !e.isDir && isNote(e.path) && createdFolders.some((f) => under(e.path, f)))
    .map((e) => e.path);
  await eachLimited(inside, READ_PARALLEL, (p) => readNote(ix, api, p));
  await refreshImages(ix, api);
}

export interface LinkSync {
  load(before?: Promise<unknown>): Promise<void>;
  apply(changes: readonly VaultChange[]): Promise<void>;
  images(): Promise<void>;
  /** Stops this sync for good: queued and running steps never write into the index again. */
  dispose(): void;
}

class SyncClosed extends Error {}

const MUTATORS = new Set<PropertyKey>(['clear', 'setFiles', 'addFiles', 'removeTree', 'setNote', 'setOverlay', 'markReady']);

/** One serial promise chain; every call is `ix.track()`ed. A failed step is logged and the chain goes on. */
export function createLinkSync(ix: LinkIndex, api: LinkSourceApi, clock: LoadClock = defaultClock): LinkSync {
  let closed = false;
  // After dispose every mutation throws, which ends the running step without touching the index.
  const guarded = new Proxy(ix, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (closed && MUTATORS.has(prop)) throw new SyncClosed();
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  let chain: Promise<void> = Promise.resolve();
  const enqueue = (step: () => Promise<void>): Promise<void> => {
    const run = chain.then(async () => {
      if (closed) return;
      try {
        await step();
      } catch (e) {
        if (!(e instanceof SyncClosed)) console.warn('[links] index update failed', e);
      }
    });
    chain = run;
    return ix.track(run);
  };
  return {
    load: (before) =>
      enqueue(async () => {
        // The FTS rebuild, success or failure: `settled()` and `whenReady()` cover this wait too.
        if (before) await before.catch(() => undefined);
        if (closed) return;
        await loadAll(guarded, api, clock);
      }),
    apply: (changes) => enqueue(() => applyChanges(guarded, api, changes, clock)),
    images: () => enqueue(() => refreshImages(guarded, api)),
    dispose() {
      closed = true;
    },
  };
}

/** The app's source: the FTS body pages, `vault_tree`, `vault_list_images` and `vault_read`. */
export function tauriLinkSource(invoke: InvokeFn = tauriInvoke): LinkSourceApi {
  return {
    bodies: (after, limit) => indexBodies(after, limit, invoke),
    tree: () => invoke<{ path: string; isDir: boolean }[]>('vault_tree', {}),
    images: () => listVaultImages(invoke),
    read: (path) => invoke<string>('vault_read', { path }),
  };
}
