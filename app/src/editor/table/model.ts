/**
 * GFM 표의 순수 모델. DOM 이 없고, 문서가 유일한 원본이다.
 *
 * - `parseTable` 은 표의 줄 범위를 읽어 행과 셀의 절대 위치를 돌려준다. 셀 나누기는
 *   Lezer 의 parseRow 와 같다: 백슬래시로 escape 한 파이프는 나누지 않고, 코드 스팬 안의 `|` 는 나누되 경고를 남긴다.
 * - 연산은 문서에 대한 `{from, to, insert}` 변경만 돌려준다. 건드리지 않는 셀은 원문 바이트 그대로다.
 * - 짧은 행의 빠진 셀은 가상(virtual) 셀로, 넘치는 셀은 overflow 로 두고 절대 지우지 않는다.
 * - 줄바꿈은 호출하는 쪽이 넘기는 `br`(state.lineBreak)만 쓴다. 행 범위에는 CRLF 의 `\r` 이 들어가지 않는다.
 */

export type Align = 'left' | 'center' | 'right' | null;

export interface Cell {
  /** 셀이 차지하는 범위(양옆 파이프 제외, 공백 포함). */
  from: number;
  to: number;
  /** 앞뒤 공백을 뗀 내용 범위. 빈 셀은 `| ` 바로 뒤(`||` 이면 두 파이프 사이)의 빈 범위다. */
  contentFrom: number;
  contentTo: number;
  /** 원문 그대로의 내용(escape 한 파이프와 `<br>` 이 적힌 대로). */
  text: string;
  /** 짧은 행에서 빠진 셀. 범위는 행 끝이고, 처음 setCell 할 때 채운다. */
  virtual?: boolean;
  /** 머리 행보다 많은 셀. 보여 주기만 하고 지우지 않는다. */
  overflow?: boolean;
}

export interface Row {
  /** 줄 범위(줄바꿈과 CRLF 의 `\r` 제외). */
  from: number;
  to: number;
  cells: Cell[];
  /** 줄의 원문(`from`..`to`). */
  raw: string;
}

export interface TableModel {
  from: number;
  to: number;
  header: Row;
  delimiter: Row;
  body: Row[];
  align: Align[];
  width: number;
  /** 'code-span-pipe' | 'ragged' | 'overflow', 각각 한 번씩. */
  warnings: string[];
}

/** CodeMirror ChangeSpec 과 맞는 변경. 위치는 모두 원래 문서 기준이다. */
export interface Change {
  from: number;
  to: number;
  insert: string;
}

// ---------------------------------------------------------------- 파싱

/** Lezer 의 delimiterLine 에서 인용(`>`) 접두사만 뺀 것. 인용 안의 표는 v1 에서 다루지 않는다. */
const DELIMITER_LINE = /^\s*\|?(\s*:?-+:?\s*\|)+(\s*:?-+:?\s*)?$/;
const BOM = 0xfeff;
const PIPE = 124;
const BACKSLASH = 92;
const BACKTICK = 96;
const isBlank = (ch: number) => ch === 32 || ch === 9;

interface Line {
  from: number;
  to: number;
}

/** [from, to) 를 줄로 나눈다. 줄 끝의 `\r` 은 줄에 넣지 않고, 끝의 빈 줄은 버린다. */
function splitLines(doc: string, from: number, to: number): Line[] {
  const out: Line[] = [];
  let start = from;
  const push = (end: number) => {
    const e = end > start && doc.charCodeAt(end - 1) === 13 ? end - 1 : end;
    out.push({ from: start, to: e });
  };
  for (let i = from; i < to; i++) {
    if (doc.charCodeAt(i) === 10) {
      push(i);
      start = i + 1;
    }
  }
  if (start < to) push(to);
  return out;
}

/** 줄 안의 코드 스팬 범위들 [from, to). 같은 길이의 백틱 묶음이 닫는다. */
function codeSpans(doc: string, from: number, to: number): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let i = from;
  while (i < to) {
    const ch = doc.charCodeAt(i);
    if (ch === BACKSLASH) {
      i += 2;
      continue;
    }
    if (ch !== BACKTICK) {
      i++;
      continue;
    }
    let j = i;
    while (j < to && doc.charCodeAt(j) === BACKTICK) j++;
    const len = j - i;
    let k = j;
    let close = -1;
    while (k < to) {
      if (doc.charCodeAt(k) !== BACKTICK) {
        k++;
        continue;
      }
      let e = k;
      while (e < to && doc.charCodeAt(e) === BACKTICK) e++;
      if (e - k === len) {
        close = e;
        break;
      }
      k = e;
    }
    if (close < 0) {
      i = j;
      continue;
    }
    spans.push([i, close]);
    i = close;
  }
  return spans;
}

/** 한 줄을 셀로 나눈다(Lezer parseRow 와 같은 규칙). */
function scanRow(doc: string, line: Line, warn: (w: string) => void): Row {
  let s = line.from;
  if (doc.charCodeAt(s) === BOM) s++;
  const lt = line.to;
  const spans = codeSpans(doc, s, lt);
  const cells: Cell[] = [];
  let cellFrom = s;
  let first = true;
  let cs = -1;
  let ce = -1;
  let esc = false;
  const push = (to: number) => {
    const empty = cs < 0;
    const contentFrom = empty ? Math.min(cellFrom + 1, to) : cs;
    const contentTo = empty ? contentFrom : ce;
    cells.push({ from: cellFrom, to, contentFrom, contentTo, text: doc.slice(contentFrom, contentTo) });
  };
  for (let i = s; i < lt; i++) {
    const ch = doc.charCodeAt(i);
    if (ch === PIPE && !esc) {
      if (!first || cs > -1) push(i);
      if (spans.some(([a, b]) => i > a && i < b)) warn('code-span-pipe');
      first = false;
      cellFrom = i + 1;
      cs = ce = -1;
    } else if (esc || !isBlank(ch)) {
      if (cs < 0) cs = i;
      ce = i + 1;
    }
    esc = !esc && ch === BACKSLASH;
  }
  if (cs > -1) push(lt);
  return { from: line.from, to: lt, cells, raw: doc.slice(line.from, lt) };
}

/** 줄 끝의 공백을 뺀 위치. */
function trimmedEnd(row: Row): number {
  let e = row.to;
  while (e > row.from && isBlank(row.raw.charCodeAt(e - 1 - row.from))) e--;
  return e;
}

const realCells = (row: Row) => row.cells.filter((c) => !c.virtual);

/** 마지막 실제 셀이 파이프로 닫혀 있는가(셀이 없으면 줄이 파이프뿐이므로 참). */
function hasTrailingPipe(row: Row): boolean {
  const real = realCells(row);
  return real.length === 0 || real[real.length - 1].to < row.to;
}

/** 첫 셀 앞에 파이프가 있는가. */
function hasLeadingPipe(row: Row): boolean {
  const real = realCells(row);
  if (real.length === 0) return true;
  return row.raw.slice(0, real[0].from - row.from).includes('|');
}

/** 빠진 셀이 들어갈 행 끝 위치. */
function appendPos(row: Row): number {
  const real = realCells(row);
  return hasTrailingPipe(row) ? trimmedEnd(row) : real[real.length - 1].contentTo;
}

/** 머리 행 폭에 맞춰 가상 셀을 붙이고 넘치는 셀에 표시한다. */
function normalizeRow(row: Row, width: number, warn: (w: string) => void): Row {
  row.cells.forEach((c, i) => {
    if (i >= width) {
      c.overflow = true;
      warn('overflow');
    }
  });
  if (row.cells.length < width) {
    warn('ragged');
    const p = appendPos(row);
    while (row.cells.length < width) row.cells.push({ from: p, to: p, contentFrom: p, contentTo: p, text: '', virtual: true });
  }
  return row;
}

function parseAlign(text: string): Align {
  const t = text.trim();
  const left = t.startsWith(':');
  const right = t.endsWith(':') && t.length > 1;
  if (left && right) return 'center';
  if (left) return 'left';
  if (right) return 'right';
  return null;
}

/**
 * [from, to) 줄들을 GFM 표로 읽는다. 머리 행, 구분 행, 본문 행 순이다.
 * 구분 행이 아니거나 머리 행과 구분 행의 셀 수가 다르면(Lezer 도 표로 보지 않는다) null.
 */
export function parseTable(doc: string, from: number, to: number): TableModel | null {
  const lines = splitLines(doc, from, to);
  if (lines.length < 2) return null;
  if (!DELIMITER_LINE.test(doc.slice(lines[1].from, lines[1].to))) return null;
  const warnings = new Set<string>();
  const warn = (w: string) => warnings.add(w);
  const header = scanRow(doc, lines[0], warn);
  const delimiter = scanRow(doc, lines[1], warn);
  const width = header.cells.length;
  if (width === 0 || delimiter.cells.length !== width) return null;
  const body = lines.slice(2).map((l) => normalizeRow(scanRow(doc, l, warn), width, warn));
  return {
    from,
    to: lines[lines.length - 1].to,
    header,
    delimiter,
    body,
    align: delimiter.cells.map((c) => parseAlign(c.text)),
    width,
    warnings: [...warnings],
  };
}

/** 머리 행, 그다음 본문 행들. 인덱스 r 은 0 이 머리 행이다. */
export function rows(m: TableModel): Row[] {
  return [m.header, ...m.body];
}

// ---------------------------------------------------------------- 직렬화

/** 이미 escape 된 셀 글자로 `| a | b |` 한 행을 만든다. 칸 맞춤 공백은 넣지 않는다. */
export function serializeRow(texts: string[]): string {
  return `| ${texts.join(' | ')} |`;
}

const alignText = (a: Align) => (a === 'left' ? ':---' : a === 'center' ? ':---:' : a === 'right' ? '---:' : '---');

/** `| --- | :---: | ---: |` 구분 행. */
export function delimiterRow(align: Align[]): string {
  return serializeRow(align.map(alignText));
}

/**
 * 셀에 넣을 글자로 escape 한다: 줄바꿈(CRLF, CR, LF)은 `<br>`, escape 되지 않은 파이프는 앞에 백슬래시를 붙인다.
 * 이미 escape 된 파이프는 그대로 둔다. core 의 escapeSamplePipes 와 같지만,
 * 백슬래시가 짝수 개 앞선 파이프도 Lezer 처럼 escape 되지 않은 것으로 보고 escape 한다.
 */
export function escapeCellText(s: string): string {
  const flat = s.replace(/\r\n|\r|\n/g, '<br>');
  let out = '';
  let backslashes = 0;
  for (const ch of flat) {
    out += ch === '|' && backslashes % 2 === 0 ? '\\|' : ch;
    backslashes = ch === '\\' ? backslashes + 1 : 0;
  }
  return out;
}

/** 새 표: 머리 행(headers 는 escape 한다), 구분 행, 빈 본문 행 `rows` 개. 끝 줄바꿈은 없다. */
export function newTable(rowCount: number, cols: number, br: string, headers?: string[]): string {
  const n = Math.max(1, cols);
  const blank = () => serializeRow(Array.from({ length: n }, () => ''));
  const lines = [
    serializeRow(Array.from({ length: n }, (_, i) => escapeCellText(headers?.[i] ?? ''))),
    delimiterRow(Array.from({ length: n }, () => null)),
  ];
  for (let i = 0; i < rowCount; i++) lines.push(blank());
  return lines.join(br);
}

// ---------------------------------------------------------------- 변경 도우미

/** 같은 위치의 삽입을 합치고 아무 일도 하지 않는 변경을 빼, 정렬된 겹치지 않는 변경으로 만든다. */
function normalize(changes: Change[]): Change[] {
  const sorted = changes
    .filter((c) => c.from !== c.to || c.insert !== '')
    .map((c, i) => ({ c, i }))
    .sort((a, b) => a.c.from - b.c.from || a.i - b.i)
    .map((x) => ({ ...x.c }));
  const out: Change[] = [];
  for (const c of sorted) {
    const p = out[out.length - 1];
    if (p && c.from === p.to && (c.from === c.to || p.from === p.to)) {
      p.insert += c.insert;
      p.to = c.to;
    } else out.push(c);
  }
  return out;
}

/** 끝이 홀수 개 백슬래시이면 뒤에 오는 글자(대개 닫는 파이프)를 escape 한다. */
function endsWithOpenEscape(s: string): boolean {
  let n = 0;
  for (let i = s.length - 1; i >= 0 && s.charCodeAt(i) === BACKSLASH; i--) n++;
  return n % 2 === 1;
}

/**
 * 줄 머리에 오면 Markdown 블록을 여는 글자: 목록(`- x`, `1. x`), 인용(`>`), ATX 제목(`# x`),
 * 코드 펜스, HTML. 공백이 뒤따라야 하는 것(`-5`, `#x` 는 아님)은 CommonMark 대로 본다.
 */
const BLOCK_START = /^(?:(?:[-+*]|\d{1,9}[.)]|#{1,6})(?:[ \t]|$)|>|```|~~~|<)/;

/**
 * 한 셀의 내용을 바꾼다. 비어 있던 셀은 `| x |` 모양이 되도록 공백을 보탠다.
 * 내용이 홀수 개 백슬래시로 끝나면(`dir\`) 공백 하나를 덧붙여, 바로 뒤의 파이프가 escape 되어
 * 다음 셀과 합쳐지지 않게 한다. 그 공백도 escape 되어 셀 글자 끝에 남는다.
 * 바깥 파이프가 없는 줄에서 첫 셀이나 마지막 셀을 비우면 그 셀이 사라지므로(`a | ` 는 셀 하나),
 * 파이프를 보태 빈 셀로 남긴다. 같은 줄의 첫 셀에 블록을 여는 글자를 쓰면 앞에 `| ` 를 붙인다.
 */
function contentChange(row: Row, cell: Cell, text: string, appending: boolean): Change {
  // 공백뿐인 글자는 GFM 이 빈 셀로 읽는다. 그대로 쓰면 위의 빈 셀 규칙을 건너뛰어 가장자리 셀이 사라진다.
  if (text.trim() === '') text = '';
  let insert = endsWithOpenEscape(text) ? text + ' ' : text;
  if (cell.contentFrom === cell.contentTo && text !== '') {
    if (cell.contentFrom === cell.from) insert = ' ' + insert;
    if (cell.contentTo === cell.to) insert += ' ';
  }
  const real = realCells(row);
  const openStart = cell === real[0] && !hasLeadingPipe(row);
  // 바깥 파이프가 없는 줄은 첫 셀 글자로 시작하므로, 블록을 여는 글자(`> 5`, `- x`)면 Lezer 가 표를 끝낸다.
  if (openStart && BLOCK_START.test(text)) insert = '| ' + insert;
  if (text === '' && cell.contentFrom !== cell.contentTo) {
    const openEnd = cell.to === row.to && !appending; // 덧붙이는 셀이 행을 닫아 준다
    if (openStart && openEnd) insert = '|  |';
    else if (openStart) insert = '| ';
    else if (openEnd) insert = '|';
  }
  return { from: cell.contentFrom, to: cell.contentTo, insert };
}

/**
 * 한 행의 여러 칸을 바꾼다. 실제 셀은 내용만 바꾸고, 그 너머(가상 셀이나 새 열)는
 * 행 끝에 덧붙인다. 사이에 빈 칸은 `filler` 로 채운다.
 */
function rowEdits(row: Row, assign: Map<number, string>, filler = ''): Change[] {
  const real = realCells(row);
  const out: Change[] = [];
  const max = Math.max(-1, ...[...assign.keys()].filter((c) => c >= real.length));
  for (const [c, t] of assign) if (c < real.length) out.push(contentChange(row, real[c], t, max >= 0));
  if (max >= 0) {
    const texts: string[] = [];
    for (let k = real.length; k <= max; k++) texts.push(assign.get(k) ?? filler);
    out.push({ from: appendPos(row), to: appendPos(row), insert: appendText(row, texts) });
  }
  return out;
}

/** 행 끝에 붙일 셀들. 닫는 파이프가 없는 행이면 먼저 닫는다(빈 칸이 사라지지 않게). */
function appendText(row: Row, texts: string[]): string {
  const cells = texts.map((t) => ` ${t} |`).join('');
  return hasTrailingPipe(row) ? cells : ' |' + cells;
}

const bodyIndexOk = (m: TableModel, r: number) => Number.isInteger(r) && r >= 1 && r <= m.body.length;
const colOk = (m: TableModel, c: number) => Number.isInteger(c) && c >= 0 && c < m.width;

// ---------------------------------------------------------------- 연산

/**
 * 셀(r=0 머리 행, 1.. 본문)의 내용을 바꾼다. `text` 는 이미 escape 된 글자. 가상 셀이면 행 끝을 채운다.
 * 열은 표 폭(본문 행은 넘치는 셀까지) 안이어야 한다. 그 너머면 아무것도 하지 않는다([]).
 */
export function setCell(m: TableModel, r: number, c: number, text: string): Change[] {
  const row = rows(m)[r];
  if (!row || !Number.isInteger(c) || c < 0) return [];
  if (c >= Math.max(m.width, realCells(row).length)) return [];
  return normalize(rowEdits(row, new Map([[c, text]])));
}

/** 본문 인덱스 `at`(0..body.length) 앞에 빈 행 하나를 넣는다. */
export function insertRow(m: TableModel, at: number, br: string): Change[] {
  if (!Number.isInteger(at) || at < 0 || at > m.body.length) return [];
  const line = serializeRow(Array.from({ length: m.width }, () => ''));
  if (at < m.body.length) {
    const next = m.body[at];
    return [{ from: next.from, to: next.from, insert: line + br }];
  }
  const last = m.body.length ? m.body[m.body.length - 1] : m.delimiter;
  return [{ from: last.to, to: last.to, insert: br + line }];
}

/** 본문 행 r(1..)을 그 줄바꿈과 함께 지운다. 머리 행은 지우지 않는다. */
export function deleteRow(m: TableModel, r: number, _br: string): Change[] {
  if (!bodyIndexOk(m, r)) return [];
  const i = r - 1;
  const row = m.body[i];
  if (i < m.body.length - 1) return [{ from: row.from, to: m.body[i + 1].from, insert: '' }];
  const prev = i > 0 ? m.body[i - 1] : m.delimiter;
  return [{ from: prev.to, to: row.to, insert: '' }];
}

/** 열 `at`(0..width) 앞에 빈 열을 넣는다. 그 위치까지 셀이 없는 짧은 행은 그대로 둔다. */
export function insertColumn(m: TableModel, at: number): Change[] {
  if (!Number.isInteger(at) || at < 0 || at > m.width) return [];
  const out: Change[] = [];
  for (const row of [m.header, m.delimiter, ...m.body]) {
    const text = row === m.delimiter ? '---' : '';
    const real = realCells(row);
    if (at < real.length) {
      const cell = real[at];
      const insert = at === 0 && !hasLeadingPipe(row) ? `| ${text} | ` : ` ${text} |`;
      out.push({ from: cell.from, to: cell.from, insert });
    } else if (at === real.length && real.length >= m.width) {
      const p = appendPos(row);
      out.push({ from: p, to: p, insert: appendText(row, [text]) });
    }
  }
  return normalize(out);
}

/**
 * 한 행에서 c 번째 실제 셀을 지우는 변경. 남은 줄이 여전히 표의 행이 되도록 한다:
 * 바깥 파이프가 없는 줄의 첫 셀을 지우면 그 닫는 파이프를 여는 파이프로 남기고,
 * 셀이 하나만 남는데 닫는 파이프가 없으면 닫는다(`| ---` 는 Lezer 가 구분 행으로 보지 않는다).
 */
function deleteCellChanges(row: Row, c: number): Change[] {
  const real = realCells(row);
  const n = real.length;
  if (c >= n) return [];
  const cell = real[c];
  const leading = hasLeadingPipe(row);
  if (cell.to === row.to) {
    // 닫는 파이프가 없는 마지막 셀: 앞 파이프는 남겨 행을 닫는다(`a | b` -> `a |`, `plain` -> `|`).
    return [{ from: cell.from, to: cell.to, insert: c === 0 && !leading ? '|' : '' }];
  }
  const out: Change[] = [{ from: cell.from, to: c === 0 && !leading ? cell.to : cell.to + 1, insert: '' }];
  if (n === 2 && !hasTrailingPipe(row)) {
    const p = real[1].contentTo;
    out.push({ from: p, to: p, insert: ' |' });
  }
  return out;
}

/** 열 c 를 지운다. 열이 하나뿐이면 지우지 않는다([]). */
export function deleteColumn(m: TableModel, c: number): Change[] {
  if (m.width <= 1 || !colOk(m, c)) return [];
  const out: Change[] = [];
  for (const row of [m.header, m.delimiter, ...m.body]) out.push(...deleteCellChanges(row, c));
  return normalize(out);
}

/** 열 c 의 정렬을 바꾼다. 구분 행의 그 셀만 바뀐다. */
export function setAlign(m: TableModel, c: number, a: Align): Change[] {
  if (!colOk(m, c)) return [];
  return normalize(rowEdits(m.delimiter, new Map([[c, alignText(a)]]), '---'));
}

/** 본문 행 r 을 위(-1)나 아래(+1)로 옮긴다. 두 줄의 원문을 맞바꾼다. */
export function moveRow(m: TableModel, r: number, dir: -1 | 1, _br: string): Change[] {
  const t = r + dir;
  if (!bodyIndexOk(m, r) || !bodyIndexOk(m, t)) return [];
  const a = m.body[r - 1];
  const b = m.body[t - 1];
  return normalize([
    { from: a.from, to: a.to, insert: b.raw },
    { from: b.from, to: b.to, insert: a.raw },
  ]);
}

/** 열 c 를 왼쪽(-1)이나 오른쪽(+1)으로 옮긴다. 행마다 두 셀의 내용을 맞바꾼다. */
export function moveColumn(m: TableModel, c: number, dir: -1 | 1): Change[] {
  const d = c + dir;
  if (!colOk(m, c) || !colOk(m, d)) return [];
  const out: Change[] = [];
  for (const row of [m.header, m.delimiter, ...m.body]) {
    const real = realCells(row);
    const a = c < real.length ? real[c] : undefined;
    const b = d < real.length ? real[d] : undefined;
    const empty = row === m.delimiter ? '---' : '';
    const assign = new Map<number, string>();
    if (a && b) {
      assign.set(c, b.text);
      assign.set(d, a.text);
    } else if (a) {
      assign.set(c, empty);
      assign.set(d, a.text);
    } else if (b) {
      assign.set(d, empty);
      assign.set(c, b.text);
    }
    out.push(...rowEdits(row, assign, empty));
  }
  return normalize(out);
}

/**
 * `grid` 를 (r, c) 칸부터 채운다(r=0 머리 행, r=body.length+1 이면 표 바로 아래 새 행부터). 값은 앞뒤 공백을 떼고 escape 한다.
 * 열이 모자라면 머리 행과 구분 행에 열을 덧붙이고(다른 본문 행은 가상 셀로 남는다),
 * 행이 모자라면 표 끝에 새 행을 넣는다.
 */
export function pasteRect(m: TableModel, r: number, c: number, grid: string[][], br: string): Change[] {
  if (!grid.length || !Number.isInteger(r) || r < 0 || r > m.body.length + 1 || !colOk(m, c)) return [];
  const cols = Math.max(...grid.map((g) => g.length));
  if (cols === 0) return [];
  const width = Math.max(m.width, c + cols);
  const all = rows(m);
  const assigns = new Map<Row, Map<number, string>>();
  const assignFor = (row: Row) => {
    let a = assigns.get(row);
    if (!a) assigns.set(row, (a = new Map()));
    return a;
  };
  for (let k = m.width; k < width; k++) {
    assignFor(m.header).set(k, '');
    assignFor(m.delimiter).set(k, '---');
  }
  const newLines: string[] = [];
  grid.forEach((g, i) => {
    const rr = r + i;
    const values = g.map((v) => escapeCellText(v.trim()));
    if (rr < all.length) {
      const a = assignFor(all[rr]);
      values.forEach((v, j) => a.set(c + j, v));
    } else {
      const texts = Array.from({ length: width }, (_, k) => (k >= c && k - c < values.length ? values[k - c] : ''));
      newLines.push(serializeRow(texts));
    }
  });
  const out: Change[] = [];
  for (const [row, a] of assigns) out.push(...rowEdits(row, a, row === m.delimiter ? '---' : ''));
  if (newLines.length) {
    const last = m.body.length ? m.body[m.body.length - 1] : m.delimiter;
    out.push({ from: last.to, to: last.to, insert: br + newLines.join(br) });
  }
  return normalize(out);
}

/**
 * 문서 위치 pos 가 있는 셀 {r, c}. 구분 행이나 표 밖이면 null.
 * 실제 셀만 돌려준다: 짧은 행의 끝 위치는 가상 셀이 아니라 마지막 실제 셀로 간다.
 */
export function cellAt(m: TableModel, pos: number): { r: number; c: number } | null {
  const all = rows(m);
  for (let r = 0; r < all.length; r++) {
    const row = all[r];
    if (pos < row.from || pos > row.to) continue;
    const real = realCells(row);
    if (real.length === 0) return { r, c: 0 };
    for (let c = 0; c < real.length; c++) if (pos <= real[c].to) return { r, c };
    return { r, c: real.length - 1 };
  }
  return null;
}
