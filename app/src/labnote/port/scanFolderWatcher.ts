// Ported from app/vendor/labnoteo/src/scan/scanFolderWatcher.ts:21-353 sha256:39a3e2cc1b1eb106
// labnoteO 0.140.2, Apache-2.0.
// Changes: Node fs/path/fs.watch become the Rust scan folder commands (scanFolderList, scanFolderRead,
// scanFolderMove) plus listen(SCAN_FOLDER_CHANGED), which schedules a tick SETTLE_MS + 500 ms on, and start() also
// polls every POLL_MS (the plugin's own interval) once scanFolderStatus() names a folder; config() becomes
// scanFolderStatus(), whose since and baseline come from Rust (B4), so wasThereBefore and selectReadyFiles are
// unchanged; setConfig and readBaseline are removed (Rust records the baseline in scan_folder_choose and keeps it in
// scan_folder_set_mode; the settings section calls those and then restart(), which is public and forgets the sizes
// seen); pruneBaseline(cfg, entries) becomes await scanFolderPruneBaseline(entries.map(historyKey)), whose answer is
// the baseline in force; the pcStore history becomes read/writeScanHistory; moveOriginal becomes scanFolderMove
// (dedicated only; Rust picks the free _N name and never replaces a file); WatcherDeps drop store and t (coreT is the
// Translator), gain invoke, listen and now, and run(inputs, opts, manual) is told whether the user asked for the run
// (B8: a manual run shows the progress modal); 'Set a scan folder first: Settings → Labnote Assistant → Barcode &
// scans.' becomes overrideOr('scan.setFolderFirst'); an unreadable folder is named by its NetError kind, never by
// Rust's text; tick takes the running flag before the (now asynchronous) folder read, so two ticks never overlap;
// console.warn logs the file name and the error kind only; window timers become globalThis timers.
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { listen as tauriListen } from '@tauri-apps/api/event';
import { toNetError, type InvokeFn, type ListenFn } from '../../integrations/netIpc';
import { coreT, overrideOr } from '../i18n';
import {
  SCAN_FOLDER_CHANGED,
  readScanHistory,
  scanFolderList,
  scanFolderMove,
  scanFolderPruneBaseline,
  scanFolderRead,
  scanFolderStatus,
  writeScanHistory,
  type ScanFolderStatus,
} from '../scan/scanIpc';
import type { RunOptions, ScanInput, ScanResult } from './scanPipeline';

export type { ScanMode as ScanFolderMode } from '../scan/scanIpc';

export const PROCESSED_DIR = 'labnote-processed';
export const FAILED_DIR = 'labnote-failed';
export const SCAN_FILE_RE = /\.(jpe?g|png|webp|gif|bmp|pdf|zip|heic|heif|tiff?)$/i;
export const POLL_MS = 30_000;
const HISTORY_DAYS = 90;
/** A file still growing (being copied, synced, scanned) is left for the next look. */
const SETTLE_MS = 2_000;

export interface FolderEntry {
  name: string;
  size: number;
  mtimeMs: number;
  /** When the file appeared here; Windows sets it anew on a copy. 0 where the file system has none. */
  birthtimeMs?: number;
}

/** Key remembering a file in shared mode: a re-saved or edited photo counts as new. */
export const historyKey = (e: FolderEntry): string => `${e.name}|${e.size}|${Math.round(e.mtimeMs)}`;

/**
 * Whether a file was already in the folder when it was set. With a baseline that is simply the list taken then. In
 * older folders there is no list, so the time is all there is: a copy keeps its modification time but Windows gives
 * it a new creation time, so the later of the two decides (#247).
 */
function wasThereBefore(e: FolderEntry, since: number, baseline?: ReadonlySet<string>): boolean {
  if (baseline) return baseline.has(historyKey(e));
  return Math.max(e.mtimeMs, e.birthtimeMs ?? 0) < since;
}

/**
 * Files to read now: scan files that were not in the folder when it was set (or all, with `includeExisting`), not
 * handled before, and done being written — same size as at the previous look (`lastSizes`) and untouched for a
 * moment.
 */
export function selectReadyFiles(
  entries: readonly FolderEntry[],
  opts: {
    since: number;
    now: number;
    includeExisting?: boolean;
    /** {@link historyKey}s of the files the folder already had. */
    baseline?: ReadonlySet<string>;
    handled: (e: FolderEntry) => boolean;
    lastSizes: Map<string, number>;
    /** A manual run does not wait for a second look. */
    manual?: boolean;
  },
): { ready: FolderEntry[]; waiting: number } {
  const ready: FolderEntry[] = [];
  let waiting = 0;
  const seen = new Set<string>();
  for (const e of entries) {
    if (!SCAN_FILE_RE.test(e.name) || e.name.startsWith('.') || e.name.startsWith('~$')) continue;
    if (!opts.includeExisting && wasThereBefore(e, opts.since, opts.baseline)) continue;
    if (opts.handled(e)) continue;
    seen.add(e.name);
    const settled = opts.now - e.mtimeMs >= SETTLE_MS && e.size > 0;
    const sameSize = opts.lastSizes.get(e.name) === e.size;
    opts.lastSizes.set(e.name, e.size);
    if (settled && (sameSize || opts.manual)) ready.push(e);
    else waiting++;
  }
  for (const name of [...opts.lastSizes.keys()]) if (!seen.has(name)) opts.lastSizes.delete(name);
  return { ready, waiting };
}

export function pruneHistory(history: Record<string, number>, now: number): Record<string, number> {
  const cutoff = now - HISTORY_DAYS * 24 * 60 * 60 * 1000;
  return Object.fromEntries(Object.entries(history).filter(([, at]) => at >= cutoff));
}

/** A file handled without anything filed from it goes to the failed folder. */
export function outcomeOf(results: readonly ScanResult[]): 'processed' | 'failed' {
  const failed = (r: ScanResult) => r.status === 'unmatched' || r.status === 'unsupported' || r.status === 'error';
  return results.length > 0 && results.every(failed) ? 'failed' : 'processed';
}

/** Whether `folder` is the vault or inside it (both absolute). Rust decides for the stored folder (B4). */
export function isInsideFolder(folder: string, parent: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const f = norm(folder);
  const v = norm(parent);
  return f === v || f.startsWith(`${v}/`);
}

export interface WatcherDeps {
  /** Batch runner; `manual` is true when the user asked for this run (Process now, Process existing files too). */
  run(inputs: ScanInput[], opts: RunOptions, manual: boolean): Promise<ScanResult[]>;
  report(results: ScanResult[], manual: boolean): void;
  notify(message: string): void;
  invoke?: InvokeFn;
  listen?: ListenFn;
  now?: () => number;
}

/** What a log line or a notice may say about a failure: its kind, never Rust's text. */
const kindOf = (err: unknown): string => toNetError(err).kind;

export class ScanFolderWatcher {
  private running = false;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private pollTimer?: ReturnType<typeof setInterval>;
  private unlisten?: () => void;
  /** Bumped by stop(): a start() still waiting on Rust then sets nothing up. */
  private generation = 0;
  private readonly lastSizes = new Map<string, number>();
  private readonly invoke: InvokeFn;
  private readonly listen: ListenFn;
  private readonly now: () => number;

  constructor(private readonly deps: WatcherDeps) {
    this.invoke = deps.invoke ?? tauriInvoke;
    this.listen = deps.listen ?? tauriListen;
    this.now = deps.now ?? (() => Date.now());
  }

  /** The folder Rust holds for this vault, or undefined when there is none (or Rust cannot say). */
  private async config(): Promise<ScanFolderStatus | undefined> {
    try {
      const status = await scanFolderStatus(this.invoke);
      return status.path ? status : undefined;
    } catch (err) {
      console.warn('[labnoteo] could not read the scan folder status', kindOf(err));
      return undefined;
    }
  }

  /** Watch the folder for changes and look at it every {@link POLL_MS}; does nothing without a folder. */
  start(): void {
    this.stop();
    const gen = this.generation;
    void (async () => {
      if (!(await this.config()) || gen !== this.generation) return;
      this.pollTimer = globalThis.setInterval(() => void this.tick(), POLL_MS);
      this.scheduleTick(1_000);
      try {
        const off = await this.listen(SCAN_FOLDER_CHANGED, () => this.scheduleTick(SETTLE_MS + 500));
        if (gen !== this.generation) off();
        else this.unlisten = off;
      } catch (err) {
        // The poll still covers the folder.
        console.warn('[labnoteo] could not listen for scan folder changes', err instanceof Error ? err.name : typeof err);
      }
    })();
  }

  stop(): void {
    this.generation++;
    this.unlisten?.();
    this.unlisten = undefined;
    globalThis.clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    globalThis.clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  /** After the folder or its mode changed: forget the sizes seen and start over. */
  restart(): void {
    this.lastSizes.clear();
    this.start();
  }

  private scheduleTick(ms: number): void {
    globalThis.clearTimeout(this.retryTimer);
    this.retryTimer = globalThis.setTimeout(() => void this.tick(), ms);
  }

  /** Read what is ready in the folder now. Returns undefined when nothing ran. */
  async tick(opts: { manual?: boolean; includeExisting?: boolean } = {}): Promise<ScanResult[] | undefined> {
    if (this.running) {
      if (opts.manual) this.deps.notify(coreT('The scan folder is being processed already.'));
      return undefined;
    }
    this.running = true;
    try {
      const cfg = await this.config();
      if (!cfg) {
        // Plugin text: 'Set a scan folder first: Settings → Labnote Assistant → Barcode & scans.'
        if (opts.manual) this.deps.notify(overrideOr('scan.setFolderFirst'));
        return undefined;
      }
      const invoke = this.invoke;
      let listed: FolderEntry[];
      try {
        listed = (await scanFolderList(invoke)).map((e) => ({
          name: e.name,
          size: e.size,
          mtimeMs: e.mtimeMs,
          birthtimeMs: e.birthtimeMs ?? undefined,
        }));
      } catch (err) {
        if (opts.manual) this.deps.notify(coreT('The scan folder {0} could not be read: {1}', cfg.path ?? '', kindOf(err)));
        return undefined;
      }
      const entries = listed.filter((e) => SCAN_FILE_RE.test(e.name));
      const now = this.now();
      let history = pruneHistory(await readScanHistory(invoke), now);
      // A file taken out of the folder leaves the baseline, so putting it back in (the same photo once more) reads it.
      const stillThere = (await scanFolderPruneBaseline(entries.map(historyKey), invoke)) ?? undefined;
      const { ready, waiting } = selectReadyFiles(entries, {
        since: cfg.since ?? 0,
        now,
        includeExisting: opts.includeExisting,
        baseline: stillThere && new Set(stillThere),
        handled: (e) => historyKey(e) in history,
        lastSizes: this.lastSizes,
        manual: opts.manual,
      });
      if (waiting > 0) this.scheduleTick(SETTLE_MS + 1_000);
      if (ready.length === 0) {
        if (opts.manual) this.deps.notify(this.nothingNewMessage(stillThere, !!opts.includeExisting));
        return [];
      }
      const inputs: ScanInput[] = [];
      const read: FolderEntry[] = [];
      for (const e of ready) {
        try {
          inputs.push({ name: e.name, bytes: await scanFolderRead(e.name, invoke) });
          read.push(e);
        } catch (err) {
          console.warn('[labnoteo] could not read scan', e.name, kindOf(err));
        }
      }
      const results = await this.deps.run(inputs, { skipNoQr: cfg.mode === 'shared' }, !!opts.manual);
      for (const e of read) {
        const own = results.filter((r) => (r.input ?? r.source) === e.name);
        history[historyKey(e)] = now;
        if (cfg.mode === 'dedicated') await this.moveOriginal(e.name, outcomeOf(own));
      }
      history = pruneHistory(history, now);
      await writeScanHistory(history, invoke);
      this.deps.report(results, !!opts.manual);
      return results;
    } finally {
      this.running = false;
    }
  }

  /** Why a manual run found nothing, and what to do about files it passes over. */
  private nothingNewMessage(baseline: string[] | undefined, includeExisting: boolean): string {
    const nothing = coreT('No new files in the scan folder.');
    if (includeExisting) return nothing;
    if (baseline === undefined) {
      return `${nothing} ${coreT(
        'Files that were already in the folder when it was set are skipped. Read them with "{0}", or set the folder again to take what is in it now as the starting point.',
        coreT('Process existing files too'),
      )}`;
    }
    if (baseline.length === 0) return nothing;
    return `${nothing} ${coreT(
      '{0} file(s) that were already in the folder when it was set are skipped. Read them with "{1}".',
      String(baseline.length),
      coreT('Process existing files too'),
    )}`;
  }

  private async moveOriginal(name: string, outcome: 'processed' | 'failed'): Promise<void> {
    try {
      await scanFolderMove(name, outcome, this.invoke);
    } catch (err) {
      // Remembered in the history either way, so it is not read again.
      console.warn('[labnoteo] could not move scan original', name, kindOf(err));
    }
  }
}
