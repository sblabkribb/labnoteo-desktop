/**
 * CSV 를 화면 스레드 밖에서 읽기(Task 14). 바이트를 csvWorker.ts 로 넘긴다(transfer). Worker 가 없으면(jsdom) 같은
 * 본체(csvJob.ts)를 화면 스레드에서 조각 사이마다 쉬면서 돌린다. 화면을 닫으면(abort) Worker 를 끝낸다.
 */
import type { Delimiter } from './csv';
import { runCsvJob, type CsvHeader, type CsvJob, type CsvMessage } from './csvJob';

export { COL_WINDOW, FIRST_ROWS, RAW_CAP, ROW_CAP, SLICE_CHARS, type CsvHeader } from './csvJob';

export interface LoadCsvOptions {
  hint?: Delimiter;
  /** Worker 를 만든다. null 이면 화면 스레드에서 읽는다. 기본값은 csvWorker.ts. */
  worker?: () => Worker | null;
  onHeader(h: CsvHeader): void;
  onRows(rows: string[][], done: boolean, totalRows?: number, numeric?: boolean[]): void;
  onError?(message: string): void;
  signal?: AbortSignal;
}

function defaultWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null;
  return new Worker(new URL('./csvWorker.ts', import.meta.url), { type: 'module' });
}

/** 화면 스레드에서 조각 사이에 쉬는 법: 다음 매크로 작업까지 기다린다(입력·그리기가 끼어든다). */
const yieldToUi = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** CSV 바이트를 읽어 머리 줄과 줄 묶음을 차례로 알린다. Worker 가 있으면 바이트는 Worker 로 옮겨진다(transfer). */
export function loadCsv(bytes: Uint8Array, opts: LoadCsvOptions): void {
  const { signal } = opts;
  if (signal?.aborted) return;
  let stopped = false;
  const deliver = (m: CsvMessage) => {
    if (stopped || signal?.aborted) return;
    if (m.type === 'header') {
      const { type: _type, ...h } = m;
      opts.onHeader(h);
    } else if (m.type === 'rows') {
      if (m.done) stopped = true;
      opts.onRows(m.rows, m.done, m.totalRows, m.numeric);
    } else {
      stopped = true;
      opts.onError?.(m.message);
    }
  };

  let worker: Worker | null = null;
  try {
    worker = (opts.worker ?? defaultWorker)();
  } catch {
    worker = null;
  }

  if (worker) {
    const w = worker;
    const stop = () => w.terminate();
    w.onmessage = (e: MessageEvent<CsvMessage>) => {
      deliver(e.data);
      if (stopped) stop();
    };
    w.onerror = (e: ErrorEvent) => {
      e.preventDefault?.();
      deliver({ type: 'error', message: e.message || 'worker failed' });
      stop();
    };
    signal?.addEventListener('abort', stop, { once: true });
    const job: CsvJob = { buffer: bytes.buffer as ArrayBuffer, offset: bytes.byteOffset, length: bytes.byteLength, hint: opts.hint };
    w.postMessage(job, [bytes.buffer as ArrayBuffer]);
    return;
  }

  runCsvJob(bytes, opts.hint, deliver, yieldToUi, () => stopped || !!signal?.aborted).catch((e: unknown) =>
    deliver({ type: 'error', message: e instanceof Error ? e.message : String(e) }),
  );
}
