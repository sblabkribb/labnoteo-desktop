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
import { setLang } from '../../../i18n/lang';
import { coreT } from '../../i18n';
import { describeResult } from '../../port/scanResults';

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

/** What the stand-in canvases were asked to write: the placeholder page's lines. */
let drawnText: string[] = [];

beforeEach(() => {
  drawnText = [];
  vi.stubGlobal('createImageBitmap', vi.fn(async () => fakeBitmap()));
  vi.stubGlobal('document', {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({ fillStyle: '', font: '', fillRect() {}, fillText: (text: string) => void drawnText.push(text) }),
    }),
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

/**
 * A decode-client stand-in: every page decodes as a page without our QR, unless `answer` says otherwise. Like the
 * worker, a blank page comes back with an empty JPEG unless the request says `keepBlank`.
 */
function fakeDecode(answer: (n: number) => Partial<DecodedWorkerPage> | Error = () => ({})): DecodeClient & {
  calls: number;
  keepBlank: boolean[];
} {
  const client = {
    calls: 0,
    keepBlank: [] as boolean[],
    async page(_bitmap: ImageBitmap, opts: { maxEdge: number; quality: number; keepBlank?: boolean }) {
      const out = answer(++client.calls);
      client.keepBlank.push(!!opts.keepBlank);
      if (out instanceof Error) throw out;
      const page = { hit: null, foreign: false, blank: false, jpeg: new ArrayBuffer(4), rotation: 0, ...out } as DecodedWorkerPage;
      return page.blank && !opts.keepBlank ? { ...page, jpeg: new ArrayBuffer(0) } : page;
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

  it('a page whose image pdf.js could not decode (render resolves) reaches onPage with what was drawn and the missing ids', async () => {
    for (const global of [false, true]) {
      const lib = fakePdf(3, [], [2], global);
      const sharedResolve = lib.commonObjs.resolve;
      const seen: { page: number; bitmap: unknown; missing?: unknown }[] = [];
      await forEachPdfPage(lib, pdfBytes(), async (p) => {
        seen.push({ page: p.page, bitmap: p.bitmap, missing: p.bitmap ? p.missingImage : undefined });
      });
      expect(seen.map((p) => p.bitmap === null)).toEqual([false, false, false]);
      expect(seen.map((p) => p.missing === undefined)).toEqual([true, false, true]);
      expect(String(seen[1].missing)).toContain(global ? 'g_d0_img_p1_2' : 'img_p1_2');
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

  // User Decision (2026-11-09): reported as "unsupported image format in this PDF" and queued as unmatched, never dropped.
  it('a page that fails to render becomes a placeholder page naming the PDF and page, marked unsupportedImage', async () => {
    const jpeg = new ArrayBuffer(9);
    const decode = fakeDecode((n) => (n === 2 ? { jpeg, blank: true } : {}));
    const decoder = createPageDecoder(output, { pdf: async () => fakePdf(3, [2]), decode, unzip: unzipScans });
    const { pages, results } = await expandAll(decoder, input('scan.pdf', pdfBytes()));
    expect(results).toEqual([]);
    expect(pages.map((p) => [p.sourcePage, !!p.unsupportedImage])).toEqual([
      [1, false],
      [2, true],
      [3, false],
    ]);
    expect(pages[1].blank).toBe(false);
    expect(pages[1].payload).toBeUndefined();
    expect(pages[1].error).toBeUndefined();
    expect(await pages[1].render()).toBe(jpeg);
    expect(drawnText.join(' ')).toContain('scan.pdf');
    expect(drawnText.join(' ')).toContain(t('scan.pdfImagePlaceholder', 'scan.pdf', 2));
    expect(decode.calls).toBe(3);
  });

  it('a page whose image pdf.js could not decode keeps what was drawn, is marked unsupportedImage and not blank', async () => {
    const decode = fakeDecode((n) => ({ blank: n !== 2 }));
    const decoder = createPageDecoder(output, { pdf: async () => fakePdf(3, [], [2]), decode, unzip: unzipScans });
    const { pages } = await expandAll(decoder, input('scan.pdf', pdfBytes()));
    expect(pages.map((p) => [p.blank, !!p.unsupportedImage])).toEqual([
      [true, false],
      [false, true],
      [true, false],
    ]);
    expect((await pages[1].render()).byteLength).toBeGreaterThan(0);
    expect(drawnText).toEqual([]);
    expect(decode.calls).toBe(3);
  });

  // BUG-1: the usual JPEG 2000 scanner page is one full-page image; when it cannot be decoded pdf.js draws a white
  // page, which the worker calls blank and answers with no JPEG. Queued as is, that is a 0-byte image in the vault.
  it('an undecodable page that drew nothing visible gets the placeholder page, never an empty image', async () => {
    const decode = fakeDecode((n) => ({ blank: n === 2 || n === 4 })); // calls: p1, p2, p2's placeholder, p3
    const decoder = createPageDecoder(output, { pdf: async () => fakePdf(3, [], [2]), decode, unzip: unzipScans });
    const { pages } = await expandAll(decoder, input('scan.pdf', pdfBytes()));
    expect(pages.map((p) => [p.sourcePage, p.blank, !!p.unsupportedImage])).toEqual([
      [1, false, false],
      [2, false, true],
      [3, true, false],
    ]);
    expect(pages[1].error).toBeUndefined();
    expect((await pages[1].render()).byteLength).toBeGreaterThan(0);
    expect(drawnText.join(' ')).toContain(t('scan.pdfImagePlaceholder', 'scan.pdf', 2));
    // page 1, page 2 as drawn, page 2's placeholder (rendered even if judged blank), page 3
    expect(decode.keepBlank).toEqual([false, false, true, false]);
  });

  it('an undecodable page through the pipeline never stores a 0-byte image', async () => {
    const saved: { name: string; size: number }[] = [];
    const deps = {
      decoder: createPageDecoder(output, {
        pdf: async () => fakePdf(1, [], [1]),
        decode: fakeDecode(() => ({ blank: true })),
        unzip: unzipScans,
      }),
      images: {
        exists: async () => false,
        writeScanImage: async (dir: string, name: string, bytes: ArrayBuffer) => {
          saved.push({ name, size: bytes.byteLength });
          return `${dir}/${name}`;
        },
      },
    } as unknown as PipelineDeps;
    const results = await new ScanPipeline(deps).run([input('scan.pdf', pdfBytes())], { skipNoQr: true });
    expect(results.map((r) => [r.status, r.reason])).toEqual([['unmatched', 'pdf-image']]);
    expect(saved).toHaveLength(1);
    expect(saved[0].size).toBeGreaterThan(0);
  });

  it('through the pipeline both are unmatched pdf-image results, worded as the decision says, also in a shared folder', async () => {
    const saved: string[] = [];
    const deps = {
      decoder: createPageDecoder(output, { pdf: async () => fakePdf(3, [1], [3]), decode: fakeDecode(), unzip: unzipScans }),
      images: {
        exists: async () => false,
        writeScanImage: async (dir: string, name: string) => {
          saved.push(`${dir}/${name}`);
          return `${dir}/${name}`;
        },
      },
    } as unknown as PipelineDeps;
    const results = await new ScanPipeline(deps).run([input('scan.pdf', pdfBytes())], { skipNoQr: true });
    expect(results.map((r) => [r.sourcePage, r.status, r.reason])).toEqual([
      [1, 'unmatched', 'pdf-image'],
      [2, 'skipped', 'no-qr'],
      [3, 'unmatched', 'pdf-image'],
    ]);
    expect(saved).toHaveLength(2);
    for (const lang of ['en', 'ko'] as const) {
      setLang(lang);
      expect(describeResult(coreT, results[0])).toContain(t('scan.pdfImageUnsupported'));
    }
    setLang('en');
    expect(t('scan.pdfImageUnsupported')).toMatch(/^Unsupported image format in this PDF/);
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
