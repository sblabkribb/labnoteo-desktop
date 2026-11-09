// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zipSync } from 'fflate';
import { t } from '../../../i18n/t';
import { MAX_PDF_PAGES, PDF_DPI, forEachPdfPage, type PdfLib } from '../../port/pdfPages';
import { createPageDecoder } from '../../port/pageDecoder';
import { ScanImageTooLarge } from '../../port/scanDecode';
import { ScanPipeline, unzipScans, type DecodedPage, type PipelineDeps, type ScanInput } from '../../port/scanPipeline';
import type { DecodeClient, DecodedWorkerPage } from '../decodeClient';
import { loadPdfLib } from '../pdfjs';

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: vi.fn(() => ({ promise: Promise.resolve({ numPages: 0, getPage: vi.fn(), destroy: vi.fn(async () => {}) }) })),
}));
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '/assets/pdf.worker.min-abc.mjs' }));

const JPEG = [0xff, 0xd8, 0xff, 0xe0];
const bytesOf = (arr: number[] | Uint8Array): ArrayBuffer => new Uint8Array(arr).buffer as ArrayBuffer;
const pdfBytes = () => new TextEncoder().encode('%PDF-1.7\n%fake').buffer as ArrayBuffer;
const input = (name: string, bytes: ArrayBuffer): ScanInput => ({ name, bytes });

/** A bitmap stand-in: `createImageBitmap` and the PDF canvas give these. */
const fakeBitmap = () => ({ width: 10, height: 10, close: vi.fn() }) as unknown as ImageBitmap;

beforeEach(() => {
  vi.stubGlobal('createImageBitmap', vi.fn(async () => fakeBitmap()));
  vi.stubGlobal('document', {
    createElement: () => ({ width: 0, height: 0, getContext: () => ({ fillStyle: '', fillRect() {} }) }),
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * A pdf.js stand-in: `pages` pages; a page number in `failing` throws while rendering; one in `missingImage` renders
 * (as real pdf.js does when the worker cannot decode an image, e.g. JPEG 2000 under the CSP) but resolves its image
 * object with null data: in `objs` for a page image, in `commonObjs` for a globally cached one when `global` is set.
 */
function fakePdf(pages: number, failing: number[] = [], missingImage: number[] = [], global = false) {
  const commonObjs = { resolve: vi.fn((_id: string, _data?: unknown) => {}) };
  const getDocument = vi.fn((_src: { data: Uint8Array }) => ({
    promise: Promise.resolve({
      numPages: pages,
      getPage: async (n: number) => {
        const objs = { resolve: vi.fn((_id: string, _data?: unknown) => {}) };
        const page = {
          objs,
          commonObjs,
          getViewport: ({ scale }: { scale: number }) => ({ width: 8.5 * 72 * scale, height: 11 * 72 * scale }),
          render: () => {
            if (failing.includes(n)) return { promise: Promise.reject(new Error('JpxError: OpenJPEG failed')) };
            page.objs.resolve(`img_p${n - 1}_1`, { width: 10, height: 10 });
            if (missingImage.includes(n)) {
              if (global) page.commonObjs.resolve(`g_d0_img_p${n - 1}_2`, null);
              else page.objs.resolve(`img_p${n - 1}_2`, null);
            }
            return { promise: Promise.resolve() };
          },
          cleanup: vi.fn(),
        };
        return page;
      },
      destroy: vi.fn(async () => {}),
    }),
  }));
  return { getDocument, commonObjs } as PdfLib & { getDocument: typeof getDocument; commonObjs: typeof commonObjs };
}

/** A decode-client stand-in: every page decodes as a page without our QR, unless `answer` says otherwise. */
function fakeDecode(answer: (n: number) => Partial<DecodedWorkerPage> | Error = () => ({})): DecodeClient & { calls: number } {
  const client = {
    calls: 0,
    async page() {
      const out = answer(++client.calls);
      if (out instanceof Error) throw out;
      return { hit: null, foreign: false, blank: false, jpeg: new ArrayBuffer(4), rotation: 0, ...out } as DecodedWorkerPage;
    },
    terminate() {},
  };
  return client;
}

async function expandAll(decoder: ReturnType<typeof createPageDecoder>, file: ScanInput) {
  const pages: DecodedPage[] = [];
  const results = await decoder.expand(file, async (p) => {
    pages.push(p);
  });
  return { pages, results };
}

const output = () => ({ maxEdge: 2400, quality: 0.85 });

describe('forEachPdfPage', () => {
  it('renders at 200 DPI on a white canvas, one page at a time, and closes the document', async () => {
    const lib = fakePdf(2);
    const seen: number[] = [];
    const out = await forEachPdfPage(lib, pdfBytes(), async (p) => {
      expect(p.bitmap).not.toBeNull();
      seen.push(p.page);
    });
    expect(seen).toEqual([1, 2]);
    expect(out).toEqual({ pageCount: 2, skipped: 0 });
    expect(lib.getDocument.mock.calls[0][0].data).toBeInstanceOf(Uint8Array);
  });

  it('a page whose image pdf.js could not decode (render resolves) reaches onPage with bitmap null', async () => {
    for (const global of [false, true]) {
      const lib = fakePdf(3, [], [2], global);
      const sharedResolve = lib.commonObjs.resolve;
      const seen: { page: number; bitmap: unknown; error?: unknown }[] = [];
      await forEachPdfPage(lib, pdfBytes(), async (p) => {
        seen.push({ page: p.page, bitmap: p.bitmap, error: p.bitmap ? undefined : p.error });
      });
      expect(seen.map((p) => p.bitmap === null)).toEqual([false, true, false]);
      expect(String(seen[1].error)).toContain(global ? 'g_d0_img_p1_2' : 'img_p1_2');
      // the watch is removed after each render: the shared commonObjs keeps its own resolve
      expect(lib.commonObjs.resolve).toBe(sharedResolve);
    }
  });
});

describe('createPageDecoder', () => {
  it('a 51-page PDF stops at 50 with pdf-limit', async () => {
    const decoder = createPageDecoder(output, { pdf: async () => fakePdf(51), decode: fakeDecode(), unzip: unzipScans });
    const { pages, results } = await expandAll(decoder, input('scan.pdf', pdfBytes()));
    expect(MAX_PDF_PAGES).toBe(50);
    expect(pages).toHaveLength(50);
    expect(pages.map((p) => p.sourcePage)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(new Set(pages.map((p) => p.hash)).size).toBe(50);
    expect(results).toEqual([{ source: 'scan.pdf', status: 'unsupported', reason: 'pdf-limit' }]);
  });

  it('a page that fails to render is an error result and the next page still decodes', async () => {
    const decode = fakeDecode();
    const decoder = createPageDecoder(output, { pdf: async () => fakePdf(3, [2]), decode, unzip: unzipScans });
    const deps = { decoder } as unknown as PipelineDeps;
    const results = await new ScanPipeline(deps).run([input('scan.pdf', pdfBytes())], { skipNoQr: true });
    expect(results).toHaveLength(3);
    expect(results[0]).toMatchObject({ status: 'skipped', sourcePage: 1 });
    expect(results[1]).toMatchObject({ status: 'error', sourcePage: 2, message: t('scan.pdfPageFailed', 2) });
    expect(results[1].message).not.toBe('scan.pdfPageFailed');
    expect(results[2]).toMatchObject({ status: 'skipped', sourcePage: 3 });
    expect(decode.calls).toBe(2);
  });

  it('a page whose image pdf.js could not decode is an error result, not blank, and the next page still decodes', async () => {
    const decode = fakeDecode(() => ({ blank: true }));
    const decoder = createPageDecoder(output, { pdf: async () => fakePdf(3, [], [2]), decode, unzip: unzipScans });
    const results = await new ScanPipeline({ decoder } as unknown as PipelineDeps).run([input('scan.pdf', pdfBytes())], {
      skipNoQr: true,
    });
    expect(results).toHaveLength(3);
    expect(results[1]).toMatchObject({ status: 'error', sourcePage: 2, message: t('scan.pdfPageFailed', 2) });
    expect(results.map((r) => r.status)).toEqual(['blank', 'error', 'blank']);
    expect(decode.calls).toBe(2);
  });

  it('a page image over 20 MiB is an error result and the next page still decodes', async () => {
    const decode = fakeDecode((n) => (n === 1 ? new ScanImageTooLarge() : {}));
    const decoder = createPageDecoder(output, { pdf: async () => fakePdf(2), decode, unzip: unzipScans });
    const results = await new ScanPipeline({ decoder } as unknown as PipelineDeps).run([input('scan.pdf', pdfBytes())], {
      skipNoQr: true,
    });
    expect(results.map((r) => r.status)).toEqual(['error', 'skipped']);
    expect(results[0].message).toBe(t('scan.imageTooLarge'));
    expect(results[0].message).not.toBe('scan.imageTooLarge');
  });

  it('a photo is decoded with the current image settings and its JPEG is what render gives', async () => {
    const jpeg = new ArrayBuffer(7);
    const decode = fakeDecode(() => ({ jpeg, blank: false }));
    const spy = vi.spyOn(decode, 'page');
    const decoder = createPageDecoder(() => ({ maxEdge: 1600, quality: 0.7 }), { pdf: vi.fn(), decode, unzip: unzipScans });
    const { pages, results } = await expandAll(decoder, input('a.jpg', bytesOf([...JPEG, 1, 2, 3])));
    expect(results).toEqual([]);
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({ source: 'a.jpg', sourcePage: undefined, blank: false, payload: undefined });
    expect(pages[0].hash).toMatch(/^[0-9a-f]+$/);
    expect(await pages[0].render()).toBe(jpeg);
    expect(spy.mock.calls[0][1]).toEqual({ maxEdge: 1600, quality: 0.7 });
  });

  it('zip members are flattened, sorted numerically and over-limit zips say zip-limit', async () => {
    const jpg = new Uint8Array(JPEG);
    const zip = zipSync({ 'b/10.jpg': jpg, 'a/2.jpg': jpg, 'a/1.jpg': jpg });
    const decoder = createPageDecoder(output, { pdf: vi.fn(), decode: fakeDecode(), unzip: unzipScans });
    const { pages, results } = await expandAll(decoder, input('pages.zip', zip.buffer as ArrayBuffer));
    expect(pages.map((p) => p.source)).toEqual(['1.jpg', '2.jpg', '10.jpg']);
    expect(results).toEqual([]);

    const many: Record<string, Uint8Array> = {};
    for (let i = 1; i <= 201; i++) many[`p${i}.jpg`] = jpg;
    const big = await expandAll(decoder, input('many.zip', zipSync(many).buffer as ArrayBuffer));
    expect(big.pages).toHaveLength(200);
    expect(big.results).toEqual([{ source: 'many.zip', status: 'unsupported', reason: 'zip-limit' }]);
  });

  it('a zip inside a zip is not opened', async () => {
    const inner = zipSync({ 'x.jpg': new Uint8Array(JPEG) });
    const outer = zipSync({ 'inner.zip': inner });
    const decoder = createPageDecoder(output, { pdf: vi.fn(), decode: fakeDecode(), unzip: unzipScans });
    // unzipScans keeps image and PDF members only, so the inner zip never reaches expand
    const { pages, results } = await expandAll(decoder, input('outer.zip', outer.buffer as ArrayBuffer));
    expect(pages).toEqual([]);
    expect(results).toEqual([]);
  });

  it('heic and tiff are unsupported with their reason', async () => {
    const decoder = createPageDecoder(output, { pdf: vi.fn(), decode: fakeDecode(), unzip: unzipScans });
    const heic = bytesOf([0, 0, 0, 0x18, ...new TextEncoder().encode('ftypheic'), 0, 0, 0, 0]);
    expect((await expandAll(decoder, input('a.heic', heic))).results).toEqual([
      { source: 'a.heic', status: 'unsupported', reason: 'heic' },
    ]);
    const tiff = bytesOf([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0]);
    expect((await expandAll(decoder, input('a.tif', tiff))).results).toEqual([
      { source: 'a.tif', status: 'unsupported', reason: 'tiff' },
    ]);
    expect((await expandAll(decoder, input('a.txt', bytesOf([1, 2, 3, 4])))).results).toEqual([
      { source: 'a.txt', status: 'unsupported', reason: 'unknown' },
    ]);
  });
});

describe('loadPdfLib', () => {
  it('pdf.js is configured without eval and with a same-origin worker', async () => {
    const pdfjs = await import('pdfjs-dist');
    const lib = await loadPdfLib();
    expect(pdfjs.GlobalWorkerOptions.workerSrc).toBe('/assets/pdf.worker.min-abc.mjs');
    const data = new Uint8Array([1, 2, 3]);
    await lib.getDocument({ data }).promise;
    expect(pdfjs.getDocument).toHaveBeenCalledWith(expect.objectContaining({ data, isEvalSupported: false, disableFontFace: true }));
  });
});
