// Ported from app/vendor/labnoteo/src/scan/scanPipeline.ts:1-400 sha256:eeb595308882c946
// Ported from app/vendor/labnoteo/src/scan/scanPipeline.ts:402-498 sha256:0d254e8da2ecdfcd
// labnoteO 0.140.2, Apache-2.0.
// Changes: PipelineDeps drops the Obsidian App and takes noteIds (NoteIdService over the note-ID index), fs (the
// editor-aware AppFs: read, trash), processNote(path, fn) (refuses a composing or busy open note with NoteBusyError),
// images (ImageStoreDeps: vault_exists, vault_read_image, scan_write_image, LinkIndex.backlinks), listImages
// (vault_list_images) and an optional ready() awaited before a run (the note-ID index's first build);
// imageExists becomes async: vault_exists on the path the editor resolves (resolveImagePath, then pickByName over
// listImages for a name-only embed); fileManager.generateMarkdownLink becomes core-free `![[<name>|<embedWidth>]]`
// when the name is unique in the vault and `![[<vault path>|…]]` otherwise (editor/live/pasteImage.ts embedText),
// and the full-size link `[[<same>|Open full size]]`; markUserEdit(path) becomes stampNote(path), a transform run
// inside the same processNote call, only when entries were inserted (SP7 B9: last_updated_date when
// autoUpdateLastUpdated and the path is *.labnote.md); caption() takes safeSourceName(source) (B9); flush retries
// NoteBusyError every BUSY_RETRY_MS (1 s) up to BUSY_RETRIES (30 s), then re-queues every item of that note
// through the vanished-block path with the new reason 'note-busy' (read the stored image, queue it, fs.trash it);
// vault.getAbstractFileByPath/readBinary there become images.readBinary, fileManager.trashFile becomes fs.trash;
// ZIP_LIMITS is exported; saveBinary returns { path, name }; a DecodedPage may carry `error` (a page the decoder
// could not read), which filePage records as an `error` result in the page's place. fileManually(image, note,
// unitOpIndex, page, printedOn) becomes fileManually(item, target) with the queue image as { path, name } and the
// note as a NoteRef; app.vault.readBinary/read become images.readBinary and fs.read; every
// fileManager.trashFile becomes fs.trash (Recycle Bin), only for a path still there (images.exists, the plugin's
// instanceof TFile); undo and removePrevious write through processNote (waiting out a busy note like flush) and
// markUserEdit becomes the in-transform stampNote, applied only when an entry was removed (B9);
// metadataCache.getFirstLinkpathDest becomes the editor's image resolution (resolveImagePath, pickByName). A vault
// switch is checked for (SP6 D11): RunOptions takes a guard, whose check() runs before every image write (store,
// unmatched), before every processNote attempt (so the busy retries stop too) and before the stored image is
// trashed; a cancelled check ends the run with that error and nothing more is written. A DecodedPage may carry
// `unsupportedImage` (a PDF page with an image pdf.js cannot decode, User Decision 2026-11-09): it is queued as
// unmatched with the new reason 'pdf-image', shared folder or not, and never filed or dropped.
/**
 * The one path every scan takes, whatever brought it in (scan folder, drag and
 * drop, Slack): split PDFs and zips into pages, read each page's QR code, find
 * the note and unit operation it was printed from, store the image and file it
 * there. Pages are handled one at a time with pauses for the UI, and each note
 * is written once at the end of a batch.
 */
import { unzipSync } from 'fflate';
import type { LabnoteHost, Translator } from '@labnoteo/core';
import { insertScanEntries, listFiledScans, listUnitOpBlocks, removeScanEntry, resolveScanTarget, type ScanEntry } from '@labnoteo/core';
import { getSeoulDateString } from '@labnoteo/core/lib/dateUtils';
import { getExperimentDir } from '@labnoteo/core/lib/labnoteStructure';
import { isPagePayload, unitOpFingerprint, type PagePayload, type ScanPayload } from '@labnoteo/core/lib/scanPayload';
import * as posix from '@labnoteo/core/posix';
import { pickByName, resolveImagePath } from '../../editor/live/imagePath';
import type { AppFs } from '../../fs/tauriLabnoteFs';
import { NetError } from '../../integrations/netIpc';
import type { NoteRef } from '../barcode/noteIdIndex';
import { NoteBusyError } from '../noteErrors';
import type { NoteIdService } from './noteIdService';
import {
  SCANS_SUBFOLDER,
  UNMATCHED_FOLDER,
  saveBinary,
  scanFileName,
  sha256Hex,
  shortHash,
  sourceNameFromUnmatched,
  timestamp,
  unmatchedInfoFromName,
  unmatchedFileName,
  type ImageStoreDeps,
} from './imageStore';

export interface ScanInput {
  name: string;
  bytes: ArrayBuffer;
}

export type ScanStatus = 'filed' | 'duplicate' | 'unmatched' | 'blank' | 'skipped' | 'unsupported' | 'error';

/** The plugin's reasons, plus `note-busy`: the note stayed busy (composing) for 30 s, so the page was queued. */
export type UnmatchedReason =
  | 'no-qr'
  | 'note-not-found'
  | 'duplicate-id'
  | 'note-only'
  | 'no-unit-op'
  | 'ambiguous'
  | 'renamed'
  | 'note-busy'
  | 'pdf-image';
export type UnsupportedReason = 'heic' | 'tiff' | 'unknown' | 'zip-limit' | 'pdf-limit';

export interface ScanResult {
  /** The file handed to the pipeline (a zip, for its members). */
  input?: string;
  /** File the page came from. */
  source: string;
  /** Page within a PDF, 1-based. */
  sourcePage?: number;
  status: ScanStatus;
  /** `cancelled`: a hand assignment the user called off; the image stays in the queue. */
  reason?: UnmatchedReason | UnsupportedReason | 'cancelled';
  /** Error message for `error`. */
  message?: string;
  payload?: ScanPayload;
  notePath?: string;
  imagePath?: string;
  hash?: string;
  unmatchedPath?: string;
  /** Scans of the same page filed before this one. */
  previous?: { hash: string; embed: string }[];
  /** The unit operation it was filed under, as its heading reads (`[UHW290 Name] alias`). */
  block?: string;
  /**
   * How that block was found (#304): `index` when it is still where the page
   * was printed from; otherwise it moved, so the result asks to check it.
   */
  matchedBy?: 'index' | 'opId' | 'fingerprint';
  /** The printout carries no block fingerprint (printed before 0.123.0). */
  legacy?: boolean;
  /** The note already had this scan, but its image was gone, so it was filed again (#432). */
  replacedMissing?: boolean;
}

/** One page image, decoded. */
export interface DecodedPage {
  source: string;
  sourcePage?: number;
  /** Short content hash identifying the page across imports. */
  hash: string;
  blank: boolean;
  payload?: ScanPayload;
  /** The page could not be read (an image over 20 MiB, a PDF page with nothing to show at all): an `error` result. */
  error?: string;
  /**
   * A PDF page with an image pdf.js cannot decode (JPEG 2000): `render` gives what could be drawn (or a placeholder
   * naming the PDF and page), and the page goes to the unmatched queue as `pdf-image`.
   */
  unsupportedImage?: boolean;
  /** The page upright, scaled and compressed for storing. */
  render(): Promise<ArrayBuffer>;
}

/** Turns an input file into pages; the canvas-based one lives in `pageDecoder.ts`. */
export interface PageDecoder {
  /** Calls `onPage` for each page in turn; returns results for inputs that yield no page. */
  expand(input: ScanInput, onPage: (page: DecodedPage) => Promise<void>): Promise<ScanResult[]>;
}

export interface PipelineDeps {
  host: LabnoteHost;
  t: Translator;
  noteIds: NoteIdService;
  /** Editor-aware: reads an open note's buffer; `trash` sends to the Recycle Bin. */
  fs: AppFs;
  /** Rewrites a note once; refuses a busy or composing open note with NoteBusyError and writes nothing. */
  processNote(path: string, fn: (text: string) => string): Promise<unknown>;
  /** The scan image store's vault access. */
  images: ImageStoreDeps;
  /** Every image path in the vault (`vault_list_images`), for name-only embeds. */
  listImages(): Promise<string[]>;
  decoder: PageDecoder;
  /** Width, in pixels, scans are shown at in notes; 0 shows them full size. */
  embedWidth(): number;
  /** The transform that dates a note a scan was filed in (identity when the setting is off). */
  stampNote(path: string): (text: string) => string;
  /** Resolves once note lookups are ready (the note-ID index's first build). */
  ready?(): Promise<void>;
}

/** An image in the unmatched queue: its vault path and file name. */
export interface UnmatchedItem {
  path: string;
  name: string;
}

/** Where a queued image is filed by hand: the note, its unit operation (0: the note-level section), the page and, if known, the print date. */
export interface ManualTarget {
  note: NoteRef;
  unitOpIndex: number;
  page: { page: number; pageCount: number };
  /** `YYYY-MM-DD`, when the user gave it. */
  printedOn?: string;
}

/** Checks, before a write, that the vault the run started in is still open; rejects (NetError cancelled) otherwise. */
export interface WriteGuard {
  check(): Promise<void>;
}

const noGuard: WriteGuard = { check: async () => undefined };

export interface RunOptions {
  /** Shared folders hold other photos too: pass over pages without our QR quietly. */
  skipNoQr?: boolean;
  /** The vault guard taken when the batch started (D11); none for a run that cannot outlive its vault. */
  guard?: WriteGuard;
  onProgress?: (done: number, label: string) => void;
}

interface Pending {
  notePath: string;
  payload: PagePayload;
  entry: ScanEntry;
  result: ScanResult;
}

/** How long to wait before writing again into a note that was busy (composing). */
export const BUSY_RETRY_MS = 1000;
/** How many times to wait: 30 s in all, then the pages go to the unmatched queue. */
export const BUSY_RETRIES = 30;

export const ZIP_LIMITS = { entries: 200, entryBytes: 100 * 1024 * 1024, totalBytes: 500 * 1024 * 1024 };
const ZIP_MEMBER_RE = /\.(jpe?g|png|webp|gif|bmp|pdf|heic|heif|tiff?)$/i;

/** The page files of a zip, by file name only (folders inside are flattened), within safe limits. */
export function unzipScans(bytes: ArrayBuffer): { files: ScanInput[]; overLimit: boolean } {
  let count = 0;
  let total = 0;
  let overLimit = false;
  const entries = unzipSync(new Uint8Array(bytes), {
    filter: (f) => {
      const name = f.name.split('/').pop() ?? '';
      if (f.name.startsWith('__MACOSX/') || name.startsWith('.') || !ZIP_MEMBER_RE.test(name)) return false;
      if (count >= ZIP_LIMITS.entries || f.originalSize > ZIP_LIMITS.entryBytes || total + f.originalSize > ZIP_LIMITS.totalBytes) {
        overLimit = true;
        return false;
      }
      count++;
      total += f.originalSize;
      return true;
    },
  });
  const files = Object.entries(entries)
    .map(([path, data]) => ({
      name: path.split('/').pop() ?? path,
      bytes: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return { files, overLimit };
}

/** The vault path in an image embed line (`![[a.jpg|300]]`, `![](images/a.jpg)`). */
export function embedLinkPath(embed: string): string | undefined {
  const wiki = /^!\[\[([^\]|#]+)/.exec(embed);
  if (wiki) return wiki[1].trim();
  const md = /^!\[[^\]]*\]\(<?([^)>]+)>?\)/.exec(embed);
  if (!md) return undefined;
  try {
    return decodeURI(md[1].trim());
  } catch {
    return md[1].trim();
  }
}

/** Longest source name a caption keeps. */
const MAX_SOURCE_NAME = 120;

/**
 * A source file name made safe for the caption line written into the note
 * (SP7 B9): the base name after both `/` and `\`, without control characters
 * or line breaks, with `[ ] | < > # ^` and backticks replaced by `_` (as
 * `unmatchedFileName` does), at most 120 characters. A scanned or zipped file
 * name can then never start a heading, a link or an embed in the note.
 */
export function safeSourceName(source: string): string {
  const base = source.slice(Math.max(source.lastIndexOf('/'), source.lastIndexOf('\\')) + 1);
  return base
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '')
    .replace(/[[\]|<>#^`]/g, '_')
    .slice(0, MAX_SOURCE_NAME);
}

/** The vault was switched (a guard check, or a request the switch cancelled): the run ends here. */
export const isCancelled = (e: unknown): boolean => e instanceof NetError && e.kind === 'cancelled';

const isBusy = (e: unknown): boolean => e instanceof NoteBusyError || (e instanceof Error && e.name === 'NoteBusyError');

const wait = (ms: number) => new Promise<void>((resolve) => globalThis.setTimeout(resolve, ms));

export class ScanPipeline {
  constructor(private readonly deps: PipelineDeps) {}

  async run(inputs: readonly ScanInput[], opts: RunOptions = {}): Promise<ScanResult[]> {
    await this.deps.ready?.();
    const results: ScanResult[] = [];
    const pending: Pending[] = [];
    const batchHashes = new Set<string>();
    const noteText = new Map<string, string>();
    // Written by this run: unlinked until `flush`, yet not leftovers to reuse (#483).
    const saved = new Set<string>();
    let done = 0;
    for (const input of inputs) {
      opts.onProgress?.(done, input.name);
      const first = results.length;
      try {
        const rest = await this.deps.decoder.expand(input, async (page) => {
          results.push(await this.filePage(page, opts, pending, batchHashes, noteText, saved));
          opts.onProgress?.(++done, input.name);
        });
        results.push(...rest);
      } catch (err) {
        if (isCancelled(err)) throw err;
        console.error('[labnoteo] scan failed:', input.name, err);
        results.push({ source: input.name, status: 'error', message: err instanceof Error ? err.message : String(err) });
      }
      for (let i = first; i < results.length; i++) results[i].input = input.name;
    }
    await this.flush(pending, opts.guard ?? noGuard);
    return results;
  }

  private async readNote(path: string, cache: Map<string, string>): Promise<string> {
    let text = cache.get(path);
    if (text === undefined) {
      text = await this.deps.fs.read(path);
      cache.set(path, text);
    }
    return text;
  }

  private async filePage(
    page: DecodedPage,
    opts: RunOptions,
    pending: Pending[],
    batchHashes: Set<string>,
    noteText: Map<string, string>,
    saved: Set<string>,
  ): Promise<ScanResult> {
    const base: ScanResult = { source: page.source, sourcePage: page.sourcePage, status: 'error', hash: page.hash };
    const guard = opts.guard ?? noGuard;
    if (page.error !== undefined) return { ...base, status: 'error', message: page.error };
    // Never dropped, never filed from a page missing its image (User Decision 2026-11-09).
    if (page.unsupportedImage) return this.unmatched(page, base, 'pdf-image', guard);
    if (page.blank) return { ...base, status: 'blank' };
    const payload = page.payload;
    if (!payload) {
      if (opts.skipNoQr) return { ...base, status: 'skipped', reason: 'no-qr' };
      return this.unmatched(page, base, 'no-qr', guard);
    }
    base.payload = payload;
    const files = this.deps.noteIds.filesWithId(payload.noteId);
    if (files.length === 0) return this.unmatched(page, base, 'note-not-found', guard);
    if (files.length > 1) return this.unmatched(page, base, 'duplicate-id', guard);
    if (!isPagePayload(payload)) return this.unmatched(page, base, 'note-only', guard);
    const notePath = files[0].path;
    base.notePath = notePath;

    const text = await this.readNote(notePath, noteText);
    // Before the block is looked for: a page filed by hand after its block was renamed is there (#495).
    const filed = listFiledScans(text);
    const same = filed.filter((s) => s.hash === page.hash);
    for (const s of same) if (await this.imageExists(s.embed, notePath)) return { ...base, status: 'duplicate' };
    const target = resolveScanTarget(listUnitOpBlocks(text), payload.unitOpIndex, payload.opId, payload.fingerprint);
    if (target.kind === 'missing') return this.unmatched(page, base, 'no-unit-op', guard);
    if (target.kind === 'ambiguous') return this.unmatched(page, base, 'ambiguous', guard);
    if (target.kind === 'renamed') return this.unmatched(page, base, 'renamed', guard);
    if (batchHashes.has(page.hash)) return { ...base, status: 'duplicate' };
    // Its image was deleted: file it again in place of the entry left behind (#432).
    const replacesMissing = same.length > 0;
    batchHashes.add(page.hash);

    const unitOpIndex = target.kind === 'block' ? target.block.index : 0;
    const previous = filed
      .filter((s) => s.unitOpIndex === unitOpIndex && s.page === payload.page && s.hash !== page.hash)
      .map((s) => ({ hash: s.hash, embed: s.embed }));
    // A deleted image's name stays taken while an entry still links it (#433).
    const linked = new Set(
      filed
        .filter((s) => s.hash !== page.hash)
        .map((s) => posix.basename(embedLinkPath(s.embed) ?? '').toLowerCase())
        .filter(Boolean),
    );
    const stored = await this.store(notePath, payload, unitOpIndex, await page.render(), saved, guard, linked);
    const result: ScanResult = {
      ...base,
      status: 'filed',
      imagePath: stored.path,
      previous,
      ...(replacesMissing ? { replacedMissing: true } : {}),
    };
    if (target.kind === 'block') {
      const { opId, opName, alias } = target.block;
      result.block = `[${opId} ${opName}]${alias ? ` ${alias}` : ''}`;
      result.matchedBy = target.by;
      result.legacy = !payload.fingerprint;
    }
    pending.push({
      notePath,
      payload,
      result,
      entry: {
        page: payload.page,
        pageCount: payload.pageCount,
        hash: page.hash,
        embed: stored.embed,
        caption: this.caption(payload, page),
        fullSizeLink: stored.fullSizeLink,
      },
    });
    return result;
  }

  /** Whether the image a filed scan embeds is still in the vault, found the way the editor finds it. */
  private async imageExists(embed: string, notePath: string): Promise<boolean> {
    return (await this.resolveEmbed(embed, notePath)) !== null;
  }

  /** The vault path of the image an embed shows, found the way the editor finds it; null when it is not there. */
  private async resolveEmbed(embed: string, notePath: string): Promise<string | null> {
    const wiki = /^!\[\[([^\]|#]+)/.exec(embed);
    const md = wiki ? null : /^!\[[^\]]*\]\(([^)]+)\)/.exec(embed);
    const target = wiki?.[1] ?? md?.[1];
    if (!target) return null;
    const ref = resolveImagePath(notePath, target, wiki ? 'wiki' : 'md');
    if (!ref) return null;
    try {
      if (ref.kind === 'paths') {
        for (const candidate of ref.candidates) if (await this.deps.images.exists(candidate)) return candidate;
        return null;
      }
      const list = await this.deps.listImages();
      const found = pickByName(notePath, ref.name, list) ?? (ref.fallback ? pickByName(notePath, ref.fallback, list) : null);
      return found !== null && (await this.deps.images.exists(found)) ? found : null;
    } catch {
      return null;
    }
  }

  /** Whether `name` names one image only in the vault, so an embed of the name alone finds it. */
  private async isUniqueName(name: string): Promise<boolean> {
    const want = name.toLowerCase();
    try {
      return (await this.deps.listImages()).filter((p) => posix.basename(p).toLowerCase() === want).length === 1;
    } catch {
      return false;
    }
  }

  private async store(
    notePath: string,
    payload: PagePayload,
    unitOpIndex: number,
    jpeg: ArrayBuffer,
    saved: Set<string>,
    guard: WriteGuard,
    avoid?: ReadonlySet<string>,
  ) {
    const dir = getExperimentDir(notePath) ?? posix.dirname(notePath);
    const name = scanFileName(payload.noteId, unitOpIndex, payload.page, getSeoulDateString());
    await guard.check();
    const file = await saveBinary(this.deps.images, posix.join(dir, SCANS_SUBFOLDER), name, jpeg, avoid, { skip: saved });
    saved.add(file.path);
    const width = this.deps.embedWidth();
    const target = (await this.isUniqueName(file.name)) ? file.name : file.path;
    const embed = width > 0 ? `![[${target}|${width}]]` : `![[${target}]]`;
    const fullSizeLink = width > 0 ? `[[${target}|${this.deps.t('Open full size')}]]` : undefined;
    return { path: file.path, embed, fullSizeLink };
  }

  private caption(payload: PagePayload, page: Pick<DecodedPage, 'source' | 'sourcePage'>): string {
    const name = safeSourceName(page.source);
    const source = page.sourcePage ? `${name} p.${page.sourcePage}` : name;
    if (!payload.printedOn) {
      return this.deps.t('Printout {0}/{1} · imported {2} · {3}', String(payload.page), String(payload.pageCount), getSeoulDateString(), source);
    }
    return this.deps.t(
      'Printout {0}/{1} · printed {2} · imported {3} · {4}',
      String(payload.page),
      String(payload.pageCount),
      payload.printedOn,
      getSeoulDateString(),
      source,
    );
  }

  private async unmatched(page: DecodedPage, base: ScanResult, reason: UnmatchedReason, guard: WriteGuard): Promise<ScanResult> {
    const payload = base.payload && isPagePayload(base.payload) ? base.payload : undefined;
    const name = unmatchedFileName(timestamp(), page.source, base.payload?.noteId, page.sourcePage, {
      payload,
      reason,
      hash: page.hash,
    });
    const bytes = await page.render();
    await guard.check();
    const file = await saveBinary(this.deps.images, UNMATCHED_FOLDER, name, bytes);
    return { ...base, status: 'unmatched', reason, unmatchedPath: file.path };
  }

  /** processNote, waiting out a busy (composing) note: every second, for up to 30 s. The guard is checked before each try. */
  private async processWhenFree(notePath: string, fn: (text: string) => string, guard: WriteGuard = noGuard): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      await guard.check();
      try {
        await this.deps.processNote(notePath, fn);
        return;
      } catch (err) {
        if (!isBusy(err) || attempt >= BUSY_RETRIES) throw err;
        await wait(BUSY_RETRY_MS);
      }
    }
  }

  /** Write every note of the batch once, dating it in the same write. */
  private async flush(pending: readonly Pending[], guard: WriteGuard = noGuard): Promise<void> {
    const byNote = new Map<string, Pending[]>();
    for (const p of pending) byNote.set(p.notePath, [...(byNote.get(p.notePath) ?? []), p]);
    for (const [notePath, items] of byNote) {
      const missed = new Map<Pending, UnmatchedReason>();
      const stamp = this.deps.stampNote(notePath);
      const apply = (content: string): string => {
        missed.clear();
        let out = content;
        for (const item of items) {
          const { unitOpIndex, opId, fingerprint } = item.payload;
          let target = resolveScanTarget(listUnitOpBlocks(out), unitOpIndex, opId, fingerprint);
          if (item.result.replacedMissing && (target.kind === 'block' || target.kind === 'note')) {
            out = removeScanEntry(out, item.entry.hash).md;
            target = resolveScanTarget(listUnitOpBlocks(out), unitOpIndex, opId, fingerprint);
          }
          if (target.kind === 'block') out = insertScanEntries(out, target.block, [item.entry]);
          else if (target.kind === 'note') out = insertScanEntries(out, null, [item.entry]);
          else missed.set(item, target.kind === 'missing' ? 'no-unit-op' : target.kind);
        }
        return out === content ? out : stamp(out);
      };
      try {
        await this.processWhenFree(notePath, apply, guard);
      } catch (err) {
        if (isCancelled(err)) throw err;
        if (isBusy(err)) {
          // Still busy after 30 s: nothing was written; queue every page rather than lose one.
          console.warn('[labnoteo] note stayed busy; scans queued:', notePath);
          missed.clear();
          for (const item of items) missed.set(item, 'note-busy');
        } else {
          console.error('[labnoteo] could not file scans in', notePath, err);
          for (const item of items) Object.assign(item.result, { status: 'error', message: String(err) });
          continue;
        }
      }
      // The note changed between reading and writing so that the unit operation is gone, or it stayed busy.
      for (const [item, reason] of missed) {
        try {
          const imagePath = item.result.imagePath;
          if (!imagePath) throw new Error('Saved scan image is missing');
          const bytes = await this.deps.images.readBinary(imagePath);
          const queued = await this.unmatched(
            {
              source: item.result.source,
              sourcePage: item.result.sourcePage,
              hash: item.entry.hash,
              blank: false,
              render: async () => bytes,
            },
            item.result,
            reason,
            guard,
          );
          Object.assign(item.result, queued);
          await guard.check();
          await this.deps.fs.trash(imagePath);
          delete item.result.imagePath;
        } catch (err) {
          if (isCancelled(err)) throw err;
          Object.assign(item.result, { status: 'error', message: String(err) });
        }
      }
    }
  }

  /**
   * File an image from the unmatched queue by hand into `target.note`'s
   * `target.unitOpIndex`-th unit operation (0: the note-level section). Without the
   * QR code the print date is known only if the user gave it (`printedOn`,
   * `YYYY-MM-DD`); otherwise the caption leaves it out (#234). The chosen
   * block's fingerprint goes along, so the scan is not taken for an old
   * printout (#341) and goes back to the queue if that block changed
   * meanwhile rather than to its neighbour.
   */
  async fileManually(item: UnmatchedItem, target: ManualTarget): Promise<ScanResult> {
    const { note, unitOpIndex, page, printedOn } = target;
    const ensured = await this.deps.noteIds.ensureIdResult(note);
    if (ensured.reason === 'cancelled') return { source: item.name, status: 'skipped', reason: 'cancelled' };
    const noteId = ensured.id;
    if (!noteId) return { source: item.name, status: 'error', message: 'front matter could not be read' };
    const bytes = await this.deps.images.readBinary(item.path);
    // The queue keeps the page as JPEG; the hash of the scan as imported is in its name (#495).
    const hash = unmatchedInfoFromName(item.name).hash ?? shortHash(await sha256Hex(bytes));
    const block = unitOpIndex > 0 ? listUnitOpBlocks(await this.deps.fs.read(note.path))[unitOpIndex - 1] : undefined;
    const payload: PagePayload = {
      noteId,
      unitOpIndex: block?.index ?? 0,
      opId: block?.opId ?? '',
      ...page,
      // Never encoded into a QR code, so '' may stand for "not known".
      printedOn: printedOn ?? '',
      ...(block ? { fingerprint: unitOpFingerprint(block.opName, block.alias) } : {}),
    };
    const decoded: DecodedPage = {
      source: sourceNameFromUnmatched(item.name),
      hash,
      blank: false,
      payload,
      render: async () => bytes,
    };
    const pending: Pending[] = [];
    const result = await this.filePage(decoded, {}, pending, new Set(), new Map(), new Set());
    await this.flush(pending);
    if (result.status === 'filed' || result.status === 'duplicate') await this.trashIfThere(item.path);
    if (result.status === 'unmatched' && result.unmatchedPath) {
      // The image is still in the queue; the copy filePage made there is not needed.
      if (result.unmatchedPath !== item.path) await this.trashIfThere(result.unmatchedPath);
      result.unmatchedPath = item.path;
    }
    return result;
  }

  /** Take a filed scan out of its note again and trash its image. */
  async undo(result: ScanResult): Promise<boolean> {
    if (result.status !== 'filed' || !result.notePath || !result.hash) return false;
    const hash = result.hash;
    const stamp = this.deps.stampNote(result.notePath);
    let removed = false;
    await this.processWhenFree(result.notePath, (content) => {
      const out = removeScanEntry(content, hash);
      removed = out.removed;
      return out.removed ? stamp(out.md) : out.md;
    });
    if (result.imagePath) await this.trashIfThere(result.imagePath);
    return removed;
  }

  /** Remove the earlier scans of the page `result` filed (and trash their images). */
  async removePrevious(result: ScanResult): Promise<number> {
    if (!result.notePath || !result.previous?.length) return 0;
    const notePath = result.notePath;
    const previous = result.previous;
    const images: string[] = [];
    for (const p of previous) {
      const path = await this.resolveEmbed(p.embed, notePath);
      // An earlier entry may link the name this scan's image took (#433).
      if (path !== null && path !== result.imagePath && !images.includes(path)) images.push(path);
    }
    const stamp = this.deps.stampNote(notePath);
    let count = 0;
    await this.processWhenFree(notePath, (content) => {
      count = 0;
      let out = content;
      for (const p of previous) {
        const r = removeScanEntry(out, p.hash);
        if (r.removed) count++;
        out = r.md;
      }
      return count > 0 ? stamp(out) : out;
    });
    for (const image of images) await this.trashIfThere(image);
    result.previous = [];
    return count;
  }

  /** Send `path` to the Recycle Bin when it is still there (the plugin's `instanceof TFile` check). */
  private async trashIfThere(path: string): Promise<void> {
    if (await this.deps.images.exists(path)) await this.deps.fs.trash(path);
  }
}
