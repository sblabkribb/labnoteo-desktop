// Ported from app/vendor/labnoteo/src/scan/pdfPages.ts:7-66 sha256:a6fb0750c450a3ad
// labnoteO 0.140.2, Apache-2.0.
// Changes: Obsidian's loadPdfJs becomes an injected PdfLib (the app's is pdfjs-dist from scan/pdfjs.ts, without eval,
// without font faces and with a same-origin worker, SP7 B2), so forEachPdfPage(lib, bytes, onPage); PDF_DPI and the
// pdf.js shapes are exported; a page whose getPage, render or bitmap throws (pdf.js decodes JPEG 2000 with
// WebAssembly, which the CSP does not allow) is handed to onPage with `bitmap: null` and its error, and the remaining
// pages continue; page.cleanup and the canvas release run in a finally.
/**
 * Pages of a scanned PDF (a multifunction printer's usual output) as images,
 * rendered one at a time with pdf.js on a detached canvas.
 */

/** Rendering resolution: enough for the QR and for reading handwriting back. */
export const PDF_DPI = 200;
/** A scan job longer than this is more likely a mistake than a stack of worksheets. */
export const MAX_PDF_PAGES = 50;

/** The part of pdf.js the scan import uses. */
export interface PdfLib {
  getDocument(src: { data: Uint8Array }): { promise: Promise<PdfDocument> };
}
export interface PdfDocument {
  numPages: number;
  getPage(n: number): Promise<PdfPage>;
  destroy(): Promise<void>;
}
export interface PdfPage {
  getViewport(opts: { scale: number }): { width: number; height: number };
  render(opts: { canvasContext: CanvasRenderingContext2D; viewport: unknown }): { promise: Promise<void> };
  cleanup(): void;
}

/** A rendered page (`bitmap`), or one pdf.js could not render (`bitmap: null` and the `error`). */
export type PdfPageImage =
  | {
      /** 1-based. */
      page: number;
      pageCount: number;
      bitmap: ImageBitmap;
    }
  | { page: number; pageCount: number; bitmap: null; error: unknown };

async function renderPage(doc: PdfDocument, n: number): Promise<ImageBitmap> {
  const page = await doc.getPage(n);
  const canvas = document.createElement('canvas');
  try {
    const viewport = page.getViewport({ scale: PDF_DPI / 72 });
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    return await createImageBitmap(canvas);
  } finally {
    page.cleanup();
    canvas.width = canvas.height = 0;
  }
}

/**
 * Render each page in turn, handing it to `onPage` before rendering the next,
 * so a long scan never holds every page in memory. Pages past
 * {@link MAX_PDF_PAGES} are left out; the return value is the page count.
 * A page that cannot be rendered reaches `onPage` with its error; an error
 * thrown by `onPage` itself ends the run.
 */
export async function forEachPdfPage(
  lib: PdfLib,
  bytes: ArrayBuffer,
  onPage: (page: PdfPageImage) => Promise<void>
): Promise<{ pageCount: number; skipped: number }> {
  const doc = await lib.getDocument({ data: new Uint8Array(bytes.slice(0)) }).promise;
  try {
    const pageCount = doc.numPages;
    const last = Math.min(pageCount, MAX_PDF_PAGES);
    for (let n = 1; n <= last; n++) {
      let image: PdfPageImage;
      try {
        image = { page: n, pageCount, bitmap: await renderPage(doc, n) };
      } catch (error) {
        console.warn('[labnoteo] PDF page could not be rendered:', n, error);
        image = { page: n, pageCount, bitmap: null, error };
      }
      await onPage(image);
    }
    return { pageCount, skipped: pageCount - last };
  } finally {
    await doc.destroy();
  }
}
