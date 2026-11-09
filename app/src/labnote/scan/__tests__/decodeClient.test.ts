import { describe, expect, it } from 'vitest';
import { createDecodeClient, type DecodeRequest, type DecodeResponse } from '../decodeClient';
import { ScanImageTooLarge } from '../../port/scanDecode';

type Reply = (req: DecodeRequest) => DecodeResponse | undefined;

/** A stand-in Worker: records each post and answers on a microtask with `reply` (undefined: never answers). */
class FakeWorker {
  onmessage: ((e: MessageEvent<DecodeResponse>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  posts: Array<{ msg: DecodeRequest; transfer: Transferable[] }> = [];
  terminated = 0;
  constructor(private reply: Reply) {}
  postMessage(msg: DecodeRequest, transfer: Transferable[]) {
    this.posts.push({ msg, transfer });
    queueMicrotask(() => {
      const out = this.reply(msg);
      if (out && !this.terminated) this.onmessage?.({ data: out } as MessageEvent<DecodeResponse>);
    });
  }
  terminate() {
    this.terminated++;
  }
}

const ok = (req: DecodeRequest): DecodeResponse => ({
  id: req.id,
  ok: true,
  hit: null,
  foreign: false,
  blank: false,
  jpeg: new ArrayBuffer(req.maxEdge),
  rotation: 0,
});

const bitmap = (n: number) => ({ width: n, height: n, close() {} }) as unknown as ImageBitmap;

describe('createDecodeClient', () => {
  it('two requests resolve in order, one at a time, and each bitmap is transferred', async () => {
    const workers: FakeWorker[] = [];
    const client = createDecodeClient(() => {
      const w = new FakeWorker(ok);
      workers.push(w);
      return w as unknown as Worker;
    });
    const b1 = bitmap(1);
    const b2 = bitmap(2);
    const order: number[] = [];
    const p1 = client.page(b1, { maxEdge: 10, quality: 0.85 }).then(r => (order.push(1), r));
    const p2 = client.page(b2, { maxEdge: 20, quality: 0.85 }).then(r => (order.push(2), r));
    // the second waits until the first answered
    expect(workers).toHaveLength(1);
    expect(workers[0].posts).toHaveLength(1);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2]);
    expect(r1.jpeg.byteLength).toBe(10);
    expect(r2.jpeg.byteLength).toBe(20);
    expect(workers).toHaveLength(1);
    const posts = workers[0].posts;
    expect(posts.map(p => p.msg)).toEqual([
      { id: posts[0].msg.id, op: 'page', bitmap: b1, maxEdge: 10, quality: 0.85 },
      { id: posts[1].msg.id, op: 'page', bitmap: b2, maxEdge: 20, quality: 0.85 },
    ]);
    expect(posts[0].msg.id).not.toBe(posts[1].msg.id);
    expect(posts[0].transfer).toEqual([b1]);
    expect(posts[1].transfer).toEqual([b2]);
  });

  it('keepBlank reaches the worker, so a page it must show is rendered even when judged blank', async () => {
    const w = new FakeWorker(ok);
    const client = createDecodeClient(() => w as unknown as Worker);
    await client.page(bitmap(1), { maxEdge: 10, quality: 0.8, keepBlank: true });
    await client.page(bitmap(2), { maxEdge: 10, quality: 0.8 });
    expect(w.posts.map(p => p.msg.keepBlank)).toEqual([true, undefined]);
  });

  it('terminate rejects the pending and queued requests and stops the worker', async () => {
    const w = new FakeWorker(() => undefined);
    const client = createDecodeClient(() => w as unknown as Worker);
    const p1 = client.page(bitmap(1), { maxEdge: 10, quality: 0.8 });
    const p2 = client.page(bitmap(2), { maxEdge: 10, quality: 0.8 });
    client.terminate();
    await expect(p1).rejects.toThrow();
    await expect(p2).rejects.toThrow();
    expect(w.terminated).toBe(1);
    expect(w.posts).toHaveLength(1);
  });

  it('a page after terminate starts a fresh worker', async () => {
    const workers: FakeWorker[] = [];
    const client = createDecodeClient(() => {
      const w = new FakeWorker(ok);
      workers.push(w);
      return w as unknown as Worker;
    });
    await client.page(bitmap(1), { maxEdge: 5, quality: 0.8 });
    client.terminate();
    const r = await client.page(bitmap(2), { maxEdge: 6, quality: 0.8 });
    expect(r.jpeg.byteLength).toBe(6);
    expect(workers).toHaveLength(2);
  });

  it('tooLarge rejects with ScanImageTooLarge, failed with an Error, and the queue goes on', async () => {
    let n = 0;
    const answers: Reply[] = [
      req => ({ id: req.id, ok: false, error: 'tooLarge' }),
      req => ({ id: req.id, ok: false, error: 'failed' }),
      ok,
    ];
    const client = createDecodeClient(() => new FakeWorker(req => answers[n++](req)) as unknown as Worker);
    const p1 = client.page(bitmap(1), { maxEdge: 10, quality: 0.8 });
    const p2 = client.page(bitmap(2), { maxEdge: 10, quality: 0.8 });
    const p3 = client.page(bitmap(3), { maxEdge: 10, quality: 0.8 });
    await expect(p1).rejects.toBeInstanceOf(ScanImageTooLarge);
    await expect(p2).rejects.not.toBeInstanceOf(ScanImageTooLarge);
    await expect(p2).rejects.toThrow();
    expect((await p3).jpeg.byteLength).toBe(10);
  });

  it('a worker error rejects the page in flight and the next page gets a new worker', async () => {
    const workers: FakeWorker[] = [];
    const client = createDecodeClient(() => {
      const w = new FakeWorker(workers.length === 0 ? () => undefined : ok);
      workers.push(w);
      return w as unknown as Worker;
    });
    const p1 = client.page(bitmap(1), { maxEdge: 10, quality: 0.8 });
    const p2 = client.page(bitmap(2), { maxEdge: 11, quality: 0.8 });
    await Promise.resolve();
    workers[0].onerror?.({ message: 'boom' } as ErrorEvent);
    await expect(p1).rejects.toThrow();
    expect((await p2).jpeg.byteLength).toBe(11);
    expect(workers[0].terminated).toBe(1);
    expect(workers).toHaveLength(2);
  });
});
