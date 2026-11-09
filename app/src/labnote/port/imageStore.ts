// Ported from app/vendor/labnoteo/src/scan/imageStore.ts:1-22 sha256:3015df3e137d5f6e
// Ported from app/vendor/labnoteo/src/scan/imageStore.ts:41-226 sha256:bd87c98d72d4cb3b
// labnoteO 0.140.2, Apache-2.0.
// Changes: the name helpers at :23-39 (scanFileName, noteIdFromFiledScanEmbed, isScanOfNote) are re-exported from
// ./scanNames (Part A); saveBinary takes ImageStoreDeps instead of the Obsidian App and returns the written
// { path, name } instead of a TFile; vault.getAbstractFileByPath becomes deps.exists (vault_exists) and
// vault.readBinary deps.readBinary (vault_read_image), and a twin that cannot be read is passed over;
// vault.createBinary becomes deps.writeScanImage (scan_write_image, which creates exactly the name), retried with
// the next freeName on an `exists` refusal (a name taken between the check and the write); ensureFolder is
// dropped (scan_write_image creates missing folders); normalizePath becomes posix.normalize; unlinkedTwin's
// metadataCache.resolvedLinks becomes "no .md in deps.backlinks (LinkIndex.backlinks) names it".
/**
 * Where scanned pages are stored in the vault: next to the experiment's other
 * images under `images/scans/`, named after the note ID so moving a note can
 * take its scans along, and the unmatched queue at the vault root.
 */
import * as posix from '@labnoteo/core/posix';
import type { PagePayload } from '@labnoteo/core/lib/scanPayload';
import { ERROR_KINDS, hasErrorKind } from '../../fs/errorKinds';

export { isScanOfNote, noteIdFromFiledScanEmbed, scanFileName } from './scanNames';

export const SCANS_SUBFOLDER = 'images/scans';
/** Pages no note could be found for. Outside `labnote/` and git-ignored. */
export const UNMATCHED_FOLDER = '_labnote-scans/unmatched';
/** Short content hash written beside each filed scan. */
export const HASH_LENGTH = 12;

export async function sha256Hex(bytes: ArrayBuffer | Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

export const shortHash = (hex: string): string => hex.slice(0, HASH_LENGTH);

/** What the image store needs from the vault (the app's IPC and link index). */
export interface ImageStoreDeps {
  /** `vault_exists`: whether a file or folder is at the vault path. */
  exists(path: string): Promise<boolean>;
  /** `vault_read_image`: the bytes of an image in the vault. */
  readBinary(path: string): Promise<ArrayBuffer>;
  /** `scan_write_image`: writes exactly `dir/name` and refuses with `exists` when it is taken; gives the vault path. */
  writeScanImage(dir: string, name: string, bytes: Uint8Array): Promise<string>;
  /** `LinkIndex.backlinks`: the files that link the vault path. */
  backlinks(path: string): ReadonlyArray<{ source: string }>;
}

/** An image the store wrote or reused. */
export interface StoredImage {
  path: string;
  name: string;
}

/** `name`, or `name_2`, `name_3`… before the extension, whichever is free in `taken`. */
export function freeName(name: string, taken: (candidate: string) => boolean): string {
  if (!taken(name)) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 2; ; i++) {
    const candidate = `${stem}_${i}${ext}`;
    if (!taken(candidate)) return candidate;
  }
}

/** {@link freeName} with an async `taken`. */
async function freeNameAsync(name: string, taken: (candidate: string) => Promise<boolean>): Promise<string> {
  if (!(await taken(name))) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 2; ; i++) {
    const candidate = `${stem}_${i}${ext}`;
    if (!(await taken(candidate))) return candidate;
  }
}

/**
 * Write `bytes` as `folder/name` (renamed when taken) and return the file.
 * With `reuseUnlinked`, a file the name or its `_N` variants already hold with
 * the same bytes is returned instead when no note links it and it is not in
 * `reuseUnlinked.skip` (written by this import, whose links are not in yet):
 * the image left behind when an entry was undone in the editor (#483).
 */
export async function saveBinary(
  deps: ImageStoreDeps,
  folder: string,
  name: string,
  bytes: ArrayBuffer,
  avoid?: ReadonlySet<string>,
  reuseUnlinked?: { skip: ReadonlySet<string> }
): Promise<StoredImage> {
  const dir = posix.normalize(folder);
  // Names `scan_write_image` refused as taken since the check (another write got there first).
  const refused = new Set<string>();
  // `avoid`: lower-case names still linked from a note though their file is gone.
  const taken = async (candidate: string): Promise<boolean> =>
    refused.has(candidate) || !!avoid?.has(candidate.toLowerCase()) || (await deps.exists(posix.join(dir, candidate)));
  let finalName = await freeNameAsync(name, taken);
  if (reuseUnlinked) {
    const leftover = await unlinkedTwin(deps, dir, name, finalName, bytes, avoid, reuseUnlinked.skip);
    if (leftover) return leftover;
  }
  const data = new Uint8Array(bytes);
  for (;;) {
    try {
      const path = await deps.writeScanImage(dir, finalName, data);
      return { path, name: finalName };
    } catch (e) {
      if (!hasErrorKind(e, ERROR_KINDS.exists)) throw e;
      refused.add(finalName);
      finalName = await freeNameAsync(name, taken);
    }
  }
}

/** The names {@link freeName} passed over before `free`, holding `bytes` and linked from no note. */
async function unlinkedTwin(
  deps: ImageStoreDeps,
  dir: string,
  name: string,
  free: string,
  bytes: ArrayBuffer,
  avoid: ReadonlySet<string> | undefined,
  skip: ReadonlySet<string>
): Promise<StoredImage | undefined> {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 1; ; i++) {
    const candidate = i === 1 ? name : `${stem}_${i}${ext}`;
    if (candidate === free) return undefined;
    const path = posix.join(dir, candidate);
    if (avoid?.has(candidate.toLowerCase()) || skip.has(path) || !(await deps.exists(path))) continue;
    if (deps.backlinks(path).some(b => /\.md$/i.test(b.source))) continue;
    let held: ArrayBuffer;
    try {
      held = await deps.readBinary(path);
    } catch {
      continue; // a folder, or a file that went away meanwhile
    }
    if (sameBytes(held, bytes)) return { path, name: candidate };
  }
}

function sameBytes(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

/** Why a page went to the unmatched queue; kept in its file name (#349). */
const UNMATCHED_REASONS = ['no-qr', 'note-not-found', 'duplicate-id', 'note-only', 'no-unit-op', 'ambiguous', 'renamed'];

/** What the QR code of a queued page said, and why it was not filed (#349). */
export interface UnmatchedInfo {
  noteId?: string;
  /** The unit operation and page the QR code named, without the note ID. */
  page?: Omit<PagePayload, 'noteId'>;
  reason?: string;
  /** The hash of the page as scanned, before the queue stored it as JPEG (#495). */
  hash?: string;
  /** The extension of the scanned file (`png`, `pdf`). */
  sourceExt?: string;
}

/**
 * Unmatched page file name, keeping the note ID when one was read:
 * `20261016-093012_LN-7K3M9QX2_IMG_1234_p2.jpg`. With `info`, the rest of
 * the QR code and the reason go after the note ID, so the assignment can
 * offer them (#349): `…_LN-7K3M9QX2_q2-UHW290-1o3-261025-K7QD_renamed_IMG_1234.jpg`.
 * With `info.hash`, the page's hash and the scanned file's extension follow
 * (`…_renamed_h953d461ec519-png_IMG_1234.jpg`), so filing it by hand later
 * records the hash a new import of the same scan gives (#495).
 */
export function unmatchedFileName(
  stamp: string,
  sourceName: string,
  noteId: string | undefined,
  page?: number,
  info: { payload?: PagePayload; reason?: string; hash?: string } = {}
): string {
  const stem = sourceName.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|#^[\]]/g, '_').slice(0, 60);
  const pagePart = page !== undefined ? `_p${page}` : '';
  const p = info.payload;
  const date = p && /^\d{4}-\d{2}-\d{2}$/.test(p.printedOn) ? p.printedOn.slice(2).replace(/-/g, '') : '';
  const qr = p && date ? `_q${p.unitOpIndex}-${p.opId || '-'}-${p.page}o${p.pageCount}-${date}${p.fingerprint ? `-${p.fingerprint}` : ''}` : '';
  const reason = info.reason && UNMATCHED_REASONS.includes(info.reason) ? `_${info.reason}` : '';
  const ext = /\.([A-Za-z0-9]{1,5})$/.exec(sourceName)?.[1].toLowerCase();
  const hash = info.hash && /^[0-9a-f]+$/.test(info.hash) ? `_h${info.hash}${ext ? `-${ext}` : ''}` : '';
  return `${stamp}_${noteId ?? 'unknown'}${qr}${reason}${hash}_${stem}${pagePart}.jpg`;
}

const UNMATCHED_NAME_RE = new RegExp(
  '^\\d{8}-\\d{6}_(LN-[0-9A-HJKMNP-TV-Z]{8}|unknown)' +
    '(?:_q(\\d{1,3})-([A-Z]+\\d+|-)-(\\d{1,3})o(\\d{1,3})-(\\d{2})(\\d{2})(\\d{2})(?:-([0-9A-HJKMNP-TV-Z]{4}))?)?' +
    `(?:_(${UNMATCHED_REASONS.join('|')}))?` +
    `(?:_h([0-9a-f]{${HASH_LENGTH}})(?:-([a-z0-9]{1,5}))?)?_`
);

/**
 * The source file name an unmatched page's `name` ends in, without the
 * stamp, note ID, QR fields and reason {@link unmatchedFileName} put before
 * it (#396); `name` itself when it is not such a name. A name that kept the
 * scanned file's extension gets it back, and a PDF page reads as the caption
 * of an imported one does (`scan.pdf p.2`).
 */
export function sourceNameFromUnmatched(name: string): string {
  const m = UNMATCHED_NAME_RE.exec(name);
  if (!m || name.length <= m[0].length) return name;
  const rest = name.slice(m[0].length);
  const ext = m[12];
  const parts = ext ? /^(.*?)(?:_p(\d+))?\.jpg$/i.exec(rest) : null;
  if (!parts) return rest;
  if (ext === 'pdf' && parts[2]) return `${parts[1]}.pdf p.${parts[2]}`;
  return `${parts[1]}${parts[2] ? `_p${parts[2]}` : ''}.${ext}`;
}

/** What {@link unmatchedFileName} kept in `name`; older names give the note ID only. */
export function unmatchedInfoFromName(name: string): UnmatchedInfo {
  const m = UNMATCHED_NAME_RE.exec(name);
  if (!m) return {};
  const info: UnmatchedInfo = {};
  if (m[1] !== 'unknown') info.noteId = m[1];
  if (m[2] !== undefined) {
    info.page = {
      unitOpIndex: Number(m[2]),
      opId: m[3] === '-' ? '' : m[3],
      page: Number(m[4]),
      pageCount: Number(m[5]),
      printedOn: `20${m[6]}-${m[7]}-${m[8]}`,
      ...(m[9] ? { fingerprint: m[9] } : {}),
    };
  }
  if (m[10]) info.reason = m[10];
  if (m[11]) info.hash = m[11];
  if (m[12]) info.sourceExt = m[12];
  return info;
}

/** The note ID recorded in an unmatched page's file name, if any. */
export function noteIdFromUnmatchedName(name: string): string | undefined {
  return unmatchedInfoFromName(name).noteId;
}

export function timestamp(date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}
