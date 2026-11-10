/**
 * CSV/TSV 읽기(UI 재설계 Task 18). 순수 함수: BOM 을 떼고, 구분자를 고르고(쉼표·탭·세미콜론), RFC 4180 따옴표
 * (구분자·줄바꿈을 품은 칸, 겹친 따옴표 "")를 푼다. 첫 줄이 머리다. 칸 수가 모자란 줄은 빈 칸으로 채운다.
 */
export type Delimiter = ',' | '\t' | ';';

export interface ParsedCsv {
  header: string[];
  rows: string[][];
  delimiter: Delimiter;
}

const CANDIDATES: readonly Delimiter[] = [',', '\t', ';'];

/** 따옴표 밖의 첫 줄(최대 몇 줄)에서 가장 많이 나온 구분자. 아무것도 없으면 쉼표. */
export function sniffDelimiter(text: string): Delimiter {
  const counts = new Map<Delimiter, number>(CANDIDATES.map((d) => [d, 0]));
  let quoted = false;
  let lines = 0;
  for (let i = 0; i < text.length && lines < 5; i++) {
    const c = text[i];
    if (c === '"') quoted = !quoted;
    else if (!quoted && (c === '\n' || c === '\r')) {
      if (c === '\r' && text[i + 1] === '\n') i++;
      lines++;
      // 첫 줄에서 구분자를 하나라도 봤으면 그것으로 정한다
      if (lines === 1 && [...counts.values()].some((n) => n > 0)) break;
    } else if (!quoted && counts.has(c as Delimiter)) counts.set(c as Delimiter, counts.get(c as Delimiter)! + 1);
  }
  let best: Delimiter = ',';
  for (const d of CANDIDATES) if (counts.get(d)! > counts.get(best)!) best = d;
  return best;
}

/** 텍스트를 표로. `hint`(예: .tsv 의 탭)가 있으면 고르지 않고 그것을 쓴다. */
export function parseCsv(input: string, hint?: Delimiter): ParsedCsv {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const delimiter = hint ?? sniffDelimiter(text);
  if (text === '') return { header: [], rows: [], delimiter };
  const all: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else cell += c;
      i++;
      continue;
    }
    if (c === '"' && cell === '') quoted = true;
    else if (c === delimiter) {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      all.push(row);
      row = [];
      cell = '';
    } else cell += c;
    i++;
  }
  // 마지막 줄바꿈 뒤의 빈 줄은 줄이 아니다
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    all.push(row);
  }
  const width = all.reduce((w, r) => Math.max(w, r.length), 0);
  const pad = (r: string[]) => (r.length < width ? [...r, ...Array<string>(width - r.length).fill('')] : r);
  const [header = [], ...rows] = all.map(pad);
  return { header, rows, delimiter };
}

const NUMBER = /^[+-]?(?:\d+(?:[.,]\d+)*(?:[.,]\d*)?|[.,]\d+)(?:[eE][+-]?\d+)?%?$/;

/** 숫자 칸인가(부호, 소수점·천 단위 쉼표, 지수, 끝의 %). */
export const isNumericCell = (s: string): boolean => NUMBER.test(s.trim());

/** `i` 번째 칸이 숫자 열인가: 빈 칸이 아닌 칸이 하나 이상이고 모두 숫자다. */
export function isNumericColumn(rows: readonly (readonly string[])[], i: number): boolean {
  let seen = false;
  for (const r of rows) {
    const v = (r[i] ?? '').trim();
    if (v === '') continue;
    if (!isNumericCell(v)) return false;
    seen = true;
  }
  return seen;
}
