// Ported from app/vendor/labnoteo/src/barcode/barcodeFeature.ts:294-356 sha256:3bd51adb64670a02
// labnoteO 0.140.2, Apache-2.0.
// Changes: the BarcodeFeature methods become the ScanRuns class over ScanRunsDeps; the busy flag polled every
// 500 ms becomes a promise chain (one batch at a time, in call order, and a batch that throws does not block the
// next); the "Processing scans…" Notice splits by B8: a manual run uses withProgress (the modal the user asked for,
// whose line() takes the progress text), a background run with !skipNoQr a sticky non-modal notifyStatus toast
// (update/close), and a background shared-folder run (skipNoQr) shows nothing; a background run never opens a
// dialog or moves focus; Notice becomes notify and a Notice with a link becomes notify(…, { ms: 15000, action });
// ScanResultModal becomes deps.openResults (the ResultsDialog through dialogStore); this.app.vault.cachedRead
// becomes deps.read (the editor-aware fs, so an open note's buffer) and host.openFile becomes deps.openFile;
// "Open note" waits for the note to open (an error is notified) before offering the results again; the
// Translator is coreT. A vault switch is checked for (SP6 D11): each batch runs with a vault guard (the caller's, or
// deps.guard() taken when the batch starts), which goes to pipeline.run as RunOptions.guard; report takes the guard
// of the run it reports, and its Details and Show results toast actions do nothing once that guard's signal is aborted
// (the vault was switched), so the old vault's results, Undo and Delete earlier scan never act on another vault.
/** A batch of scans, one at a time, and what the user is told about it. */
import { scanEntryLine } from '@labnoteo/core';
import type { withProgress } from '../../integrations/progressStore';
import type { VaultGuard } from '../../integrations/netIpc';
import type { notify, notifyStatus } from '../host/toastStore';
import { coreT } from '../i18n';
import type { ScanInput, ScanPipeline, ScanResult } from './scanPipeline';
import { summarizeResults } from './scanResults';

/** What the results dialog can ask for. */
export interface ResultActions {
  /** The dialog closed to show the note at the scan with this hash. */
  openNote(path: string, hash?: string): void;
  /** The dialog closed to assign the unmatched pages. */
  openUnmatched(): void;
}

export interface ScanRunsDeps {
  pipeline: ScanPipeline;
  withProgress: typeof withProgress;
  notifyStatus: typeof notifyStatus;
  notify: typeof notify;
  /** Reads a note (an open note's buffer). */
  read(path: string): Promise<string>;
  openFile(path: string, at?: { line: number }): Promise<void>;
  /** Opens the results dialog over `results` (the same array, so Undo state carries over). */
  openResults(results: ScanResult[], actions: ResultActions): void;
  openUnmatched(): void;
  /** The vault guard a batch takes when it starts, unless its caller hands one in. */
  guard(): Promise<VaultGuard>;
}

/** Whether the vault `guard` was taken in has been switched away (its results then belong to no open vault). */
const gone = (guard: VaultGuard | undefined): boolean => !!guard?.signal.aborted;

export class ScanRuns {
  /** Settles when the batch in hand is over; the next batch waits for it. */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: ScanRunsDeps) {}

  /** Run one batch after any batch already running; `guard` is the caller's vault guard (otherwise one is taken). */
  runWithProgress(inputs: ScanInput[], skipNoQr: boolean, manual: boolean, guard?: VaultGuard): Promise<ScanResult[]> {
    const run = this.tail.then(async () => this.runNow(inputs, skipNoQr, manual, guard ?? (await this.deps.guard())));
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async runNow(inputs: ScanInput[], skipNoQr: boolean, manual: boolean, guard: VaultGuard): Promise<ScanResult[]> {
    const { pipeline } = this.deps;
    const progressText = (done: number, label: string) => coreT('Processing scans… {0} page(s) done ({1})', String(done), label);
    if (manual) {
      return this.deps.withProgress(coreT('Processing scans…'), (p) =>
        pipeline.run(inputs, {
          skipNoQr,
          guard,
          onProgress: (done, label) => p.line(progressText(done, label)),
        }),
      );
    }
    // In the background: never a dialog, never the focus (B8).
    const status = skipNoQr ? undefined : this.deps.notifyStatus(coreT('Processing scans…'));
    try {
      return await pipeline.run(inputs, {
        skipNoQr,
        guard,
        onProgress: (done, label) => status?.update(progressText(done, label)),
      });
    } finally {
      status?.close();
    }
  }

  /** `guard`: the vault guard of the run that gave `results`; once it is aborted, the results open nothing. */
  report(results: ScanResult[], manual: boolean, guard?: VaultGuard): void {
    const shown = results.filter((r) => r.status !== 'skipped');
    if (shown.length === 0) {
      if (manual && results.length > 0) this.deps.notify('info', coreT('No worksheet pages were found.'));
      return;
    }
    const open = (): void => {
      if (gone(guard)) return;
      this.deps.openResults(results, {
        openNote: (path, hash) => {
          void this.openScanInNote(path, hash)
            .catch((err: unknown) =>
              this.deps.notify('error', coreT('Command failed: {0}', err instanceof Error ? err.message : String(err))),
            )
            .then(() => {
              if (!gone(guard)) this.offerResultsAgain(open);
            });
        },
        openUnmatched: () => this.deps.openUnmatched(),
      });
    };
    if (manual) {
      open();
      return;
    }
    this.deps.notify('info', `${coreT('Scans')}: ${summarizeResults(coreT, results)} `, {
      ms: 15000,
      action: { label: coreT('Details'), run: open },
    });
  }

  /** Open the note on the scan with this hash, or at the top when it is not there. */
  async openScanInNote(path: string, hash?: string): Promise<void> {
    let line: number | undefined;
    if (hash) {
      try {
        line = scanEntryLine(await this.deps.read(path), hash);
      } catch {
        line = undefined; // the note is gone or unreadable: openFile says so
      }
    }
    await this.deps.openFile(path, line === undefined ? undefined : { line });
  }

  /** The result window closed to show a note; keep it one click away for undo. */
  offerResultsAgain(open: () => void): void {
    this.deps.notify('info', '', {
      ms: 15000,
      action: { label: coreT('Show results'), run: open },
    });
  }
}
