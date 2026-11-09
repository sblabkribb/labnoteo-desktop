/**
 * pdf.js for the scan import (SP7 B2). Loaded on the first PDF (a dynamic import, so the editor never pays for it).
 * - Its worker is the same-origin asset Vite emits for the `?url` import (Vite does not resolve a bare specifier
 *   inside `new URL(…, import.meta.url)`), so the CSP's `script-src 'self'` covers it.
 * - `isEvalSupported: false` (the CSP has no `'unsafe-eval'` anyway) and `disableFontFace: true` (no font faces are
 *   added to the document); no `cMapUrl` or `standardFontDataUrl`: scans are images, and nothing is fetched.
 */
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PdfDocument, PdfLib } from '../port/pdfPages';

export async function loadPdfLib(): Promise<PdfLib> {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  return {
    getDocument({ data }) {
      const task = pdfjs.getDocument({ data, isEvalSupported: false, disableFontFace: true });
      return { promise: task.promise as unknown as Promise<PdfDocument> };
    },
  };
}
