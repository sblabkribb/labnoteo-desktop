// Ported from app/vendor/labnoteo/src/print/fullNotePrint.ts:17-84 sha256:b019d2e046f55d30
// Ported from app/vendor/labnoteo/src/print/fullNotePrint.ts:87-154 sha256:9fe6358f5c4e3dc0
// labnoteO 0.140.2, Apache-2.0.
// Changes: MarkdownRenderer.render becomes print/noteBlocks.ts renderNoteBlocks (one escaped HTML string per top-level block) over images pre-resolved by deps.images (resolveNoteImages, blob: URLs); the off-screen div with Object.assign(style) becomes deps.measure (print/measure.ts measureNoteBlocks: a sanitized .print-measure.<paper> element in the print root, sized by print.css), which also names unit-op headings, and the 300 ms wait becomes fonts.ready plus the images there; a page body is the blocks' HTML strings, not the rendered elements' outerHTML (print/printRoot.ts sanitizes them again when it mounts the pages); printHtml and openHtmlInBrowser become deps.print (printPages) and deps.openInBrowser('note', noteId, html) over a standalone file built from the sanitized tree with data: images (print/openInBrowser.ts standaloneFromPages); the notice becomes overrideOr('print.openedInBrowser') as a warning; noteTitleOf takes (path, content); the plugin keys go through deps.t (core translator), not a bare t; the note is read through deps.read after its ID is assigned; the images' blob: URLs are released when the job ends.
/**
 * "Print whole note with barcodes": the note rendered as Obsidian renders it,
 * cut into pages between top-level blocks, each page carrying a QR code for
 * the unit operation it starts in (or the note, before the first one).
 *
 * Page breaks are measured off screen at the printed width, so a block never
 * splits across pages unless it is taller than a page by itself (a long table
 * or code block), in which case it is clipped at the page bottom.
 */
import { getSeoulDateString } from '@labnoteo/core/lib/dateUtils';
import { encodePagePayload, payloadLabel, unitOpFingerprint, type PagePayload } from '@labnoteo/core/lib/scanPayload';
import type { WorksheetPaperSize } from '../../../vendor/labnoteo/src/settings';
import { overrideOr } from '../i18n';
import { renderNoteBlocks, type NoteImages } from '../print/noteBlocks';
import { standaloneFromPages } from '../print/openInBrowser';
import { bodyBox, escapeHtml, type PrintPage } from './printPages';
import { noteTitleOf, type WorksheetDeps } from './worksheetPrint';

export interface MeasuredBlock {
  top: number;
  bottom: number;
  /** Set when the block is a unit-operation heading. */
  opId?: string;
  /** {@link unitOpFingerprint} of that heading's name and alias. */
  fingerprint?: string;
}

export interface NotePageSlice {
  /** Index range into the blocks, `[from, to)`. */
  from: number;
  to: number;
  /** Unit operation the page starts in: 1-based index and ID, or 0 and ''. */
  unitOpIndex: number;
  opId: string;
  fingerprint?: string;
}

/**
 * Cut measured blocks into pages of `pageHeight`: a page ends before the
 * block that would overflow it, and every unit operation starts a page, so
 * the scan of a page files under the unit operation written on it (#359).
 */
export function sliceIntoPages(blocks: readonly MeasuredBlock[], pageHeight: number): NotePageSlice[] {
  // The unit operation each block belongs to.
  const opAt: { unitOpIndex: number; opId: string; fingerprint?: string }[] = [];
  let unitOpIndex = 0;
  let opId = '';
  let fingerprint: string | undefined;
  for (const b of blocks) {
    if (b.opId) {
      unitOpIndex++;
      opId = b.opId;
      fingerprint = b.fingerprint;
    }
    opAt.push(fingerprint ? { unitOpIndex, opId, fingerprint } : { unitOpIndex, opId });
  }
  const pages: NotePageSlice[] = [];
  let from = 0;
  for (let i = 0; i < blocks.length; i++) {
    if (i === from) continue;
    if (blocks[i].opId) {
      pages.push({ from, to: i, ...opAt[from] });
      from = i;
      continue;
    }
    if (blocks[i].bottom - blocks[from].top <= pageHeight) continue;
    // Keep a unit operation's heading with what follows it.
    const cut = i - 1 > from && blocks[i - 1].opId ? i - 1 : i;
    pages.push({ from, to: cut, ...opAt[from] });
    from = cut;
  }
  if (blocks.length > from) pages.push({ from, to: blocks.length, ...opAt[from] });
  return pages;
}

const UNIT_OP_TITLE_RE = /^\s*\[([A-Z]+\d+)\s+([^\]]+)\]([^\n]*)/;

/**
 * The unit operation a rendered `h3` heading names. Pages are cut from the
 * rendered note, so its position can differ from the Markdown's (a heading in
 * a code block); the fingerprint comes from the heading's own words (#304).
 */
export function unitOpOfRenderedHeading(text: string): { opId: string; fingerprint: string } | undefined {
  const m = UNIT_OP_TITLE_RE.exec(text);
  return m ? { opId: m[1], fingerprint: unitOpFingerprint(m[2].trim(), m[3].trim()) } : undefined;
}

/** The note's images for one print job: `blob:` URLs, their bytes for the browser file, and the end of the job. */
export interface PrintImages extends NoteImages {
  /** The bytes behind a `src` this job gave out; undefined for any other. */
  blob?(src: string): Promise<Blob | undefined>;
  /** Revoke the job's `blob:` URLs. */
  release?(): void;
}

export interface FullNoteDeps extends WorksheetDeps {
  /** Lay the blocks out at the printed body width; their offsets in px, unit-op headings named, and px per mm. */
  measure(blocks: string[], paper: WorksheetPaperSize): Promise<{ blocks: MeasuredBlock[]; pxPerMm: number }>;
  /** The images the note's image paragraphs embed. */
  images(path: string, md: string): Promise<PrintImages>;
}

export async function printFullNoteCommand(deps: FullNoteDeps, path: string): Promise<void> {
  const { host } = deps;
  const noteId = await deps.ensureNoteId(path);
  if (!noteId) return;
  const paper = deps.paper();
  const box = bodyBox(paper);
  // Read after the ID is assigned: assigning it rewrote the note.
  const content = await deps.read(path);
  const images = await deps.images(path, content);
  try {
    const rendered = renderNoteBlocks(content, images);
    const { blocks, pxPerMm } = await deps.measure(rendered, paper);
    const slices = sliceIntoPages(blocks, box.height * pxPerMm);
    if (slices.length === 0) {
      host.notify('info', deps.t('This note is empty.'));
      return;
    }
    const printedOn = getSeoulDateString();
    const title = noteTitleOf(path, content);
    const pages: PrintPage[] = slices.map((s, i) => {
      const payload: PagePayload = {
        noteId,
        unitOpIndex: s.unitOpIndex,
        opId: s.opId,
        fingerprint: s.fingerprint,
        page: i + 1,
        pageCount: slices.length,
        printedOn,
      };
      return {
        payload: encodePagePayload(payload),
        label: payloadLabel(payload),
        header:
          `<div class="muted">${escapeHtml(noteId)}</div><div class="title">${escapeHtml(title)}</div>` +
          `<div class="muted">${escapeHtml(deps.t('Page {0} of {1} · printed {2}', String(i + 1), String(slices.length), printedOn))}</div>`,
        body: `<div class="note-body">${rendered.slice(s.from, s.to).join('')}</div>`,
        footer: escapeHtml(deps.t('Write on this sheet, then photograph or scan it with a QR code visible and put the file in the scan folder.')),
      };
    });
    try {
      await deps.print(pages, paper);
    } catch (err) {
      console.warn('[labnoteo] printing in the app failed, opening in the browser:', err);
      const read = images.blob ? images.blob.bind(images) : async (): Promise<Blob | undefined> => undefined;
      await deps.openInBrowser('note', noteId, await standaloneFromPages(title, paper, pages, read));
      // The plugin's 'Printing from Obsidian did not work, so the worksheet opened in your browser. Print it from there.'
      host.notify('warn', overrideOr('print.openedInBrowser'));
    }
  } finally {
    images.release?.();
  }
}
