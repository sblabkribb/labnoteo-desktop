/**
 * The window side of the decode worker (`decode.worker.ts`): one worker, pages decoded one at a time in the order
 * asked, each bitmap transferred (it is unusable here afterwards). The worker is made on the first page and again
 * after `terminate` or a crash, so a vault switch can stop it without breaking a later run.
 */
import { ScanImageTooLarge, type QrHit, type Rotation } from '../port/scanDecode';

/** A page to decode. */
export interface DecodeRequest {
  id: number;
  op: 'page';
  bitmap: ImageBitmap;
  maxEdge: number;
  quality: number;
}

/** What the worker found on a page. `jpeg` is empty for a blank page (a blank page is never stored). */
export interface DecodedWorkerPage {
  hit: QrHit | null;
  foreign: boolean;
  blank: boolean;
  jpeg: ArrayBuffer;
  rotation: Rotation;
}

export type DecodeResponse =
  | ({ id: number; ok: true } & DecodedWorkerPage)
  | { id: number; ok: false; error: 'tooLarge' | 'failed' };

export interface DecodeClient {
  page(bitmap: ImageBitmap, opts: { maxEdge: number; quality: number }): Promise<DecodedWorkerPage>;
  terminate(): void;
}

interface Pending {
  id: number;
  bitmap: ImageBitmap;
  maxEdge: number;
  quality: number;
  resolve(page: DecodedWorkerPage): void;
  reject(err: Error): void;
}

function makeWorker(): Worker {
  return new Worker(new URL('./decode.worker.ts', import.meta.url), { type: 'module' });
}

export function createDecodeClient(make: () => Worker = makeWorker): DecodeClient {
  let worker: Worker | null = null;
  let current: Pending | null = null;
  const queue: Pending[] = [];
  let nextId = 1;

  function stopWorker() {
    worker?.terminate();
    worker = null;
  }

  function settle(): Pending | null {
    const done = current;
    current = null;
    return done;
  }

  function ensureWorker(): Worker {
    if (worker) return worker;
    const w = make();
    w.onmessage = (e: MessageEvent<DecodeResponse>) => {
      if (w !== worker || !current || e.data.id !== current.id) return;
      const done = settle()!;
      const data = e.data;
      if (data.ok) {
        const { hit, foreign, blank, jpeg, rotation } = data;
        done.resolve({ hit, foreign, blank, jpeg, rotation });
      } else {
        done.reject(data.error === 'tooLarge' ? new ScanImageTooLarge() : new Error('scan page decode failed'));
      }
      pump();
    };
    w.onerror = () => {
      if (w !== worker) return;
      stopWorker();
      settle()?.reject(new Error('scan decode worker failed'));
      pump();
    };
    worker = w;
    return w;
  }

  function pump() {
    if (current) return;
    const next = queue.shift();
    if (!next) return;
    current = next;
    const req: DecodeRequest = { id: next.id, op: 'page', bitmap: next.bitmap, maxEdge: next.maxEdge, quality: next.quality };
    try {
      ensureWorker().postMessage(req, [next.bitmap]);
    } catch (err) {
      settle();
      next.reject(err instanceof Error ? err : new Error(String(err)));
      pump();
    }
  }

  return {
    page(bitmap, { maxEdge, quality }) {
      return new Promise<DecodedWorkerPage>((resolve, reject) => {
        queue.push({ id: nextId++, bitmap, maxEdge, quality, resolve, reject });
        pump();
      });
    },
    terminate() {
      stopWorker();
      const dropped = [...(current ? [current] : []), ...queue.splice(0)];
      current = null;
      for (const p of dropped) p.reject(new Error('scan decode worker terminated'));
    },
  };
}
