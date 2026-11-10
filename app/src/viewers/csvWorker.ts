/**
 * CSV 읽기 Worker(Task 14). 옮겨 받은 바이트를 `runCsvJob` 으로 읽고 메시지를 그대로 돌려보낸다. DOM 은 쓰지 않는다.
 */
import { runCsvJob, type CsvJob, type CsvMessage } from './csvJob';

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<CsvJob>) => void) | null;
  postMessage(m: CsvMessage): void;
};

scope.onmessage = (e) => {
  const { buffer, offset, length, hint } = e.data;
  const post = (m: CsvMessage) => scope.postMessage(m);
  runCsvJob(new Uint8Array(buffer, offset, length), hint, post, () => Promise.resolve(), () => false).catch((err: unknown) =>
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) }),
  );
};
