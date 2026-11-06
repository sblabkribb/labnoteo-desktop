import { ChangeSet, Text } from '@codemirror/state';
import { labnoteParser } from '../../markdownSyntax';
import {
  cellAt,
  deleteColumn,
  deleteRow,
  delimiterRow,
  escapeCellText,
  insertColumn,
  insertRow,
  moveColumn,
  moveRow,
  newTable,
  parseTable,
  rows,
  serializeRow,
  setAlign,
  setCell,
  type Align,
  type Change,
  type TableModel,
} from '../model';
import { pasteRect } from '../tsv';

// ---------------------------------------------------------------- 도우미

/** 변경을 문서에 적용한다. 범위가 겹치거나 맞닿으면(정규화 안 됨) 실패하고, CodeMirror 의 해석과도 맞춰 본다. */
function apply(doc: string, changes: Change[]): string {
  const sorted = [...changes].sort((a, b) => a.from - b.from);
  for (let i = 0; i < sorted.length; i++) {
    const c = sorted[i];
    expect(c.from).toBeGreaterThanOrEqual(0);
    expect(c.to).toBeGreaterThanOrEqual(c.from);
    expect(c.to).toBeLessThanOrEqual(doc.length);
    if (i > 0) {
      const p = sorted[i - 1];
      const touching = c.from === p.to && (c.from === c.to || p.from === p.to);
      expect(c.from >= p.to && !touching, `changes overlap: ${JSON.stringify(sorted)}`).toBe(true);
    }
  }
  let out = doc;
  for (const c of [...sorted].reverse()) out = out.slice(0, c.from) + c.insert + out.slice(c.to);
  // CodeMirror 도 같은 순서로 적용하는지. 삽입 글의 \r\n 은 CodeMirror 가 줄로 나누므로 LF 삽입만 맞춰 본다.
  if (!changes.some((c) => c.insert.includes('\r'))) {
    const viaCm = ChangeSet.of(changes, doc.length).apply(Text.of(doc.split('\n'))).toString();
    expect(viaCm).toBe(out);
  }
  return out;
}

/** `start` 에서 시작하는 표의 범위: 빈 줄이나 문서 끝 앞의 마지막 줄 끝(\r 제외)까지. */
function tableRange(doc: string, start: number): [number, number] {
  let pos = start;
  let end = start;
  while (pos <= doc.length) {
    let nl = doc.indexOf('\n', pos);
    if (nl < 0) nl = doc.length;
    const lineEnd = nl > pos && doc[nl - 1] === '\r' ? nl - 1 : nl;
    if (doc.slice(pos, lineEnd).trim() === '') break;
    end = lineEnd;
    pos = nl + 1;
  }
  return [start, end];
}

/** 표의 셀: 가상 셀은 null, 넘치는 셀은 앞에 '+'. */
function shape(m: TableModel): Array<Array<string | null>> {
  return rows(m).map((r) => r.cells.map((c) => (c.virtual ? null : c.overflow ? `+${c.text}` : c.text)));
}
/** 실제(가상이 아닌) 셀의 글자. */
const realTexts = (m: TableModel) => rows(m).map((r) => r.cells.filter((c) => !c.virtual).map((c) => c.text));

interface LezerTable {
  from: number;
  to: number;
  cells: string[][];
}
/** Lezer 가 본 첫 표: [from, to] 와 행마다 TableCell 글자. */
function lezerTable(doc: string): LezerTable | null {
  const tree = labnoteParser.parse(doc);
  const found: LezerTable[] = [];
  tree.iterate({
    enter: (n) => {
      if (n.name === 'Table') {
        if (found.length) return false;
        found.push({ from: n.from, to: n.to, cells: [] });
      }
      const t = found[0];
      if (!t) return undefined;
      if (n.name === 'TableHeader' || n.name === 'TableRow') t.cells.push([]);
      if (n.name === 'TableCell') t.cells[t.cells.length - 1].push(doc.slice(n.from, n.to));
      return undefined;
    },
  });
  return found[0] ?? null;
}

interface Entry {
  name: string;
  pre: string;
  table: string;
  post: string;
  br: string;
  lezer: boolean; // LF 문서만 Lezer 와 맞춰 본다(에디터는 LF 본문을 넘긴다)
  shape: Array<Array<string | null>>;
  align: Align[];
  warnings: string[];
}

const L = (name: string, table: string, shape: Entry['shape'], extra: Partial<Entry> = {}): Entry => ({
  name,
  pre: 'intro\n\n',
  table,
  post: '\n\nafter',
  br: '\n',
  lezer: true,
  shape,
  align: shape[0].map(() => null),
  warnings: [],
  ...extra,
});

const corpus: Entry[] = [
  L('basic', '| a | b |\n| --- | --- |\n| 1 | 2 |', [['a', 'b'], ['1', '2']]),
  L('empty cells', '| a |  |\n| --- | --- |\n|  | 2 |\n| | |', [['a', ''], ['', '2'], ['', '']]),
  L('double pipe', '| a | b |\n| --- | --- |\n|| x |', [['a', 'b'], ['', 'x']]),
  L('escaped pipes', '| a \\| b | c |\n| --- | --- |\n| x \\\\| y |', [['a \\| b', 'c'], ['x \\\\', 'y']]),
  L('code span pipe', '| a | b |\n| --- | --- |\n| `x | y` | z |', [['a', 'b'], ['`x', 'y`', '+z']], {
    warnings: ['code-span-pipe', 'overflow'],
  }),
  L('no outer pipes', 'a | b\n--- | ---\n1 | 2', [['a', 'b'], ['1', '2']]),
  L(
    'ragged',
    '| a | b | c |\n| --- | --- | --- |\n| 1 |\n| 1 | 2 | 3 | 4 |',
    [
      ['a', 'b', 'c'],
      ['1', null, null],
      ['1', '2', '3', '+4'],
    ],
    { warnings: ['overflow', 'ragged'] }
  ),
  L('header only', '| a | b |\n| --- | --- |', [['a', 'b']], { post: '' }),
  L('alignments', '| a | b | c | d |\n| :- | -: | :-: | --- |\n| 1 | 2 | 3 | 4 |', [['a', 'b', 'c', 'd'], ['1', '2', '3', '4']], {
    align: ['left', 'right', 'center', null],
  }),
  L('crlf', '| a | b |\r\n| --- | --- |\r\n| 1 | 2 |', [['a', 'b'], ['1', '2']], {
    pre: 'intro\r\n\r\n',
    post: '\r\n\r\nafter\r\n',
    br: '\r\n',
    lezer: false,
  }),
  L('mixed line endings', '| a | b |\r\n| --- | --- |\n| 1 | 2 |\r\n| 3 | 4 |', [['a', 'b'], ['1', '2'], ['3', '4']], {
    post: '\n',
    lezer: false,
  }),
  L('eof without newline', '| a | b |\n| --- | --- |\n| 1 | 2 |', [['a', 'b'], ['1', '2']], { pre: 'text\n\n', post: '' }),
  L('korean', '| 시료 | 농도 |\n| --- | --- |\n| 대장균 | 1 mM |\n| 효모 |  |', [['시료', '농도'], ['대장균', '1 mM'], ['효모', '']]),
  L('paragraph line after', '| a | b |\n| --- | --- |\n| 1 | 2 |\nplain', [['a', 'b'], ['1', '2'], ['plain', null]], {
    post: '',
    warnings: ['ragged'],
  }),
  L('single column', '| a |\n| --- |\n| 1 |', [['a'], ['1']], { pre: '' }),
];

const docOf = (e: Entry) => e.pre + e.table + e.post;
function modelOf(doc: string, start: number): TableModel {
  const [from, to] = tableRange(doc, start);
  const m = parseTable(doc, from, to);
  expect(m, `not a table -\n${doc}`).not.toBeNull();
  return m!;
}

// ---------------------------------------------------------------- 파싱

describe('parseTable corpus', () => {
  it.each(corpus.map((e) => [e.name, e] as const))('%s', (_n, e) => {
    const doc = docOf(e);
    const m = modelOf(doc, e.pre.length);
    expect(m.from).toBe(e.pre.length);
    expect(m.to).toBe(e.pre.length + e.table.length);
    expect(shape(m)).toEqual(e.shape);
    expect(m.align).toEqual(e.align);
    expect(m.width).toBe(e.shape[0].length);
    expect([...m.warnings].sort()).toEqual(e.warnings);
    // 셀 글자는 원문의 내용 범위 그대로다
    for (const r of rows(m)) for (const c of r.cells) expect(doc.slice(c.contentFrom, c.contentTo)).toBe(c.text);
  });

  it.each(corpus.filter((e) => e.lezer).map((e) => [e.name, e] as const))('matches Lezer: %s', (_n, e) => {
    const doc = docOf(e);
    const lz = lezerTable(doc);
    expect(lz).not.toBeNull();
    expect([lz!.from, lz!.to]).toEqual([e.pre.length, e.pre.length + e.table.length]);
    const m = modelOf(doc, e.pre.length);
    const ours = rows(m).map((r) => r.cells.filter((c) => !c.virtual && c.text !== '').map((c) => c.text));
    expect(ours).toEqual(lz!.cells);
  });

  it('gives exact offsets for rows and cells', () => {
    const doc = '| a |  | x|\n| --- | --- | --- |\n|| b |';
    const m = parseTable(doc, 0, doc.length)!;
    expect(m.header).toMatchObject({ from: 0, to: 11 });
    const [a, empty, x] = m.header.cells;
    expect(a).toMatchObject({ from: 1, to: 4, contentFrom: 2, contentTo: 3, text: 'a' });
    expect(empty).toMatchObject({ from: 5, to: 7, contentFrom: 6, contentTo: 6, text: '' }); // `| ` 바로 뒤
    expect(x).toMatchObject({ from: 8, to: 10, contentFrom: 9, contentTo: 10, text: 'x' });
    const body = m.body[0];
    expect(body.cells[0]).toMatchObject({ from: 33, to: 33, contentFrom: 33, contentTo: 33, text: '' }); // `||` 사이
    expect(body.cells[1]).toMatchObject({ text: 'b' });
    expect(body.cells[2]).toMatchObject({ virtual: true, from: 38, to: 38, text: '' }); // 행 끝
  });

  it('excludes the CR of CRLF from rows', () => {
    const doc = '| a |\r\n| --- |\r\n| 1 |\r\n';
    const m = parseTable(doc, 0, doc.length)!;
    expect(m.header).toMatchObject({ from: 0, to: 5 });
    expect(m.delimiter).toMatchObject({ from: 7, to: 14 });
    expect(m.body[0]).toMatchObject({ from: 16, to: 21 });
    expect(m.to).toBe(21);
  });

  it('skips a BOM before the header', () => {
    const doc = '﻿| a | b |\n| --- | --- |';
    expect(shape(parseTable(doc, 0, doc.length)!)).toEqual([['a', 'b']]);
  });

  it.each([
    ['no delimiter row', '| a | b |\n| 1 | 2 |'],
    ['a single line', '| a | b |'],
    ['a horizontal rule', 'a\n---'],
    ['header and delimiter widths differ', '| a | b |\n| --- |'],
  ])('returns null for %s', (_n, doc) => {
    expect(parseTable(doc, 0, doc.length)).toBeNull();
  });
});

// ---------------------------------------------------------------- 직렬화

describe('serialization', () => {
  it('serializes rows and delimiter rows canonically', () => {
    expect(serializeRow(['a', 'b'])).toBe('| a | b |');
    expect(serializeRow(['', ''])).toBe('|  |  |');
    expect(delimiterRow([null, 'left', 'center', 'right'])).toBe('| --- | :--- | :---: | ---: |');
  });

  it.each([
    ['a|b', 'a\\|b'],
    ['a\\|b', 'a\\|b'], // 이미 escape 된 파이프는 그대로
    ['a\\\\|b', 'a\\\\\\|b'], // `\\|` 의 파이프는 escape 되지 않은 것
    ['l1\nl2', 'l1<br>l2'],
    ['l1\r\nl2\rl3', 'l1<br>l2<br>l3'],
    ['시료 | A', '시료 \\| A'],
  ])('escapeCellText(%j) = %j', (s, want) => {
    expect(escapeCellText(s)).toBe(want);
  });

  it('builds a new table with the given line break', () => {
    expect(newTable(2, 2, '\n')).toBe('|  |  |\n| --- | --- |\n|  |  |\n|  |  |');
    expect(newTable(1, 2, '\r\n', ['시료', 'a|b'])).toBe('| 시료 | a\\|b |\r\n| --- | --- |\r\n|  |  |');
  });
});

// ---------------------------------------------------------------- 연산(정확한 출력)

const BASIC = '| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |';
const run = (doc: string, op: (m: TableModel) => Change[]) => apply(doc, op(parseTable(doc, 0, doc.length)!));

describe('setCell', () => {
  it('replaces only the content range', () => {
    const m = parseTable(BASIC, 0, BASIC.length)!;
    const ch = setCell(m, 1, 1, 'x');
    expect(ch).toEqual([{ from: 30, to: 31, insert: 'x' }]);
    expect(apply(BASIC, ch)).toBe('| a | b |\n| --- | --- |\n| 1 | x |\n| 3 | 4 |');
  });

  it('fills empty cells with canonical spacing', () => {
    expect(run('| a | b |\n| --- | --- |\n|  | 2 |', (m) => setCell(m, 1, 0, 'x'))).toBe('| a | b |\n| --- | --- |\n| x | 2 |');
    expect(run('| a | b |\n| --- | --- |\n| | 2 |', (m) => setCell(m, 1, 0, 'x'))).toBe('| a | b |\n| --- | --- |\n| x | 2 |');
    expect(run('| a | b |\n| --- | --- |\n|| 2 |', (m) => setCell(m, 1, 0, 'x'))).toBe('| a | b |\n| --- | --- |\n| x | 2 |');
  });

  it('fills virtual cells at the row end', () => {
    expect(run('| a | b | c |\n| --- | --- | --- |\n| 1 |', (m) => setCell(m, 1, 2, 'z'))).toBe(
      '| a | b | c |\n| --- | --- | --- |\n| 1 |  | z |'
    );
    expect(run('a | b\n--- | ---\n1', (m) => setCell(m, 1, 1, 'y'))).toBe('a | b\n--- | ---\n1 | y |');
  });

  it('clears a cell', () => {
    expect(run(BASIC, (m) => setCell(m, 0, 0, ''))).toBe('|  | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |');
  });

  it('keeps a cleared edge cell in a row without outer pipes', () => {
    const doc = 'a | b\n--- | ---\n1 | 2\nplain';
    expect(run(doc, (m) => setCell(m, 1, 0, ''))).toBe('a | b\n--- | ---\n|  | 2\nplain');
    expect(run(doc, (m) => setCell(m, 1, 1, ''))).toBe('a | b\n--- | ---\n1 | |\nplain');
    expect(run(doc, (m) => setCell(m, 2, 0, ''))).toBe('a | b\n--- | ---\n1 | 2\n|  |');
    expect(shape(parseTable('a | b\n--- | ---\n1 | |', 0, 21)!)).toEqual([['a', 'b'], ['1', '']]);
  });
});

describe('row operations', () => {
  it('inserts rows before, between and after', () => {
    expect(run(BASIC, (m) => insertRow(m, 0, '\n'))).toBe('| a | b |\n| --- | --- |\n|  |  |\n| 1 | 2 |\n| 3 | 4 |');
    expect(run(BASIC, (m) => insertRow(m, 1, '\n'))).toBe('| a | b |\n| --- | --- |\n| 1 | 2 |\n|  |  |\n| 3 | 4 |');
    expect(run(BASIC, (m) => insertRow(m, 2, '\n'))).toBe('| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n|  |  |');
    expect(run('| a |\r\n| --- |', (m) => insertRow(m, 0, '\r\n'))).toBe('| a |\r\n| --- |\r\n|  |');
    expect(run(BASIC, (m) => insertRow(m, 3, '\n'))).toBe(BASIC); // 범위 밖
  });

  it('deletes rows with their own line break', () => {
    expect(run(BASIC, (m) => deleteRow(m, 1, '\n'))).toBe('| a | b |\n| --- | --- |\n| 3 | 4 |');
    expect(run(BASIC, (m) => deleteRow(m, 2, '\n'))).toBe('| a | b |\n| --- | --- |\n| 1 | 2 |');
    const crlf = '| a |\r\n| --- |\r\n| 1 |\r\n| 2 |\r\nafter';
    expect(apply(crlf, deleteRow(parseTable(crlf, 0, 28)!, 2, '\r\n'))).toBe('| a |\r\n| --- |\r\n| 1 |\r\nafter');
    expect(deleteRow(parseTable(BASIC, 0, BASIC.length)!, 0, '\n')).toEqual([]); // 머리 행은 지울 수 없다
  });

  it('moves rows by swapping their lines', () => {
    expect(run(BASIC, (m) => moveRow(m, 1, 1, '\n'))).toBe('| a | b |\n| --- | --- |\n| 3 | 4 |\n| 1 | 2 |');
    expect(run(BASIC, (m) => moveRow(m, 2, -1, '\n'))).toBe('| a | b |\n| --- | --- |\n| 3 | 4 |\n| 1 | 2 |');
    const m = parseTable(BASIC, 0, BASIC.length)!;
    expect(moveRow(m, 1, -1, '\n')).toEqual([]);
    expect(moveRow(m, 2, 1, '\n')).toEqual([]);
    expect(moveRow(m, 0, 1, '\n')).toEqual([]);
  });
});

describe('column operations', () => {
  it('inserts columns', () => {
    expect(run(BASIC, (m) => insertColumn(m, 0))).toBe('|  | a | b |\n| --- | --- | --- |\n|  | 1 | 2 |\n|  | 3 | 4 |');
    expect(run(BASIC, (m) => insertColumn(m, 1))).toBe('| a |  | b |\n| --- | --- | --- |\n| 1 |  | 2 |\n| 3 |  | 4 |');
    expect(run(BASIC, (m) => insertColumn(m, 2))).toBe('| a | b |  |\n| --- | --- | --- |\n| 1 | 2 |  |\n| 3 | 4 |  |');
    expect(run('a | b\n--- | ---\n1 | 2', (m) => insertColumn(m, 0))).toBe('|  | a | b\n| --- | --- | ---\n|  | 1 | 2');
    expect(run('a | b\n--- | ---\n1 | 2', (m) => insertColumn(m, 2))).toBe('a | b |  |\n--- | --- | --- |\n1 | 2 |  |');
    // 짧은 행은 그대로 둔다(빈 칸은 가상 셀로 남는다)
    expect(run('| a | b |\n| --- | --- |\n| 1 |', (m) => insertColumn(m, 2))).toBe('| a | b |  |\n| --- | --- | --- |\n| 1 |');
  });

  it('deletes columns and refuses the last one', () => {
    expect(run(BASIC, (m) => deleteColumn(m, 0))).toBe('| b |\n| --- |\n| 2 |\n| 4 |');
    expect(run(BASIC, (m) => deleteColumn(m, 1))).toBe('| a |\n| --- |\n| 1 |\n| 3 |');
    expect(run('a | b\n--- | ---\n1 | 2', (m) => deleteColumn(m, 1))).toBe('a |\n--- |\n1 |');
    expect(run('a | b\n--- | ---\n1 | 2', (m) => deleteColumn(m, 0))).toBe('| b |\n| --- |\n| 2 |');
    expect(run('| a | b |\n| --- | --- |\nplain', (m) => deleteColumn(m, 0))).toBe('| b |\n| --- |\n|');
    expect(deleteColumn(parseTable('| a |\n| --- |', 0, 13)!, 0)).toEqual([]);
  });

  it('sets alignment in the delimiter row only', () => {
    const m = parseTable(BASIC, 0, BASIC.length)!;
    const ch = setAlign(m, 1, 'center');
    expect(ch.every((c) => c.from >= m.delimiter.from && c.to <= m.delimiter.to)).toBe(true);
    expect(apply(BASIC, ch)).toBe('| a | b |\n| --- | :---: |\n| 1 | 2 |\n| 3 | 4 |');
    expect(run(BASIC, (m2) => setAlign(m2, 0, 'right'))).toBe('| a | b |\n| ---: | --- |\n| 1 | 2 |\n| 3 | 4 |');
  });

  it('moves columns by swapping cell contents', () => {
    expect(run('| a | b |\n| :- | --- |\n| 1 | 2 |', (m) => moveColumn(m, 0, 1))).toBe('| b | a |\n| --- | :- |\n| 2 | 1 |');
    expect(run('| a | b |\n| --- | --- |\n| 1 |', (m) => moveColumn(m, 0, 1))).toBe('| b | a |\n| --- | --- |\n|  | 1 |');
    const m = parseTable(BASIC, 0, BASIC.length)!;
    expect(moveColumn(m, 0, -1)).toEqual([]);
    expect(moveColumn(m, 1, 1)).toEqual([]);
  });
});

describe('cellAt', () => {
  const m = parseTable(BASIC, 0, BASIC.length)!;
  it.each([
    [0, { r: 0, c: 0 }],
    [3, { r: 0, c: 0 }],
    [6, { r: 0, c: 1 }],
    [9, { r: 0, c: 1 }],
    [15, null], // 구분 행
    [29, { r: 1, c: 1 }],
    [BASIC.length, { r: 2, c: 1 }],
  ])('%i -> %j', (pos, want) => {
    expect(cellAt(m, pos)).toEqual(want);
  });
  it('returns null outside the table', () => {
    const doc = 'x\n' + BASIC;
    expect(cellAt(parseTable(doc, 2, doc.length)!, 0)).toBeNull();
  });
});

describe('pasteRect', () => {
  it('fills a rectangle, escapes values and grows rows and columns', () => {
    const out = run(BASIC, (m) => pasteRect(m, 2, 1, [['x', 'a|b'], [' 시료 ', 'l1\nl2']], '\n'));
    expect(out).toBe('| a | b |  |\n| --- | --- | --- |\n| 1 | 2 |\n| 3 | x | a\\|b |\n|  | 시료 | l1<br>l2 |');
  });

  it('pastes into the header row', () => {
    expect(run(BASIC, (m) => pasteRect(m, 0, 0, [['H1', 'H2']], '\n'))).toBe('| H1 | H2 |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |');
  });

  it('pastes below a table at EOF in a CRLF document', () => {
    expect(run('| a |\r\n| --- |', (m) => pasteRect(m, 1, 0, [['1'], ['2']], '\r\n'))).toBe('| a |\r\n| --- |\r\n| 1 |\r\n| 2 |');
  });
});

// ---------------------------------------------------------------- 기준 모델과 맞춰 보기

/** 실제 셀 글자만 가진 기준 모델. 연산의 기대 결과를 따로 계산한다. */
interface Ref {
  rows: string[][];
  align: Align[];
  width: number;
}
const refOf = (m: TableModel): Ref => ({ rows: realTexts(m), align: [...m.align], width: m.width });
const clone = (r: Ref): Ref => ({ rows: r.rows.map((x) => [...x]), align: [...r.align], width: r.width });
function setAt(row: string[], c: number, t: string) {
  while (row.length < c) row.push('');
  if (c < row.length) row[c] = t;
  else row.push(t);
}

type Op =
  | { k: 'setCell'; r: number; c: number; v: string }
  | { k: 'insertRow'; at: number }
  | { k: 'deleteRow'; r: number }
  | { k: 'insertColumn'; at: number }
  | { k: 'deleteColumn'; c: number }
  | { k: 'setAlign'; c: number; a: Align }
  | { k: 'moveRow'; r: number; dir: -1 | 1 }
  | { k: 'moveColumn'; c: number; dir: -1 | 1 }
  | { k: 'pasteRect'; r: number; c: number; grid: string[][] };

function runOp(m: TableModel, op: Op, br: string): Change[] {
  switch (op.k) {
    case 'setCell':
      return setCell(m, op.r, op.c, escapeCellText(op.v));
    case 'insertRow':
      return insertRow(m, op.at, br);
    case 'deleteRow':
      return deleteRow(m, op.r, br);
    case 'insertColumn':
      return insertColumn(m, op.at);
    case 'deleteColumn':
      return deleteColumn(m, op.c);
    case 'setAlign':
      return setAlign(m, op.c, op.a);
    case 'moveRow':
      return moveRow(m, op.r, op.dir, br);
    case 'moveColumn':
      return moveColumn(m, op.c, op.dir);
    case 'pasteRect':
      return pasteRect(m, op.r, op.c, op.grid, br);
  }
}

function refOp(ref0: Ref, op: Op): Ref {
  const ref = clone(ref0);
  const R = ref.rows;
  switch (op.k) {
    case 'setCell':
      setAt(R[op.r], op.c, escapeCellText(op.v));
      break;
    case 'insertRow':
      R.splice(op.at + 1, 0, Array(ref.width).fill(''));
      break;
    case 'deleteRow':
      if (op.r >= 1 && op.r < R.length) R.splice(op.r, 1);
      break;
    case 'insertColumn':
      for (const row of R) {
        if (op.at < row.length) row.splice(op.at, 0, '');
        else if (op.at === row.length && row.length >= ref.width) row.push('');
      }
      ref.align.splice(op.at, 0, null);
      ref.width++;
      break;
    case 'deleteColumn':
      if (ref.width === 1) break;
      for (const row of R) if (op.c < row.length) row.splice(op.c, 1);
      ref.align.splice(op.c, 1);
      ref.width--;
      break;
    case 'setAlign':
      ref.align[op.c] = op.a;
      break;
    case 'moveRow': {
      const t = op.r + op.dir;
      if (op.r < 1 || t < 1 || t >= R.length) break;
      [R[op.r], R[t]] = [R[t], R[op.r]];
      break;
    }
    case 'moveColumn': {
      const d = op.c + op.dir;
      if (d < 0 || d >= ref.width) break;
      for (const row of R) {
        const a = op.c < row.length ? row[op.c] : undefined;
        const b = d < row.length ? row[d] : undefined;
        if (a !== undefined && b !== undefined) [row[op.c], row[d]] = [b, a];
        else if (a !== undefined) {
          row[op.c] = '';
          setAt(row, d, a);
        } else if (b !== undefined) {
          row[d] = '';
          setAt(row, op.c, b);
        }
      }
      [ref.align[op.c], ref.align[d]] = [ref.align[d], ref.align[op.c]];
      break;
    }
    case 'pasteRect': {
      const cols = Math.max(...op.grid.map((g) => g.length));
      const width = Math.max(ref.width, op.c + cols);
      for (let k = ref.width; k < width; k++) setAt(R[0], k, '');
      op.grid.forEach((g, i) => {
        const rr = op.r + i;
        if (rr >= R.length) R.push(Array(width).fill(''));
        g.forEach((v, j) => setAt(R[rr], op.c + j, escapeCellText(v.trim())));
      });
      while (ref.align.length < width) ref.align.push(null);
      ref.width = width;
      break;
    }
  }
  return ref;
}

/** 연산 하나를 적용하고 기준 모델과 맞춰 본다. 새 문서와 기준 모델을 돌려준다. */
function step(e: Entry, doc: string, ref: Ref, op: Op): { doc: string; ref: Ref } {
  const m = modelOf(doc, e.pre.length);
  const next = apply(doc, runOp(m, op, e.br));
  const want = refOp(ref, op);
  const m2 = modelOf(next, e.pre.length);
  const ctx = `${e.name} ${JSON.stringify(op)}\n${doc}\n=>\n${next}`;
  expect(realTexts(m2), ctx).toEqual(want.rows);
  expect(m2.align, ctx).toEqual(want.align);
  expect(m2.width, ctx).toBe(want.width);
  expect(next.slice(0, e.pre.length), ctx).toBe(e.pre);
  expect(next.endsWith(e.post), ctx).toBe(true);
  if (e.lezer) {
    const lz = lezerTable(next);
    expect(lz && [lz.from, lz.to], ctx).toEqual([m2.from, m2.to]);
  }
  return { doc: next, ref: want };
}

describe('round-trip over the corpus', () => {
  const opsFor = (m: TableModel): Op[] => {
    const last = m.body.length;
    const ops: Op[] = [
      { k: 'setCell', r: 0, c: 0, v: '머리 | 글' },
      { k: 'setCell', r: last, c: m.width - 1, v: 'x\ny' },
      { k: 'insertRow', at: 0 },
      { k: 'insertRow', at: last },
      { k: 'insertColumn', at: 0 },
      { k: 'insertColumn', at: m.width },
      { k: 'deleteColumn', c: 0 },
      { k: 'deleteColumn', c: m.width - 1 },
      { k: 'setAlign', c: 0, a: 'center' },
      { k: 'moveColumn', c: 0, dir: 1 },
      { k: 'pasteRect', r: last, c: m.width - 1, grid: [['p', 'q'], ['r', 's']] },
    ];
    if (last >= 1) ops.push({ k: 'deleteRow', r: 1 }, { k: 'deleteRow', r: last });
    if (last >= 2) ops.push({ k: 'moveRow', r: 1, dir: 1 }, { k: 'moveRow', r: last, dir: -1 });
    return ops;
  };

  for (const e of corpus) {
    it(e.name, () => {
      const doc = docOf(e);
      const m = modelOf(doc, e.pre.length);
      for (const op of opsFor(m)) step(e, doc, refOf(m), op);
    });
  }

  it('keeps every other line byte-for-byte on cell and row edits', () => {
    for (const e of corpus) {
      const doc = docOf(e);
      const m = modelOf(doc, e.pre.length);
      const r = m.body.length;
      const target = r ? m.body[r - 1] : m.header;
      for (const ch of setCell(m, r, 0, 'zz')) {
        expect(ch.from >= target.from && ch.to <= target.to, e.name).toBe(true);
      }
      const lines = (d: string) => d.split(/\r?\n/);
      const before = lines(doc);
      const after = lines(apply(doc, insertRow(m, 0, e.br)));
      expect(after.length, e.name).toBe(before.length + 1);
      const at = before.indexOf(doc.slice(m.delimiter.from, m.delimiter.to)) + 1;
      expect([...after.slice(0, at), ...after.slice(at + 1)], e.name).toEqual(before);
    }
  });
});

describe('property: random operation sequences never lose cell text', () => {
  /** mulberry32: 시드를 고정한 의사 난수. */
  function prng(seed: number) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const POOL = ['x', '시료 A', 'a|b', '', '1 mM', '`c|d`', 'l1\nl2', '007', 'a\\|b', '**굵게**'];
  const ALIGNS: Align[] = ['left', 'center', 'right', null];

  it('holds for 200 seeded sequences', () => {
    const rnd = prng(20261106);
    const int = (n: number) => Math.floor(rnd() * n);
    const pick = <T,>(xs: readonly T[]) => xs[int(xs.length)];
    let steps = 0;
    for (let s = 0; s < 200; s++) {
      const e = corpus[s % corpus.length];
      let doc = docOf(e);
      let ref = refOf(modelOf(doc, e.pre.length));
      const n = 1 + int(8);
      for (let i = 0; i < n; i++) {
        const m = modelOf(doc, e.pre.length);
        const dir = pick([-1, 1] as const);
        const candidates: Op[] = [
          { k: 'setCell', r: int(m.body.length + 1), c: int(m.width), v: pick(POOL) },
          { k: 'insertRow', at: int(m.body.length + 1) },
          { k: 'insertColumn', at: int(m.width + 1) },
          { k: 'deleteColumn', c: int(m.width) },
          { k: 'setAlign', c: int(m.width), a: pick(ALIGNS) },
          { k: 'moveColumn', c: int(m.width), dir },
          {
            k: 'pasteRect',
            r: int(m.body.length + 1),
            c: int(m.width),
            grid: Array.from({ length: 1 + int(3) }, () => Array.from({ length: 1 + int(3) }, () => ` ${pick(POOL)} `)),
          },
        ];
        if (m.body.length) {
          candidates.push({ k: 'deleteRow', r: 1 + int(m.body.length) }, { k: 'moveRow', r: 1 + int(m.body.length), dir });
        }
        ({ doc, ref } = step(e, doc, ref, pick(candidates)));
        steps++;
      }
    }
    expect(steps).toBeGreaterThan(200);
  });
});
