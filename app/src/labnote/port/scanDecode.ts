// Ported from app/vendor/labnoteo/src/scan/decode.ts:1-172 sha256:130fa3cb6c8e68d1
// labnoteO 0.140.2, Apache-2.0.
// Changes: draw, findQr, isBlankPage and renderJpeg take an injected Raster (draw(src, sx, sy, sw, sh, w, h),
// imageData(w, h), jpeg(src, rotation, maxEdge, quality)) so tests run without OffscreenCanvas, and offscreenRaster()
// is the OffscreenCanvas one the worker uses (the vendor's canvas code moved into it unchanged); stretchContrast makes
// its output with raster.imageData(w, h) instead of new ImageData(...); yieldToUi uses globalThis.setTimeout (a worker
// has no window); renderJpeg re-encodes at quality -0.1 steps down to 0.5 while the blob is over MAX_IMAGE_BYTES
// (20 MiB), then throws ScanImageTooLarge; Source is exported; loadBitmap is unchanged (createImageBitmap exists in
// both the window and the worker, so it needs no Raster).
/**
 * Reading a page image: what format it is, where its QR code is and what it
 * says, which way up the page is, and whether it is blank. Canvas based, so
 * it runs in Obsidian's renderer with no native dependency.
 */
import jsQR from 'jsqr';
import { decodeScanPayload, type ScanPayload } from '@labnoteo/core/lib/scanPayload';

export type FileKind = 'jpeg' | 'png' | 'webp' | 'gif' | 'bmp' | 'pdf' | 'zip' | 'heic' | 'tiff' | 'unknown';

/** The format by its first bytes; file extensions from phones and scanners are not reliable. */
export function sniffFileKind(bytes: Uint8Array): FileKind {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpeg';
  if (bytes[0] === 0x89 && ascii(1, 4) === 'PNG') return 'png';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  if (ascii(0, 3) === 'GIF') return 'gif';
  if (ascii(0, 2) === 'BM') return 'bmp';
  if (ascii(0, 5) === '%PDF-') return 'pdf';
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return 'zip';
  if (ascii(4, 8) === 'ftyp' && /^(heic|heix|hevc|hevx|heim|heis|mif1|msf1|avif)$/.test(ascii(8, 12))) return 'heic';
  if ((ascii(0, 2) === 'II' && bytes[2] === 42 && bytes[3] === 0) || (ascii(0, 2) === 'MM' && bytes[2] === 0 && bytes[3] === 42)) {
    return 'tiff';
  }
  return 'unknown';
}

export const IMAGE_KINDS: ReadonlySet<FileKind> = new Set(['jpeg', 'png', 'webp', 'gif', 'bmp']);

/** Clockwise quarter turns that put the page upright. */
export type Rotation = 0 | 90 | 180 | 270;

export interface QrHit {
  text: string;
  payload: ScanPayload;
  rotation: Rotation;
}

/**
 * The turn that makes the QR's top edge (top-left → top-right corner, in
 * image coordinates) point right again.
 */
export function rotationFromCorners(topLeft: { x: number; y: number }, topRight: { x: number; y: number }): Rotation {
  const angle = (Math.atan2(topRight.y - topLeft.y, topRight.x - topLeft.x) * 180) / Math.PI;
  const quarter = ((Math.round(angle / 90) % 4) + 4) % 4;
  return ((4 - quarter) % 4) * 90 as Rotation;
}

/** Largest side the first QR search works at: jsQR takes ~130 ms there, ~470 ms at 2400 px. */
const SEARCH_EDGE = 1600;
/** Crops searched again at full resolution when the whole page gave nothing. */
const CROPS: readonly [number, number, number, number][] = [
  [0.5, 0, 0.5, 0.5],
  [0, 0.5, 0.5, 0.5],
  [0, 0, 0.5, 0.5],
  [0.5, 0.5, 0.5, 0.5],
];

export type Source = CanvasImageSource & { width: number; height: number };

/** The largest scan image the app stores (the same cap as `vault_read_image` and `scan_write_image`). */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** The lowest JPEG quality `renderJpeg` steps down to before giving up. */
const MIN_JPEG_QUALITY = 0.5;

/** The page image even after the quality step-down is over `MAX_IMAGE_BYTES`. */
export class ScanImageTooLarge extends Error {
  constructor() {
    super('scan image over 20 MiB');
    this.name = 'ScanImageTooLarge';
  }
}

/** Pixel access the decoder needs: OffscreenCanvas in the worker (`offscreenRaster`), a fake in tests. */
export interface Raster {
  /** The `sx, sy, sw, sh` rectangle of `src` scaled to `w`×`h`, as pixels. */
  draw(src: Source, sx: number, sy: number, sw: number, sh: number, w: number, h: number): ImageData;
  /** A new, transparent `w`×`h` image. */
  imageData(w: number, h: number): ImageData;
  /** `src` turned by `rotation`, scaled to `maxEdge` on a white ground, as a JPEG at `quality`. */
  jpeg(src: Source, rotation: Rotation, maxEdge: number, quality: number): Promise<Blob>;
}

/** The OffscreenCanvas raster. Worker only (and any context that has OffscreenCanvas and ImageData). */
export function offscreenRaster(): Raster {
  return {
    draw(source, sx, sy, sw, sh, w, h) {
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(source, sx, sy, sw, sh, 0, 0, w, h);
      return ctx.getImageData(0, 0, w, h);
    },
    imageData(w, h) {
      return new ImageData(w, h);
    },
    jpeg(source, rotation, maxEdge, quality) {
      const scale = Math.min(1, maxEdge / Math.max(source.width, source.height));
      const w = Math.round(source.width * scale);
      const h = Math.round(source.height * scale);
      const sideways = rotation === 90 || rotation === 270;
      const canvas = new OffscreenCanvas(sideways ? h : w, sideways ? w : h);
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate((rotation * Math.PI) / 180);
      ctx.drawImage(source, -w / 2, -h / 2, w, h);
      return canvas.convertToBlob({ type: 'image/jpeg', quality });
    },
  };
}

function draw(
  raster: Raster,
  source: Source,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  maxEdge: number
): { data: ImageData; scale: number } {
  const scale = Math.min(1, maxEdge / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));
  return { data: raster.draw(source, sx, sy, sw, sh, w, h), scale };
}

/** Stretch the grey levels to the full range: helps dim photos and faded prints. */
export function stretchContrast(img: ImageData, raster: Raster): ImageData {
  const d = img.data;
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) hist[(d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8]++;
  const total = d.length / 4;
  const cut = total * 0.01;
  let lo = 0;
  let hi = 255;
  for (let acc = 0; lo < 255 && (acc += hist[lo]) < cut; lo++);
  for (let acc = 0; hi > 0 && (acc += hist[hi]) < cut; hi--);
  if (hi <= lo) return img;
  const out = raster.imageData(img.width, img.height);
  const k = 255 / (hi - lo);
  for (let i = 0; i < d.length; i += 4) {
    const g = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
    const v = Math.max(0, Math.min(255, (g - lo) * k));
    out.data[i] = out.data[i + 1] = out.data[i + 2] = v;
    out.data[i + 3] = 255;
  }
  return out;
}

function tryDecode(img: ImageData): { text: string; payload: ScanPayload; rotation: Rotation } | 'foreign' | null {
  const hit = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
  if (!hit) return null;
  const payload = decodeScanPayload(hit.data);
  if (!payload) return 'foreign';
  return { text: hit.data, payload, rotation: rotationFromCorners(hit.location.topLeftCorner, hit.location.topRightCorner) };
}

const yieldToUi = () => new Promise<void>(resolve => globalThis.setTimeout(resolve, 0));

/**
 * Find our QR code on the page: the whole page first, then each quarter at
 * full resolution, then the same with the contrast stretched. Another QR code
 * on the page (a reagent label) is skipped, not taken for ours.
 */
export async function findQr(source: Source, raster: Raster): Promise<{ hit: QrHit | null; foreign: boolean }> {
  let foreign = false;
  const attempts: (() => ImageData)[] = [
    () => draw(raster, source, 0, 0, source.width, source.height, SEARCH_EDGE).data,
    ...CROPS.map(([x, y, w, h]) => () =>
      draw(raster, source, x * source.width, y * source.height, w * source.width, h * source.height, SEARCH_EDGE).data
    ),
  ];
  for (const enhance of [false, true]) {
    for (const attempt of attempts) {
      const img = attempt();
      const result = tryDecode(enhance ? stretchContrast(img, raster) : img);
      if (result === 'foreign') foreign = true;
      else if (result) return { hit: result, foreign };
      await yieldToUi();
    }
  }
  return { hit: null, foreign };
}

/** Too little variation in brightness to hold writing: a blank sheet (or the back of one). */
export function isBlankPage(source: Source, raster: Raster): boolean {
  const { data } = draw(raster, source, 0, 0, source.width, source.height, 200);
  const d = data.data;
  const n = d.length / 4;
  let sum = 0;
  let sq = 0;
  for (let i = 0; i < d.length; i += 4) {
    const g = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
    sum += g;
    sq += g * g;
  }
  const mean = sum / n;
  return Math.sqrt(Math.max(0, sq / n - mean * mean)) < 6;
}

/**
 * The page turned upright, scaled to `maxEdge`, as JPEG bytes. Over `MAX_IMAGE_BYTES` it is encoded again 0.1 lower
 * in quality, down to 0.5; still over, it throws `ScanImageTooLarge`.
 */
export async function renderJpeg(
  source: Source,
  rotation: Rotation,
  maxEdge: number,
  quality: number,
  raster: Raster
): Promise<ArrayBuffer> {
  let q = quality;
  for (;;) {
    const blob = await raster.jpeg(source, rotation, maxEdge, q);
    if (blob.size <= MAX_IMAGE_BYTES) return blob.arrayBuffer();
    if (q <= MIN_JPEG_QUALITY) throw new ScanImageTooLarge();
    q = Math.max(MIN_JPEG_QUALITY, Math.round((q - 0.1) * 100) / 100);
  }
}

/** Decode image bytes with the camera's EXIF orientation applied. */
export function loadBitmap(bytes: ArrayBuffer): Promise<ImageBitmap> {
  return createImageBitmap(new Blob([bytes]), { imageOrientation: 'from-image' });
}
