/**
 * CSV 를 화면 스레드 밖에서 읽기(Task 14, 스펙 §10.1). 바이트를 모듈 Worker 로 넘기고(transfer), Worker 가 글로 풀고
 * (UTF-8, 아니면 EUC-KR), 구분자를 고르고, 1 MiB 씩 잘라 읽고, 숫자 열을 센다. 머리 줄과 첫 1,000 줄을 먼저 보내고,
 * 나머지는 5,000 줄(ROW_CAP)까지만 보낸 뒤 전체 줄 수를 보낸다. 이 파일은 Worker 와 화면 스레드가 같이 쓰는 본체다
 * (DOM 없음). Worker 를 만드는 쪽은 csvLoad.ts.
 */
import { CsvChunkParser, NumericColumns, sniffDelimiter, type Delimiter } from './csv';
import { decodeText, type TextEncodingName } from './decode';

/** 표에 담아 두는 줄의 최대 수. 넘는 줄은 세기만 한다. */
export const ROW_CAP = 5000;
/** 한 번에 그리는 열의 수. */
export const COL_WINDOW = 50;
/** 머리 줄과 함께 먼저 보내는 줄의 수. */
export const FIRST_ROWS = 1000;
/** 한 번에 읽는 글의 길이(1 Mi 글자). */
export const SLICE_CHARS = 1 << 20;
/** "텍스트로 보기"에 보내는 원문의 최대 길이. */
export const RAW_CAP = 1 << 20;

export interface CsvHeader {
  header: string[];
  delimiter: Delimiter;
  encoding: TextEncodingName;
  /** 원문의 앞부분(최대 RAW_CAP 글자, BOM 없음). */
  raw: string;
  rawCapped: boolean;
}

export type CsvMessage =
  | ({ type: 'header' } & CsvHeader)
  | { type: 'rows'; rows: string[][]; done: boolean; totalRows?: number; numeric?: boolean[] }
  | { type: 'error'; message: string };

/** Worker 에 보내는 일감. */
export interface CsvJob {
  buffer: ArrayBuffer;
  offset: number;
  length: number;
  hint?: Delimiter;
}

/**
 * 읽기 본체. Worker 와 화면 스레드가 같이 쓴다. `pause` 는 조각 사이에 기다릴 것(Worker 에서는 바로 넘어간다),
 * `aborted` 가 참이면 아무것도 더 보내지 않고 멈춘다.
 */
export async function runCsvJob(
  bytes: Uint8Array,
  hint: Delimiter | undefined,
  emit: (m: CsvMessage) => void,
  pause: () => Promise<void>,
  aborted: () => boolean,
): Promise<void> {
  const decoded = decodeText(bytes);
  const text = decoded.text.charCodeAt(0) === 0xfeff ? decoded.text.slice(1) : decoded.text;
  const delimiter = hint ?? sniffDelimiter(text);
  const parser = new CsvChunkParser(delimiter);
  const numeric = new NumericColumns();
  let header: string[] | null = null;
  let headerSent = false;
  let pending: string[][] = [];
  let kept = 0;
  let total = 0;
  let width = 0;
  const onRow = (r: string[]) => {
    width = Math.max(width, r.length);
    if (header === null) {
      header = r;
      return;
    }
    total++;
    numeric.add(r);
    if (kept < ROW_CAP) {
      pending.push(r);
      kept++;
    }
  };
  const sendHeader = () => {
    headerSent = true;
    emit({
      type: 'header',
      header: header ?? [],
      delimiter,
      encoding: decoded.encoding,
      raw: text.length > RAW_CAP ? text.slice(0, RAW_CAP) : text,
      rawCapped: text.length > RAW_CAP,
    });
  };
  const flush = (done: boolean) => {
    const rows = pending;
    pending = [];
    if (done) emit({ type: 'rows', rows, done, totalRows: total, numeric: numeric.result(width) });
    else if (rows.length > 0) emit({ type: 'rows', rows, done });
  };

  for (let at = 0; at < text.length; at += SLICE_CHARS) {
    if (at > 0) {
      await pause();
      if (aborted()) return;
    }
    parser.push(text.slice(at, at + SLICE_CHARS), onRow);
    if (!headerSent && kept >= FIRST_ROWS) sendHeader();
    if (headerSent && at + SLICE_CHARS < text.length) flush(false);
  }
  parser.end(onRow);
  if (aborted()) return;
  if (!headerSent) sendHeader();
  flush(true);
}

