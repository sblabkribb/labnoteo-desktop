// Ported from app/vendor/labnoteo/src/scan/unmatchedModal.ts:16-155 sha256:2efbb085345b7472
// labnoteO 0.140.2, Apache-2.0.
// Changes: listUnmatched(app) becomes listUnmatched(images), filtering the vault_list_images paths to the files
// directly in UNMATCHED_FOLDER and giving { path, name } items; the Modal half (render, thumbnails, Delete) is the
// React dialog scan/UnmatchedDialog.tsx, where thumbnails are readVaultImage blob URLs revoked on close, window.open
// becomes an in-dialog zoom, the inline img styles become .scan-thumb and fileManager.trashFile becomes fs.trash
// (Recycle Bin); UnmatchedModal.assign(file) becomes assignUnmatched(feature, item) over AssignDeps:
// app.vault.getMarkdownFiles() becomes feature.notes() (the note-ID index's NoteRefs once it is ready, read before
// filesWithId so the hint sees the built index; the hinted note is compared by path), app.vault.read becomes
// feature.read, f.parent?.path becomes the folder part of the path ('/' at the root),
// pipeline.fileManually(file, note, unitOp, page, printedOn) becomes fileManually(item, { note, unitOpIndex, page,
// printedOn }), `new Notice` becomes host.notify('info', …), and the result is returned
// (undefined when the user cancelled a step), so the dialog can be shown again; the Translator is host.t.
/**
 * "Assign unmatched scans": pages no note was found for, filed by hand
 * (note → unit operation → page → print date) or deleted.
 */
import type { LabnoteHost, PickItem } from '@labnoteo/core';
import { listUnitOpBlocks } from '@labnoteo/core';
import { isValidWorkflowPath } from '@labnoteo/core/lib/workflowStructure';
import type { NoteRef } from '../barcode/noteIdIndex';
import { UNMATCHED_FOLDER, unmatchedInfoFromName } from './imageStore';
import type { NoteIdService } from './noteIdService';
import type { ScanPipeline, ScanResult, UnmatchedItem } from './scanPipeline';
import { describeResult } from './scanResults';

const IMAGE_RE = /\.(jpe?g|png|webp)$/i;

/** The images directly in the unmatched queue folder, by name. */
export function listUnmatched(images: readonly string[]): UnmatchedItem[] {
  const prefix = `${UNMATCHED_FOLDER}/`;
  return images
    .filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
    .map((path) => ({ path, name: path.slice(prefix.length) }))
    .filter((f) => IMAGE_RE.test(f.name))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** "2/3" → page 2 of 3; "2" → page 2 of 2. */
export function parsePageInput(value: string): { page: number; pageCount: number } | undefined {
  const m = /^\s*(\d{1,3})\s*(?:\/\s*(\d{1,3}))?\s*$/.exec(value);
  if (!m) return undefined;
  const page = Number(m[1]);
  const pageCount = m[2] ? Number(m[2]) : page;
  return page >= 1 && pageCount >= page ? { page, pageCount } : undefined;
}

/** Whether `value` is a real calendar date written `YYYY-MM-DD`. */
export function isDateInput(value: string): boolean {
  const m = /^\s*(\d{4})-(\d{2})-(\d{2})\s*$/.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

/** What filing a queued page by hand needs. */
export interface AssignDeps {
  host: LabnoteHost;
  pipeline: Pick<ScanPipeline, 'fileManually'>;
  noteIds: Pick<NoteIdService, 'filesWithId'>;
  /** Every Markdown note of the vault. */
  notes(): Promise<readonly NoteRef[]>;
  /** A note's text (an open note's buffer). */
  read(path: string): Promise<string>;
}

const folderOf = (path: string): string => {
  const i = path.lastIndexOf('/');
  return i < 0 ? '/' : path.slice(0, i);
};

/**
 * Ask for the note, the unit operation, the page and the print date of a
 * queued page, then file it. Undefined when the user cancelled a step.
 */
export async function assignUnmatched(feature: AssignDeps, item: UnmatchedItem): Promise<ScanResult | undefined> {
  const { host } = feature;
  const info = unmatchedInfoFromName(item.name);
  // The note list first: it waits for the note-ID index, which filesWithId reads.
  const all = await feature.notes();
  const hinted = info.noteId ? feature.noteIds.filesWithId(info.noteId)[0] : undefined;
  const isHinted = (f: NoteRef) => !!hinted && f.path === hinted.path;
  const notes = all
    .filter((f) => isValidWorkflowPath(f.path))
    .sort((a, b) => (isHinted(a) ? -1 : isHinted(b) ? 1 : a.path.localeCompare(b.path)));
  const note = await host.pick(
    notes.map((f) => ({
      label: f.basename.replace(/\.labnote$/, ''),
      description: isHinted(f) ? host.t('from the QR code') : undefined,
      detail: folderOf(f.path),
      value: f,
    })),
    { title: host.t('Assign to which note?'), placeholder: host.t('Search workflow notes') },
  );
  if (!note) return undefined;
  const blocks = listUnitOpBlocks(await feature.read(note.path));
  const items: PickItem<number>[] = [
    ...blocks.map((b) => ({ label: `${b.index}. [${b.opId} ${b.opName}]${b.alias ? ` ${b.alias}` : ''}`, value: b.index })),
    { label: host.t('The whole note (no unit operation)'), value: 0 },
  ];
  // What the QR code said only holds for the note it named (#349).
  const qr = isHinted(note) ? info.page : undefined;
  const title = host.t('Assign to which unit operation?');
  let pickTitle = title;
  if (qr && qr.unitOpIndex > 0) {
    // Offered first only while that position still holds the same ID: a
    // block deleted since puts the next one there (#304).
    const at = items.findIndex((i) => i.value === qr.unitOpIndex);
    if (at >= 0 && blocks[at]?.opId === qr.opId) {
      const [same] = items.splice(at, 1);
      items.unshift({ ...same, description: host.t('QR code: unit operation {0}', String(qr.unitOpIndex)) });
    } else {
      pickTitle = `${title} ${host.t('The QR code says unit operation {0} ({1}).', String(qr.unitOpIndex), qr.opId)}`;
    }
  }
  const unitOpIndex = await host.pick(items, { title: pickTitle });
  if (unitOpIndex === undefined) return undefined;
  const pageText = await host.prompt({
    title: host.t('Page'),
    prompt: host.t('Page number on the printout, e.g. 2/3'),
    value: qr ? `${qr.page}/${qr.pageCount}` : '1/1',
    validate: (v) => (parsePageInput(v) ? null : host.t('Enter a page like 2/3.')),
  });
  const page = pageText ? parsePageInput(pageText) : undefined;
  if (!page) return undefined;
  const printedText = await host.prompt({
    title: host.t('Print date'),
    prompt: host.t('When was this page printed (YYYY-MM-DD)? Leave it empty if you do not know or it was never printed.'),
    value: qr?.printedOn ?? '',
    placeholder: 'YYYY-MM-DD',
    validate: (v) => (v.trim() === '' || isDateInput(v) ? null : host.t('Enter a date like 2026-10-15, or leave it empty.')),
  });
  if (printedText === undefined) return undefined;
  const printedOn = printedText.trim() || undefined;
  const result = await feature.pipeline.fileManually(item, { note, unitOpIndex, page, ...(printedOn ? { printedOn } : {}) });
  host.notify('info', describeResult(host.t, result));
  return result;
}
