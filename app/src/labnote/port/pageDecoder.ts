// Ported from app/vendor/labnoteo/src/scan/pageDecoder.ts:7-71 sha256:c8eee3819f79dd3c
// labnoteO 0.140.2, Apache-2.0.
// Changes: createPageDecoder(output, deps) takes { pdf, decode, unzip }: pdf() loads the PdfLib (Obsidian's
// loadPdfJs becomes pdfjs-dist from scan/pdfjs.ts) and forEachPdfPage gets it; decodeBitmap's isBlankPage, findQr and
// renderJpeg run in the decode worker through the DecodeClient (one call that transfers the bitmap and answers the
// blank flag, the QR hit and the upright JPEG, which render() hands back); a PDF page with an image pdf.js cannot
// decode (SP7 E2: JPEG 2000) becomes a page marked `unsupportedImage` (User Decision 2026-11-09), never blank and
// without a payload, whose render() is what pdf.js could draw, or, when it could draw nothing, a placeholder page
// naming the PDF and the page (t('scan.pdfImagePlaceholder')), so the pipeline queues it as unmatched ('pdf-image');
// only when not even the placeholder can be drawn is it an `error` page (t('scan.pdfPageFailed', page)). A page
// whose JPEG stays over 20 MiB is a page with `error` t('scan.imageTooLarge') (B5), so the pipeline records an
// `error` result in its place; either way the next page still decodes; the bitmap is closed in a finally (a no-op
// once transferred).
/** The canvas-based {@link PageDecoder}: photos, scanner PDFs and zips of either. */
import { t } from '../../i18n/t';
import type { DecodeClient } from '../scan/decodeClient';
import { PDF_DPI, forEachPdfPage, type PdfLib } from './pdfPages';
import { sha256Hex, shortHash } from './imageStore';
import { IMAGE_KINDS, ScanImageTooLarge, loadBitmap, sniffFileKind } from './scanDecode';
import type { DecodedPage, PageDecoder, ScanInput, ScanResult, unzipScans } from './scanPipeline';

export interface ImageOutput {
  maxEdge: number;
  quality: number;
}

export interface PageDecoderDeps {
  /** pdf.js, loaded on the first PDF (`loadPdfLib` in scan/pdfjs.ts). */
  pdf: () => Promise<PdfLib>;
  /** The decode worker (`createDecodeClient`). */
  decode: DecodeClient;
  unzip: typeof unzipScans;
}

export function createPageDecoder(output: () => ImageOutput, deps: PageDecoderDeps): PageDecoder {
  /** A page that could not be read: the pipeline records it as an `error` result with this text. */
  function failedPage(source: string, hash: string, sourcePage: number | undefined, error: string): DecodedPage {
    return { source, sourcePage, hash, blank: false, error, render: () => Promise.reject(new Error(error)) };
  }

  async function decodeBitmap(
    bitmap: ImageBitmap,
    source: string,
    hash: string,
    sourcePage: number | undefined
  ): Promise<DecodedPage> {
    let decoded;
    try {
      const { maxEdge, quality } = output();
      decoded = await deps.decode.page(bitmap, { maxEdge, quality });
    } catch (err) {
      if (err instanceof ScanImageTooLarge) return failedPage(source, hash, sourcePage, t('scan.imageTooLarge'));
      throw err;
    }
    const { blank, hit, jpeg } = decoded;
    return {
      source,
      sourcePage,
      hash,
      blank,
      payload: hit?.payload,
      render: async () => jpeg,
    };
  }

  /** A white A4 page (at the PDF resolution) naming the PDF and the page, for a page pdf.js could not draw at all. */
  async function placeholder(source: string, page: number): Promise<ImageBitmap | undefined> {
    const canvas = document.createElement('canvas');
    try {
      canvas.width = Math.round((210 / 25.4) * PDF_DPI);
      canvas.height = Math.round((297 / 25.4) * PDF_DPI);
      const ctx = canvas.getContext('2d');
      if (!ctx) return undefined;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#000';
      ctx.font = '48px sans-serif';
      ctx.fillText(source, 120, 240, canvas.width - 240);
      ctx.fillText(t('scan.pdfImagePlaceholder', source, page), 120, 330, canvas.width - 240);
      return await createImageBitmap(canvas);
    } catch (err) {
      console.warn('[labnoteo] could not draw a placeholder page:', err instanceof Error ? err.name : typeof err);
      return undefined;
    } finally {
      canvas.width = canvas.height = 0;
    }
  }

  async function expand(
    input: ScanInput,
    onPage: (page: DecodedPage) => Promise<void>,
    inZip = false
  ): Promise<ScanResult[]> {
    const kind = sniffFileKind(new Uint8Array(input.bytes, 0, Math.min(16, input.bytes.byteLength)));
    const fileHash = shortHash(await sha256Hex(input.bytes));
    if (IMAGE_KINDS.has(kind)) {
      const bitmap = await loadBitmap(input.bytes);
      try {
        await onPage(await decodeBitmap(bitmap, input.name, fileHash, undefined));
      } finally {
        bitmap.close();
      }
      return [];
    }
    if (kind === 'pdf') {
      const { skipped } = await forEachPdfPage(await deps.pdf(), input.bytes, async page => {
        const hash = shortHash(await sha256Hex(new TextEncoder().encode(`${fileHash}:${page.page}`)));
        // User Decision (2026-11-09): a page with an image pdf.js cannot decode is reported as "unsupported image
        // format in this PDF" and queued as unmatched (never dropped): what pdf.js drew, or a placeholder page.
        const unsupported = !page.bitmap || !!page.missingImage;
        const bitmap = page.bitmap ?? (await placeholder(input.name, page.page));
        if (!bitmap) {
          await onPage(failedPage(input.name, hash, page.page, t('scan.pdfPageFailed', page.page)));
          return;
        }
        let decoded: DecodedPage;
        try {
          decoded = await decodeBitmap(bitmap, input.name, hash, page.page);
        } finally {
          bitmap.close();
        }
        if (unsupported && decoded.error === undefined) {
          decoded = { ...decoded, blank: false, payload: undefined, unsupportedImage: true };
        }
        await onPage(decoded);
      });
      return skipped > 0 ? [{ source: input.name, status: 'unsupported', reason: 'pdf-limit' }] : [];
    }
    if (kind === 'zip' && !inZip) {
      const { files, overLimit } = deps.unzip(input.bytes);
      const results: ScanResult[] = [];
      for (const file of files) results.push(...(await expand(file, onPage, true)));
      if (overLimit) results.push({ source: input.name, status: 'unsupported', reason: 'zip-limit' });
      return results;
    }
    const reason = kind === 'heic' ? 'heic' : kind === 'tiff' ? 'tiff' : 'unknown';
    return [{ source: input.name, status: 'unsupported', reason }];
  }

  return { expand: (input, onPage) => expand(input, onPage) };
}
