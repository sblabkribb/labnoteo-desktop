/**
 * The scan decode worker: reads a page bitmap off the UI thread, so typing and Korean IME composition stay responsive
 * while scans are imported. Same order as the vendor page decoder: blank check, then the QR search on a page that is
 * not blank, then the upright JPEG. The bitmap is closed when done; the JPEG is transferred back.
 */
import { ScanImageTooLarge, findQr, isBlankPage, offscreenRaster, renderJpeg, type Rotation } from '../port/scanDecode';
import type { DecodeRequest, DecodeResponse } from './decodeClient';

interface WorkerScope {
  onmessage: ((e: MessageEvent<DecodeRequest>) => void) | null;
  postMessage(message: DecodeResponse, transfer?: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;

async function decodePage(req: DecodeRequest): Promise<DecodeResponse> {
  const { id, bitmap, maxEdge, quality } = req;
  try {
    const raster = offscreenRaster();
    const blank = isBlankPage(bitmap, raster);
    if (blank) return { id, ok: true, hit: null, foreign: false, blank, jpeg: new ArrayBuffer(0), rotation: 0 };
    const { hit, foreign } = await findQr(bitmap, raster);
    const rotation: Rotation = hit?.rotation ?? 0;
    const jpeg = await renderJpeg(bitmap, rotation, maxEdge, quality, raster);
    return { id, ok: true, hit, foreign, blank, jpeg, rotation };
  } catch (err) {
    return { id, ok: false, error: err instanceof ScanImageTooLarge ? 'tooLarge' : 'failed' };
  } finally {
    bitmap.close();
  }
}

scope.onmessage = e => {
  if (e.data?.op !== 'page') return;
  void decodePage(e.data).then(out => scope.postMessage(out, out.ok ? [out.jpeg] : []));
};
