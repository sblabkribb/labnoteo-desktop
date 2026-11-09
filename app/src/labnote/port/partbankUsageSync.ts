// Ported from app/vendor/labnoteo/src/partbank/partbankUsageSync.ts:31-414 sha256:5ac5ed23cf5dfd70
// labnoteO 0.140.2, Apache-2.0.
// Changes: the four pcStore keys (partbankUsageClientId, partbankUsageSent, partbankUsageDirty, partbankUsageBackfill) become one JSON document { clientId, sent, dirty, backfill } in the app-data integration_state 'partbankUsage' (D13), read once through the injected `state` (usageStateStore) and written at the end of each job, or 1 s after markDirty (debounced); a document that is not JSON starts afresh with a warning, and a failed read sends and writes nothing. The constructor takes { env(), feature, enabled(), vaultName(), state, timers?, uuid?, guard? } instead of the plugin and a PcStore: plugin.settings.partbankSendUsages → enabled(), and markDirty does nothing while it is off (turning it on runs syncAll, which looks at every note anyway); app.vault.getName() → vaultName(); plugin.app.vault.getMarkdownFiles() → env.markdownFiles(); getAbstractFileByPath + cachedRead → env.fs.exists + env.fs.read (the editor-aware fs, so an open note's buffer). The vault modify, rename and delete hooks become register(events) with events = { onModify, onRename, onDelete } (fed by the vault watcher and the app's own writes), which also starts the startup pass after STARTUP_DELAY_MS and returns a disposer instead of plugin.registerEvent / plugin.register; stop() is new: it clears every timer and nothing is sent or saved after it. window.setTimeout → injected timers (default: the global setTimeout, looked up at call time). cachedResolver(env) uses the ported resolveSampleDefinition(env, …) over cachedReadFs(env.fs), which refuses rename and trash too. servers() uses feature.available() and feature.client(kind), and serverOf uses feature.clientForSource. The backfill fingerprint contentHash(kind + '\0' + url + '\0' + apiKey) becomes contentHash(kind + '\0' + origin + '\0' + feature.keyEpoch(kind)): the webview never holds the key (D6), and the epoch changes whenever a key is saved or removed, so a replaced key still starts a new generation, backfills and prunes the old one. Each job takes a vaultGuard() and checks it before every PUT and prune and before saving the state, so a vault switch mid-run sends nothing more and never writes this vault's state into the next one's; a cancelled job is dropped silently. console.warn stays, but logs only the error's kind and status (never its message or body); plugin.partbank.notifyError(err, kind) → feature.notifyError(err, client). The constants are unchanged and exported (BATCH 50, SAVE 5 s, RECONCILE 30 s, STARTUP 30 s). collectNoteRefs takes the resolver and serverOf as in the plugin and still returns a Map of server key → refs.
/**
 * Tell partbank which lab notes use its items, so an item's page can list the
 * experiments and notes it went into (to its owner only).
 *
 * Only lab notes (`*.labnote.md`) are reported. A note is sent again only when
 * what it would send changed, so saving a note costs at most one call per
 * server. Each install has its own `client_id`; a backfill tags everything it
 * sends with a new `generation` and prunes the rest once every batch went
 * through, which clears notes deleted while the app was closed. Nothing here
 * ever shows a notice except a refused key.
 *
 * Off unless this vault turned "Send note usages to partbank" on (D12).
 */
import type { SampleSource } from '@labnoteo/core';
import * as posix from '@labnoteo/core/posix';
import { maskAiCallouts } from '@labnoteo/core/lib/aiCallout';
import { getExperimentDir } from '@labnoteo/core/lib/labnoteStructure';
import { findSampleReferenceSpans, findSampleUsageSpots } from '@labnoteo/core/lib/sampleStorage';
import { getSampleDisplayMeta, maskSampleListTables } from '@labnoteo/core/lib/sampleUtils';
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import type { AppFs } from '../../fs/tauriLabnoteFs';
import {
  NetError,
  integrationStateRead,
  integrationStateWrite,
  vaultGuard,
  type InvokeFn,
} from '../../integrations/netIpc';
import type { SampleEnv } from '../../samples/env';
import { contentHash } from './catalogUpdate';
import { PartbankError, type NoteUsage, type NoteUsageRef, type PartbankClient } from './partbankClient';
import type { PartbankFeature } from './partbankFeature';
import { sampleListHeaders } from './sampleListTable';
import { resolveSampleDefinition, type ResolvedSampleDefinition } from './sampleQuery';

const NOTE_SUFFIX = '.labnote.md';
export const BATCH_SIZE = 50;
export const SAVE_DEBOUNCE_MS = 5_000;
export const RECONCILE_DEBOUNCE_MS = 30_000;
export const STARTUP_DELAY_MS = 30_000;
/** How long markDirty waits before writing the queue to app data. */
const STATE_SAVE_MS = 1_000;

/** Server key → note path → hash of what was last sent for it. */
type SentMap = Record<string, Record<string, string>>;
/** Server key → the backfill that tags its rows. */
type BackfillMap = Record<string, { fingerprint: string; generation: string; done: boolean }>;

/** What `integration_state` `partbankUsage` holds. */
interface UsageState {
  clientId?: string;
  sent: SentMap;
  dirty: string[];
  backfill: BackfillMap;
}

export type SampleResolver = (type: string, id: string, docPath: string) => Promise<ResolvedSampleDefinition | undefined>;

/** The timer functions usage sync uses; tests pass their own. */
export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const globalTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** The vault events a note's usage depends on. Each `on*` returns its unsubscribe. */
export interface UsageEvents {
  onModify(fn: (path: string) => void): () => void;
  onRename(fn: (path: string, oldPath: string) => void): () => void;
  onDelete(fn: (path: string) => void): () => void;
}

/** Where the sync keeps its state: one text document. */
export interface UsageStateStore {
  read(): Promise<string | null>;
  write(text: string): Promise<void>;
}

/** The app-data store of the open vault (`integration_state` `partbankUsage`, D13). */
export function usageStateStore(invoke: InvokeFn = tauriInvoke): UsageStateStore {
  return {
    read: () => integrationStateRead('partbankUsage', invoke),
    write: (text) => integrationStateWrite('partbankUsage', text, invoke),
  };
}

export function isUsageNote(path: string): boolean {
  return path.toLowerCase().endsWith(NOTE_SUFFIX);
}

/** Which configured server a client talks to; also the key of its sent map. */
export function serverKey(client: Pick<PartbankClient, 'kind' | 'origin'>): string {
  return `${client.kind}:${client.origin.toLowerCase()}`;
}

/**
 * A read-only view of `fs` that reads each file once. The sample registries a
 * batch of notes resolves against are the same few files over and over.
 */
export function cachedReadFs(fs: AppFs): AppFs {
  const memo = <T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> => {
    let hit = cache.get(key);
    if (!hit) {
      hit = load();
      cache.set(key, hit);
    }
    return hit;
  };
  const reads = new Map<string, Promise<string>>();
  const exists = new Map<string, Promise<boolean>>();
  const lists = new Map<string, Promise<string[]>>();
  const refuse = (): Promise<never> => Promise.reject(new Error('read-only'));
  return {
    read: (p) => memo(reads, p, () => fs.read(p)),
    exists: (p) => memo(exists, p, () => fs.exists(p)),
    list: (p) => memo(lists, p, () => fs.list(p)),
    write: refuse,
    modify: refuse,
    mkdir: refuse,
    remove: refuse,
    rmdir: refuse,
    rename: refuse,
    trash: refuse,
  };
}

/**
 * The resolver "Go to definition" uses (Local, Global, then catalog), over a
 * cached copy of the registries. Going through `resolveSampleDefinition` itself
 * keeps the two from ever disagreeing on which sample a reference names.
 */
export function cachedResolver(env: SampleEnv): SampleResolver {
  const view: SampleEnv = { ...env, fs: cachedReadFs(env.fs) };
  return (type, id, docPath) => resolveSampleDefinition(view, { type, id, docPath });
}

/**
 * The partbank references of one note, per server. A reference counts where
 * "View usages" counts it: not inside an AI callout (#318) nor a sample list
 * table (#385). Samples without a partbank link, or linked to a server that
 * is not set up here, are left out.
 */
export async function collectNoteRefs(
  doc: { path: string; text: string },
  types: readonly string[],
  headers: ReadonlyArray<readonly string[]>,
  resolve: SampleResolver,
  serverOf: (source: SampleSource) => string | undefined,
): Promise<Map<string, NoteUsageRef[]>> {
  const masked = maskSampleListTables(maskAiCallouts(doc.text), headers);
  const seen = new Set<string>();
  const out = new Map<string, NoteUsageRef[]>();
  for (const span of findSampleReferenceSpans(masked, types)) {
    const key = `${span.type}\u0000${span.id.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const resolved = await resolve(span.type, span.id, doc.path);
    const source = resolved?.record.source;
    if (!source) continue;
    const server = serverOf(source);
    if (!server) continue;
    const headings = [
      ...new Set(
        findSampleUsageSpots([doc], span.type, span.id, headers)
          .map((s) => s.heading)
          .filter(Boolean),
      ),
    ];
    const ref: NoteUsageRef = {
      type: source.type,
      id: source.id,
      sample_type: span.type,
      sample_id: span.id,
      ...(resolved.record.alias ? { alias: resolved.record.alias } : {}),
      headings,
    };
    out.set(server, [...(out.get(server) ?? []), ref]);
  }
  return out;
}

/** What is sent for a note; refs sorted so the same note hashes the same. */
export function noteUsage(path: string, refs: NoteUsageRef[]): NoteUsage {
  const expDir = getExperimentDir(path);
  const name = posix.basename(path);
  const sorted = [...refs].sort((a, b) =>
    `${a.type}\u0000${a.id}\u0000${a.sample_type}\u0000${a.sample_id}`.localeCompare(
      `${b.type}\u0000${b.id}\u0000${b.sample_type}\u0000${b.sample_id}`,
    ),
  );
  return {
    note_path: path,
    note_title: name.toLowerCase().endsWith(NOTE_SUFFIX) ? name.slice(0, -NOTE_SUFFIX.length) : name,
    experiment: expDir ? posix.basename(expDir) : null,
    refs: sorted,
  };
}

function newId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.randomUUID) return c.randomUUID();
  return Array.from({ length: 4 }, () => Math.random().toString(16).slice(2, 10)).join('-');
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The stored document, or a fresh state when there is none or it is not ours. */
function parseState(text: string | null): UsageState {
  const fresh: UsageState = { sent: {}, dirty: [], backfill: {} };
  if (!text?.trim()) return fresh;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    console.warn('[labnoteo] the note usage state could not be read; starting afresh.');
    return fresh;
  }
  if (!isRecord(data)) return fresh;
  return {
    ...(typeof data.clientId === 'string' && data.clientId ? { clientId: data.clientId } : {}),
    sent: isRecord(data.sent) ? (data.sent as SentMap) : {},
    dirty: Array.isArray(data.dirty) ? data.dirty.filter((p): p is string => typeof p === 'string') : [],
    backfill: isRecord(data.backfill) ? (data.backfill as BackfillMap) : {},
  };
}

const isCancelled = (err: unknown): boolean => err instanceof NetError && err.kind === 'cancelled';

/** What a log line may say about a failure: its kind and status, never its text or body. */
function failureOf(err: unknown): string {
  if (err instanceof PartbankError) return err.status !== undefined ? `${err.kind} (${err.status})` : err.kind;
  if (err instanceof NetError) return err.status !== undefined ? `${err.kind} (${err.status})` : err.kind;
  if (err instanceof Error) return err.name;
  return typeof err;
}

interface Server {
  key: string;
  client: PartbankClient;
  /** Changes when the address or the key does, which calls for a new backfill. */
  fingerprint: string;
}

export interface UsageSyncDeps {
  /** The open vault's sample environment, or undefined with no vault. */
  env: () => SampleEnv | undefined;
  feature: PartbankFeature;
  /** This vault's "Send note usages to partbank" (`partbankSendUsages`, off by default, D12). */
  enabled(): boolean;
  vaultName(): string;
  state: UsageStateStore;
  timers?: Timers;
  uuid?: () => string;
  /** Taken at the start of each job (D11); defaults to `vaultGuard()`. */
  guard?: () => Promise<{ check(): Promise<void> }>;
}

export class PartbankUsageSync {
  private readonly dirty = new Set<string>();
  /** Servers too old for the endpoint; left alone until the app restarts. */
  private readonly unsupported = new Set<string>();
  private readonly warnedUnauthorized = new Set<string>();
  private readonly timers: Timers;
  private readonly uuid: () => string;
  private saveTimer: unknown;
  private reconcileTimer: unknown;
  private startupTimer: unknown;
  private stateTimer: unknown;
  private chain: Promise<void> = Promise.resolve();
  private state: UsageState | undefined;
  private loading: Promise<UsageState> | undefined;
  private stopped = false;

  constructor(private readonly deps: UsageSyncDeps) {
    this.timers = deps.timers ?? globalTimers;
    this.uuid = deps.uuid ?? newId;
  }

  /** Follows the vault's note changes and runs the startup pass; returns the disposer. */
  register(events: UsageEvents): () => void {
    const offs = [
      events.onModify((path) => {
        if (isUsageNote(path)) this.markDirty(path);
      }),
      events.onRename((path, oldPath) => {
        if (isUsageNote(oldPath)) this.markDirty(oldPath);
        if (isUsageNote(path)) this.markDirty(path);
      }),
      events.onDelete((path) => {
        if (isUsageNote(path)) this.markDirty(path);
      }),
    ];
    this.clear('startupTimer');
    this.startupTimer = this.timers.setTimeout(() => void this.syncAll(), STARTUP_DELAY_MS);
    return () => {
      offs.forEach((off) => off());
      this.clear('startupTimer');
    };
  }

  /** A note changed, moved or went away: send it after the edits settle. */
  markDirty(path: string): void {
    if (this.stopped || !this.deps.enabled()) return;
    this.dirty.add(path);
    this.clear('stateTimer');
    this.stateTimer = this.timers.setTimeout(
      () =>
        void this.enqueue(async () => {
          const guard = await this.guard();
          await this.load();
          await this.save(guard);
        }),
      STATE_SAVE_MS,
    );
    this.clear('saveTimer');
    this.saveTimer = this.timers.setTimeout(() => void this.syncDirty(), SAVE_DEBOUNCE_MS);
  }

  /**
   * The sample registries changed while the notes did not (a sample deleted,
   * moved, linked to partbank, the Global folder changed…): look at every note
   * again once things settle, sending only those whose references changed.
   */
  scheduleReconcile(): void {
    if (this.stopped) return;
    this.clear('reconcileTimer');
    this.reconcileTimer = this.timers.setTimeout(() => void this.syncAll(), RECONCILE_DEBOUNCE_MS);
  }

  syncDirty(): Promise<void> {
    return this.enqueue(async () => {
      // Loading first brings back the notes queued before a restart.
      if (!this.deps.enabled()) return;
      await this.load();
      const paths = new Set(this.dirty);
      if (paths.size > 0) await this.sync(paths);
    });
  }

  /** Every lab note and every note sent before, so ones gone since are cleared too. */
  syncAll(): Promise<void> {
    return this.enqueue(() => this.sync('all'));
  }

  /**
   * Turned off: drop what this install sent to each server (a prune with a
   * generation nothing carries) and forget it, so turning it on backfills anew.
   * Best effort: a server out of reach keeps its rows.
   */
  disable(): Promise<void> {
    return this.enqueue(async () => {
      this.clear('saveTimer');
      this.clear('reconcileTimer');
      this.clear('stateTimer');
      const guard = await this.guard();
      const state = await this.load();
      if (state.clientId) {
        for (const server of this.servers()) {
          try {
            await guard.check();
            await server.client.pruneNoteUsages({ client_id: state.clientId, generation: `off-${this.uuid()}` });
          } catch (err) {
            if (isCancelled(err)) throw err;
            console.warn('[labnoteo] could not clear the note usages on partbank:', failureOf(err));
          }
        }
      }
      this.dirty.clear();
      state.sent = {};
      state.backfill = {};
      await this.save(guard);
    });
  }

  /** The vault closed: no timer fires and nothing is sent or saved any more. */
  stop(): void {
    this.stopped = true;
    this.clear('saveTimer');
    this.clear('reconcileTimer');
    this.clear('startupTimer');
    this.clear('stateTimer');
  }

  private clear(timer: 'saveTimer' | 'reconcileTimer' | 'startupTimer' | 'stateTimer'): void {
    if (this[timer] !== undefined) this.timers.clearTimeout(this[timer]);
    this[timer] = undefined;
  }

  private enqueue(job: () => Promise<void>): Promise<void> {
    const next = this.chain
      .then(() => (this.stopped ? undefined : job()))
      .catch((err) => {
        if (!isCancelled(err)) console.warn('[labnoteo] note usage sync failed:', failureOf(err));
      });
    this.chain = next;
    return next;
  }

  private guard(): Promise<{ check(): Promise<void> }> {
    return this.deps.guard ? this.deps.guard() : vaultGuard();
  }

  /** The stored state, read once; the notes it had queued join the ones queued since. */
  private load(): Promise<UsageState> {
    if (this.state) return Promise.resolve(this.state);
    this.loading ??= this.deps.state.read().then(
      (text) => {
        const state = parseState(text);
        for (const path of state.dirty) this.dirty.add(path);
        this.state = state;
        return state;
      },
      (err: unknown) => {
        this.loading = undefined;
        throw err;
      },
    );
    return this.loading;
  }

  private async save(guard: { check(): Promise<void> }): Promise<void> {
    const state = this.state;
    if (!state || this.stopped) return;
    await guard.check();
    this.clear('stateTimer');
    const doc: UsageState = {
      ...(state.clientId ? { clientId: state.clientId } : {}),
      sent: state.sent,
      dirty: [...this.dirty],
      backfill: state.backfill,
    };
    await this.deps.state.write(JSON.stringify(doc));
  }

  private clientId(state: UsageState): string {
    state.clientId ??= this.uuid();
    return state.clientId;
  }

  private servers(): Server[] {
    const { feature } = this.deps;
    return feature.available().flatMap((config) => {
      const client = feature.client(config.kind);
      if (!client) return [];
      const key = serverKey(client);
      if (this.unsupported.has(key)) return [];
      return [
        {
          key,
          client,
          fingerprint: contentHash(`${config.kind}\u0000${config.origin}\u0000${feature.keyEpoch(config.kind)}`),
        },
      ];
    });
  }

  private async sync(paths: Set<string> | 'all'): Promise<void> {
    if (!this.deps.enabled()) return;
    const env = this.deps.env();
    if (!env) return;
    const servers = this.servers();
    if (servers.length === 0) return;
    const guard = await this.guard();
    const state = await this.load();

    const { sent, backfill } = state;
    const needsBackfill = (s: Server): boolean => backfill[s.key]?.fingerprint !== s.fingerprint || !backfill[s.key]?.done;
    const notes = (await env.markdownFiles()).filter(isUsageNote);
    const targets =
      paths === 'all' || servers.some(needsBackfill)
        ? new Set([...notes, ...Object.values(sent).flatMap((m) => Object.keys(m))])
        : paths;

    const types = getSampleDisplayMeta(env.settings().customSampleTypes).types;
    const headers = sampleListHeaders(env);
    const resolve = cachedResolver(env);
    const byServer = new Map(servers.map((s) => [s.key, s]));
    const serverOf = (source: SampleSource): string | undefined => {
      const client = this.deps.feature.clientForSource(source);
      const key = client ? serverKey(client) : undefined;
      return key && byServer.has(key) ? key : undefined;
    };
    const refs = new Map<string, Map<string, NoteUsageRef[]>>();
    for (const path of targets) {
      if (!isUsageNote(path) || !(await env.fs.exists(path))) continue;
      const text = await env.fs.read(path);
      refs.set(path, await collectNoteRefs({ path, text }, types, headers, resolve, serverOf));
    }

    const clientId = this.clientId(state);
    const vaultName = this.deps.vaultName();
    let retry = false;
    for (const server of servers) {
      const full = needsBackfill(server);
      const run = full ? { fingerprint: server.fingerprint, generation: this.uuid(), done: false } : backfill[server.key];
      backfill[server.key] = run;
      const before = sent[server.key] ?? {};
      const after: Record<string, string> = full ? {} : { ...before };
      const outgoing: Array<{ usage: NoteUsage; hash: string | undefined }> = [];
      for (const path of targets) {
        const usage = noteUsage(path, refs.get(path)?.get(server.key) ?? []);
        const hash = usage.refs.length > 0 ? contentHash(JSON.stringify(usage)) : undefined;
        // A backfill sends every note with references; the prune clears the rest.
        if (full ? hash !== undefined : hash !== before[path]) outgoing.push({ usage, hash });
      }
      try {
        for (const batch of chunks(outgoing, BATCH_SIZE)) {
          await guard.check();
          await server.client.putNoteUsages({
            client_id: clientId,
            generation: run.generation,
            vault_name: vaultName,
            notes: batch.map((b) => b.usage),
          });
          for (const { usage, hash } of batch) {
            if (hash) after[usage.note_path] = hash;
            else delete after[usage.note_path];
          }
        }
        if (full) {
          await guard.check();
          await server.client.pruneNoteUsages({ client_id: clientId, generation: run.generation });
          run.done = true;
        }
      } catch (err) {
        if (isCancelled(err)) throw err;
        retry = this.handleError(err, server) || retry;
      } finally {
        // A backfill that stopped halfway starts over next time, so keep what it sent only once it is done.
        if (!full || run.done) sent[server.key] = after;
      }
    }

    if (!retry) for (const path of targets) this.dirty.delete(path);
    await this.save(guard);
  }

  /** True when the notes should be sent again later. */
  private handleError(err: unknown, server: Server): boolean {
    const status = err instanceof PartbankError ? err.status : undefined;
    // An older server has no such endpoint. The desktop app's catch-all page
    // route answers a PUT it does not know with 405 rather than 404.
    if (status === 404 || status === 405) {
      this.unsupported.add(server.key);
      console.info(`[labnoteo] ${server.client.origin} does not take note usages; not sending them this session.`);
      return false;
    }
    if (err instanceof PartbankError && err.kind === 'unauthorized' && !this.warnedUnauthorized.has(server.key)) {
      this.warnedUnauthorized.add(server.key);
      this.deps.feature.notifyError(err, server.client);
    } else {
      console.warn('[labnoteo] could not send note usages to partbank:', failureOf(err));
    }
    return true;
  }
}
