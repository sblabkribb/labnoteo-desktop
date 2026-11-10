import { vi } from 'vitest';
import { CsvChunkParser, parseCsv } from '../csv';
import { decodeText } from '../decode';
import { FIRST_ROWS, ROW_CAP, SLICE_CHARS, loadCsv } from '../csvLoad';

const enc = (s: string) => new TextEncoder().encode(s);

type Ev = { kind: 'header'; header: string[] } | { kind: 'rows'; n: number; done: boolean; total?: number; numeric?: boolean[] };

function collect(bytes: Uint8Array, extra: Partial<Parameters<typeof loadCsv>[1]> = {}) {
  const events: Ev[] = [];
  const rows: string[][] = [];
  let encoding = '';
  let finished: () => void = () => {};
  const done = new Promise<void>((r) => (finished = r));
  loadCsv(bytes, {
    worker: () => null,
    onHeader: (h) => {
      encoding = h.encoding;
      events.push({ kind: 'header', header: h.header });
    },
    onRows: (r, d, total, numeric) => {
      rows.push(...r);
      events.push({ kind: 'rows', n: r.length, done: d, total, numeric });
      if (d) finished();
    },
    ...extra,
  });
  return { events, rows, done, encoding: () => encoding };
}

describe('CsvChunkParser', () => {
  it('quoted fields with newlines across slice boundaries parse the same as the one-shot parser', () => {
    const text =
      '\uFEFFname,note,v\r\n"Lee, J","said ""hi""",1\r\n"x","two\r\nlines",2\n"",,3\r\n"a""b",c,"4"\n"end"';
    const whole = parseCsv(text);
    for (let size = 1; size <= 7; size++) {
      const p = new CsvChunkParser(',');
      const out: string[][] = [];
      const body = text.slice(1);
      for (let i = 0; i < body.length; i += size) p.push(body.slice(i, i + size), (r) => out.push(r));
      p.end((r) => out.push(r));
      const width = whole.header.length;
      const padded = out.map((r) => [...r, ...Array<string>(width - r.length).fill('')]);
      expect(padded[0]).toEqual(whole.header);
      expect(padded.slice(1)).toEqual(whole.rows);
    }
  });
});

describe('loadCsv without a Worker', () => {
  afterEach(() => vi.useRealTimers());

  it('parses a 3 MiB input in 1 MiB slices and yields between slices', async () => {
    vi.useFakeTimers();
    const line = 'r0123456789,42,"q\nq"\n';
    const n = Math.ceil((3 * SLICE_CHARS) / line.length);
    const text = 'id,v,note\n' + line.repeat(n);
    const c = collect(enc(text));
    // the first slice runs at once: header plus the first rows, but not the end
    expect(c.events[0]).toEqual({ kind: 'header', header: ['id', 'v', 'note'] });
    expect(c.events[1].kind).toBe('rows');
    expect((c.events[1] as { n: number }).n).toBeGreaterThanOrEqual(FIRST_ROWS);
    expect(c.events.some((e) => e.kind === 'rows' && e.done)).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(c.events.some((e) => e.kind === 'rows' && e.done)).toBe(false);
    await vi.runAllTimersAsync();
    await c.done;
    const last = c.events[c.events.length - 1] as Extract<Ev, { kind: 'rows' }>;
    expect(last.done).toBe(true);
    expect(last.total).toBe(n);
    expect(last.numeric).toEqual([false, true, false]);
    expect(c.rows).toHaveLength(ROW_CAP);
    expect(c.rows[0]).toEqual(['r0123456789', '42', 'q\nq']);
  });

  it('a small file sends header then one final batch', async () => {
    const c = collect(enc('a,b\n1,x\n2,'));
    await c.done;
    expect(c.events).toEqual([
      { kind: 'header', header: ['a', 'b'] },
      { kind: 'rows', n: 2, done: true, total: 2, numeric: [true, false] },
    ]);
  });

  it('decodes EUC-KR like decode.ts', async () => {
    const bytes = new Uint8Array([0xbd, 0xc3, 0xb7, 0xe1, 0x2c, 0xb0, 0xaa, 0x0a, 0x31, 0x2c, 0x32]);
    const expected = decodeText(bytes.slice()).text;
    const c = collect(bytes);
    await c.done;
    expect(c.encoding()).toBe('euc-kr');
    expect([(c.events[0] as { header: string[] }).header.join(','), c.rows[0].join(',')].join('\n')).toBe(expected);
  });

  it('an aborted load stops emitting', async () => {
    vi.useFakeTimers();
    const ctl = new AbortController();
    const text = 'a\n' + 'x\n'.repeat(SLICE_CHARS);
    const c = collect(enc(text), { signal: ctl.signal });
    const before = c.events.length;
    ctl.abort();
    await vi.runAllTimersAsync();
    expect(c.events.length).toBe(before);
  });
});

describe('loadCsv with a Worker', () => {
  class FakeWorker {
    posted: unknown[] = [];
    transfer: Transferable[] | undefined;
    terminated = false;
    onmessage: ((e: MessageEvent) => void) | null = null;
    onerror: ((e: ErrorEvent) => void) | null = null;
    postMessage(m: unknown, t?: Transferable[]) {
      this.posted.push(m);
      this.transfer = t;
    }
    terminate() {
      this.terminated = true;
    }
  }

  it('transfers the buffer, relays messages and terminates on abort', () => {
    const w = new FakeWorker();
    const ctl = new AbortController();
    const onHeader = vi.fn();
    const onRows = vi.fn();
    const bytes = enc('a,b\n1,2');
    loadCsv(bytes, { hint: '\t', worker: () => w as unknown as Worker, onHeader, onRows, signal: ctl.signal });
    expect(w.transfer).toEqual([bytes.buffer]);
    expect(w.posted[0]).toMatchObject({ hint: '\t' });
    w.onmessage!({ data: { type: 'header', header: ['a'], delimiter: ',', encoding: 'utf-8', raw: 'a', rawCapped: false } } as MessageEvent);
    expect(onHeader).toHaveBeenCalledWith(expect.objectContaining({ header: ['a'], encoding: 'utf-8' }));
    w.onmessage!({ data: { type: 'rows', rows: [['1']], done: false } } as MessageEvent);
    expect(onRows).toHaveBeenCalledWith([['1']], false, undefined, undefined);
    ctl.abort();
    expect(w.terminated).toBe(true);
    w.onmessage!({ data: { type: 'rows', rows: [['2']], done: true, totalRows: 2 } } as MessageEvent);
    expect(onRows).toHaveBeenCalledTimes(1);
  });

  it('terminates the worker once the last batch arrives', () => {
    const w = new FakeWorker();
    loadCsv(enc('a'), { worker: () => w as unknown as Worker, onHeader: () => {}, onRows: () => {} });
    w.onmessage!({ data: { type: 'rows', rows: [], done: true, totalRows: 0, numeric: [] } } as MessageEvent);
    expect(w.terminated).toBe(true);
  });
});
