// @vitest-environment node
import { beforeAll, describe, expect, it } from 'vitest';
import { qrMatrix } from '../../port/qr';
import {
  ScanImageTooLarge,
  findQr,
  isBlankPage,
  renderJpeg,
  rotationFromCorners,
  sniffFileKind,
  stretchContrast,
  type Raster,
} from '../../port/scanDecode';
import { FakeImageData, blankPage, fakeRaster, fakeSource, paintMatrix } from './imageDataShim';

const OURS = 'LN1:LN-7K3M9QX2:1:UHW010:1/1:261015';
const MiB = 1024 * 1024;

beforeAll(() => {
  (globalThis as { ImageData?: unknown }).ImageData = FakeImageData;
});

/** A white `size`² page with `text`'s QR at `px` px per module, placed inside the top-right quarter. */
function qrPage(text: string, size = 1600, px = 4, shift = 0) {
  const page = blankPage(size, size);
  paintMatrix(page, qrMatrix(text), size / 2 + size / 8 + shift, size / 8 + shift, px);
  const src = fakeSource(size, size);
  return { src, page, raster: fakeRaster(new Map([[src, page]])) };
}

describe('scanDecode', () => {
  it('sniffFileKind reads magic bytes', () => {
    expect(sniffFileKind(new Uint8Array([0xff, 0xd8, 0xff, 0]))).toBe('jpeg');
    expect(sniffFileKind(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe('png');
    expect(sniffFileKind(new TextEncoder().encode('%PDF-1.7'))).toBe('pdf');
    expect(sniffFileKind(new Uint8Array([0x50, 0x4b, 3, 4]))).toBe('zip');
    expect(sniffFileKind(new Uint8Array([0x49, 0x49, 0x2a, 0]))).toBe('tiff');
    expect(sniffFileKind(new Uint8Array([1, 2, 3, 4]))).toBe('unknown');
  });

  // The vendor's rule: the clockwise turn that puts the page upright. A QR whose top edge points down (the page lies
  // turned 90° clockwise) needs 270° more.
  it('rotationFromCorners gives 0/90/180/270', () => {
    expect(rotationFromCorners({ x: 0, y: 0 }, { x: 10, y: 0 })).toBe(0);
    expect(rotationFromCorners({ x: 10, y: 0 }, { x: 10, y: 10 })).toBe(270);
    expect(rotationFromCorners({ x: 10, y: 10 }, { x: 0, y: 10 })).toBe(180);
    expect(rotationFromCorners({ x: 0, y: 10 }, { x: 0, y: 0 })).toBe(90);
  });

  it('findQr reads a generated QR on a white page and in a corner crop', async () => {
    const whole = qrPage(OURS);
    const found = await findQr(whole.src, whole.raster);
    expect(found.hit?.text).toBe(OURS);
    expect(found.hit?.payload).toMatchObject({ noteId: 'LN-7K3M9QX2', opId: 'UHW010' });
    expect(found.hit?.rotation).toBe(0);
    expect(found.foreign).toBe(false);

    // 2 px modules off the even grid on a 3200 px page: drawn whole at 1600 px every pixel mixes two modules; the
    // top-right quarter drawn at full size reads
    const big = qrPage(OURS, 3200, 2, 1);
    const crop = await findQr(big.src, big.raster);
    expect(crop.hit?.text).toBe(OURS);
    expect(big.raster.draws.length).toBeGreaterThan(1);
    expect(big.raster.draws[big.raster.draws.length - 1]).toEqual({ sx: 1600, sy: 0, sw: 1600, sh: 1600, w: 1600, h: 1600 });
  }, 30_000);

  it('a QR that is not ours is foreign', async () => {
    const { src, raster } = qrPage('https://example.com');
    expect(await findQr(src, raster)).toEqual({ hit: null, foreign: true });
  }, 30_000);

  it('isBlankPage: flat grey is blank, a page with a QR is not', () => {
    const src = fakeSource(1600, 1600);
    expect(isBlankPage(src, fakeRaster(new Map([[src, blankPage(1600, 1600, 200)]])))).toBe(true);
    const { src: qrSrc, raster } = qrPage(OURS);
    expect(isBlankPage(qrSrc, raster)).toBe(false);
  });

  it('stretchContrast makes its output through the raster', () => {
    const img = new FakeImageData(2, 1, new Uint8ClampedArray([50, 50, 50, 255, 150, 150, 150, 255]));
    const made: Array<[number, number]> = [];
    const raster: Raster = {
      ...fakeRaster(new Map()),
      imageData: (w, h) => {
        made.push([w, h]);
        return new FakeImageData(w, h) as unknown as ImageData;
      },
    };
    const out = stretchContrast(img as unknown as ImageData, raster);
    expect(made).toEqual([[2, 1]]);
    expect(Array.from(out.data)).toEqual([0, 0, 0, 255, 255, 255, 255, 255]);
  });

  it('renderJpeg lowers quality until the image fits 20 MiB, then fails', async () => {
    const src = fakeSource(100, 100);
    const rasterWith = (size: (q: number) => number) => {
      const qualities: number[] = [];
      const raster: Raster = {
        ...fakeRaster(new Map()),
        async jpeg(_src, _rot, _edge, q) {
          qualities.push(q);
          return { size: size(q), arrayBuffer: async () => new ArrayBuffer(8) } as unknown as Blob;
        },
      };
      return { raster, qualities };
    };

    // 25 MiB at q ≥ 0.65 and 10 MiB below: 0.85, 0.75 and 0.65 are too big, 0.55 fits
    const fits = rasterWith(q => (q >= 0.65 - 1e-9 ? 25 * MiB : 10 * MiB));
    const bytes = await renderJpeg(src, 90, 2400, 0.85, fits.raster);
    expect(bytes.byteLength).toBe(8);
    expect(fits.qualities).toEqual([0.85, 0.75, 0.65, 0.55]);

    const never = rasterWith(() => 25 * MiB);
    await expect(renderJpeg(src, 0, 2400, 0.85, never.raster)).rejects.toBeInstanceOf(ScanImageTooLarge);
    expect(never.qualities).toEqual([0.85, 0.75, 0.65, 0.55, 0.5]);

    const small = rasterWith(() => 1 * MiB);
    await renderJpeg(src, 0, 2400, 0.85, small.raster);
    expect(small.qualities).toEqual([0.85]);

    // exactly 20 MiB still fits
    const edge = rasterWith(() => 20 * MiB);
    await renderJpeg(src, 0, 2400, 0.85, edge.raster);
    expect(edge.qualities).toEqual([0.85]);
  });
});
