/**
 * Test stand-ins for the canvas: an `ImageData` that node lacks, and a `Raster` that crops and scales a stored page
 * (box filter), so the ported decoder runs without OffscreenCanvas.
 */
import type { Raster, Source } from '../../port/scanDecode';

export class FakeImageData {
  constructor(
    public width: number,
    public height: number,
    public data = new Uint8ClampedArray(width * height * 4)
  ) {}
}

/** One `draw` call as the decoder made it: the source rectangle and the output size. */
export interface DrawCall {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  w: number;
  h: number;
}

export interface FakeRaster extends Raster {
  draws: DrawCall[];
}

/** A page of `width`×`height` in one grey level (white by default). */
export function blankPage(width: number, height: number, grey = 255): FakeImageData {
  const img = new FakeImageData(width, height);
  img.data.fill(grey);
  return img;
}

/** Paints `matrix` (dark modules true) at `px` pixels per module with its top-left corner at (`left`, `top`). */
export function paintMatrix(img: FakeImageData, matrix: boolean[][], left: number, top: number, px: number): void {
  matrix.forEach((row, r) =>
    row.forEach((dark, c) => {
      if (!dark) return;
      for (let y = top + r * px; y < top + (r + 1) * px; y++) {
        for (let x = left + c * px; x < left + (c + 1) * px; x++) {
          const i = (y * img.width + x) * 4;
          img.data[i] = img.data[i + 1] = img.data[i + 2] = 0;
        }
      }
    })
  );
}

/** A source object the decoder can be handed; `fakeRaster` looks its pixels up by identity. */
export function fakeSource(width: number, height: number): Source {
  return { width, height } as unknown as Source;
}

/** A raster over `pages` (source → its pixels). `draw` averages the pixels each output pixel covers; `jpeg` is not available. */
export function fakeRaster(pages: Map<unknown, FakeImageData>): FakeRaster {
  const draws: DrawCall[] = [];
  return {
    draws,
    draw(src, sx, sy, sw, sh, w, h) {
      draws.push({ sx, sy, sw, sh, w, h });
      const page = pages.get(src);
      if (!page) throw new Error('fakeRaster: unknown source');
      const out = new FakeImageData(w, h);
      // box filter: each output pixel is the mean of the source pixels it covers, like a canvas downscale
      for (let y = 0; y < h; y++) {
        const y0 = Math.floor(sy + (y * sh) / h);
        const y1 = Math.min(page.height, Math.max(y0 + 1, Math.floor(sy + ((y + 1) * sh) / h)));
        for (let x = 0; x < w; x++) {
          const x0 = Math.floor(sx + (x * sw) / w);
          const x1 = Math.min(page.width, Math.max(x0 + 1, Math.floor(sx + ((x + 1) * sw) / w)));
          let r = 0;
          let g = 0;
          let b = 0;
          let n = 0;
          for (let py = y0; py < y1; py++) {
            for (let px = x0; px < x1; px++) {
              const from = (py * page.width + px) * 4;
              r += page.data[from];
              g += page.data[from + 1];
              b += page.data[from + 2];
              n++;
            }
          }
          const to = (y * w + x) * 4;
          out.data[to] = r / n;
          out.data[to + 1] = g / n;
          out.data[to + 2] = b / n;
          out.data[to + 3] = 255;
        }
      }
      return out as unknown as ImageData;
    },
    imageData(w, h) {
      return new FakeImageData(w, h) as unknown as ImageData;
    },
    async jpeg() {
      throw new Error('fakeRaster: no jpeg');
    },
  };
}
