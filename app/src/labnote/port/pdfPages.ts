// Ported from app/vendor/labnoteo/src/scan/pdfPages.ts:7-66 sha256:a6fb0750c450a3ad
// labnoteO 0.140.2, Apache-2.0.
// Changes: Obsidian's loadPdfJs becomes an injected PdfLib (the app's is pdfjs-dist from scan/pdfjs.ts, without eval,
// without font faces and with a same-origin worker, SP7 B2), so forEachPdfPage(lib, bytes, onPage); PDF_DPI and the
// pdf.js shapes are exported; a page whose getPage, render or bitmap throws (pdf.js decodes JPEG 2000 with
// WebAssembly, which the CSP does not allow) is handed to onPage with `bitmap: null` and its error, and the remaining
// pages continue; page.cleanup and the canvas release run in a finally. pdf.js does not reject render when its worker
// cannot decode an image (pdfjs-dist 4.10.38 resolves the image object with null data and the canvas skips it), so
// renderPage watches the page's objs and commonObjs resolve calls during the render and fails the page when an image
// arrives as null (otherwise a JPEG 2000 page would render white and be filed as blank); such a page still reaches
// onPage with what pdf.js could draw (`bitmap`) and `missingImage` (PdfImageMissing naming the image ids), so the
// decoder can queue it as unmatched (User Decision 2026-11-09).
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
/** pdf.js's PDFObjects: the worker's images arrive through `resolve`, with null data when one could not be decoded. */
export interface PdfObjects {
  resolve(objId: string, data?: unknown): void;
}
export interface PdfPage {
  /** This page's images. */
  objs: PdfObjects;
  /** The document's shared objects: fonts, and images used on several pages. */
  commonObjs: PdfObjects;
  getViewport(opts: { scale: number }): { width: number; height: number };
  render(opts: { canvasContext: CanvasRenderingContext2D; viewport: unknown }): { promise: Promise<void> };
  cleanup(): void;
}

/**
 * A rendered page (`bitmap`; with `missingImage` when some of its images could not be decoded, so the bitmap shows
 * the page without them), or one pdf.js could not render at all (`bitmap: null` and the `error`).
 */
export type PdfPageImage =
  | {
      /** 1-based. */
      page: number;
      pageCount: number;
      bitmap: ImageBitmap;
      missingImage?: PdfImageMissing;
    }
  | { page: number; pageCount: number; bitmap: null; error: unknown };

/** A page pdf.js rendered without some of its images (their decode failed in the worker). */
export class PdfImageMissing extends Error {
  constructor(readonly objIds: string[]) {
    super(`PDF image could not be decoded: ${objIds.join(', ')}`);
    this.name = 'PdfImageMissing';
  }
}

/**
 * Record the ids `objs` is resolved with null data until the returned function
 * restores it. Only images resolve as null (fonts and patterns always carry
 * data), and one page renders at a time, so a null during this page's render
 * is one of its images.
 */
function watchMissingImages(objs: PdfObjects, missing: string[]): () => void {
  const own = Object.prototype.hasOwnProperty.call(objs, 'resolve');
  const original = objs.resolve;
  objs.resolve = function (this: PdfObjects, objId: string, data?: unknown) {
    if (data == null) missing.push(objId);
    return original.call(this, objId, data);
  };
  return () => {
    if (own) objs.resolve = original;
    else delete (objs as Partial<PdfObjects>).resolve;
  };
}

async function renderPage(doc: PdfDocument, n: number): Promise<{ bitmap: ImageBitmap; missingImage?: PdfImageMissing }> {
  const page = await doc.getPage(n);
  const canvas = document.createElement('canvas');
  try {
    const viewport = page.getViewport({ scale: PDF_DPI / 72 });
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const missing: string[] = [];
    const unwatch = [page.objs, page.commonObjs].map(objs => watchMissingImages(objs, missing));
    try {
      await page.render({ canvasContext: ctx, viewport }).promise;
    } finally {
      for (const restore of unwatch) restore();
    }
    const bitmap = await createImageBitmap(canvas);
    if (missing.length === 0) return { bitmap };
    const missingImage = new PdfImageMissing(missing);
    console.warn('[labnoteo] PDF page rendered without an image:', n, missingImage.message);
    return { bitmap, missingImage };
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
        image = { page: n, pageCount, ...(await renderPage(doc, n)) };
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
