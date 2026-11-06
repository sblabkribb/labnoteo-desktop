import { EditorState, Transaction, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { isolateHistory } from '@codemirror/commands';
import {
  delimiterRow,
  escapeCellText,
  deleteColumn,
  deleteRow,
  insertColumn,
  insertRow,
  moveColumn,
  moveRow,
  newTable,
  parseTable,
  rows,
  serializeRow,
  setAlign,
  type Change,
  type TableModel,
} from './model';
import { toTSV } from './tsv';
import { displayText } from './renderInline';
import { tableOpRunner, toggleRawTable, type TableAction } from './widget';
// field.ts 와 cellEditor.ts 도 이 파일을 (간접적으로) 가져온다. 순환이므로 그 값은 함수 안에서만 쓴다.
import { findTables, type TableSpan } from './field';
import { focusCell } from './cellEditor';
import { tableAwareInsertPos } from './target';

export type { TableAction };

/**
 * 표의 구조 연산(연구 문서 §4.4): 행·열 넣기와 지우기, 정렬, 옮기기, TSV 로 복사, 원문으로 편집, 표 지우기, 새 표 넣기.
 *
 * - 연산 하나는 바깥 문서의 트랜잭션 하나이고 `isolateHistory.of('full')` 를 달아 되돌리기 한 번으로 돌아간다.
 * - 변경은 model.ts 의 최소 변경이다: 건드리지 않는 셀은 원문 바이트 그대로다. 새 줄은 `state.lineBreak` 로 넣는다.
 * - 연산이 끝나면 알맞은 칸에 셀 편집기를 띄운다(새 행이면 그 행, 지운 행이면 그 자리의 행).
 */

export interface TableOp {
  action: TableAction;
  /** 기준 칸. r 은 0 이 머리 행, 1.. 이 본문 행. */
  r: number;
  c: number;
}

const isLocked = (state: EditorState) => state.readOnly || !state.facet(EditorView.editable);

interface Located {
  span: TableSpan;
  /** span.from 기준 위치의 모델. */
  m: TableModel;
}

/** `tableFrom` 에서 시작하는 맨 위 표(원문으로 보이는 표 포함). */
export function locateTable(state: EditorState, tableFrom: number): Located | null {
  const span = findTables(state).find((s) => s.from === tableFrom);
  if (!span) return null;
  // 위치는 CodeMirror 의 것(줄바꿈 한 칸): 줄 구분자와 상관없이 `\n` 으로 읽는다(field.ts 와 같다)
  const src = state.doc.sliceString(span.from, span.to);
  const m = parseTable(src, 0, src.length);
  return m ? { span, m } : null;
}

export const shiftChanges = (changes: Change[], base: number): Change[] =>
  changes.map((c) => ({ from: c.from + base, to: c.to + base, insert: c.insert }));

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.trunc(n)));

/** 셀 글자를 표 밖의 글자로: escape 한 파이프를 풀고 `<br>` 을 줄바꿈으로, 끝 백슬래시를 지키는 공백을 뗀다. */
function plainCell(text: string): string {
  return displayText(text)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/\\\|/g, '|');
}

/** 표를 Excel 이 읽는 TSV 로(머리 행 포함, 짧은 행의 빠진 칸은 빈 칸, 넘치는 칸도 버리지 않는다). */
export function tableToTSV(m: TableModel): string {
  return toTSV(rows(m).map((row) => row.cells.map((c) => plainCell(c.text))));
}

/** 클립보드에 글을 쓴다. 클립보드를 쓸 수 없으면(권한, 오래된 웹뷰) 조용히 넘어간다. */
function writeClipboard(view: EditorView, text: string): void {
  const clip = view.dom.ownerDocument.defaultView?.navigator.clipboard;
  if (!clip?.writeText) return;
  clip.writeText(text).catch(() => undefined);
}

/** 표와 그 뒤의 줄바꿈, 그리고 이어지는 빈 줄 하나를 지우는 범위. 문서 끝의 표면 앞쪽 줄바꿈과 빈 줄을 지운다. */
function tableRemoval(state: EditorState, span: TableSpan): { from: number; to: number } {
  const doc = state.doc;
  let from = span.from;
  let to = span.to;
  if (to < doc.length) {
    to += 1;
    const next = doc.lineAt(to);
    if (next.length === 0 && next.number < doc.lines) to = next.to + 1;
  } else if (from > 0) {
    const prev = doc.lineAt(from - 1);
    from -= 1;
    if (prev.length === 0 && prev.from > 0) from = prev.from - 1;
  }
  return { from, to };
}

/**
 * 표 연산 하나를 한다. 할 수 없으면(잠김, 표가 없음, 머리 행 지우기 같은 뜻 없는 연산) false.
 * 문서를 바꾸는 연산은 트랜잭션 하나(되돌리기 한 번)이고, 끝나면 알맞은 칸에 포커스를 준다.
 */
export function runTableOp(view: EditorView, tableFrom: number, op: TableOp): boolean {
  const state = view.state;
  const found = locateTable(state, tableFrom);
  if (!found) return false;
  const { m, span } = found;
  if (op.action === 'copyTSV') {
    writeClipboard(view, tableToTSV(m));
    return true;
  }
  if (isLocked(state)) return false;
  if (op.action === 'editAsMarkdown') {
    view.dispatch({ effects: toggleRawTable.of(span.from), selection: { anchor: span.from }, scrollIntoView: true });
    view.focus();
    return true;
  }
  const br = state.lineBreak;
  const last = m.body.length;
  const r = clamp(op.r, 0, last);
  const c = clamp(op.c, 0, m.width - 1);
  let changes: Change[];
  let focus: { r: number; c: number } | null = { r, c };
  switch (op.action) {
    case 'insertRowAbove':
      changes = insertRow(m, Math.max(0, r - 1), br);
      focus = { r: Math.max(1, r), c };
      break;
    case 'insertRowBelow':
      changes = insertRow(m, r, br);
      focus = { r: r + 1, c };
      break;
    case 'deleteRow':
      changes = deleteRow(m, r, br);
      focus = { r: Math.min(r, last - 1), c };
      break;
    case 'insertColumnLeft':
      changes = insertColumn(m, c);
      break;
    case 'insertColumnRight':
      changes = insertColumn(m, c + 1);
      focus = { r, c: c + 1 };
      break;
    case 'deleteColumn':
      changes = deleteColumn(m, c);
      focus = { r, c: Math.min(c, m.width - 2) };
      break;
    case 'alignLeft':
      changes = setAlign(m, c, 'left');
      break;
    case 'alignCenter':
      changes = setAlign(m, c, 'center');
      break;
    case 'alignRight':
      changes = setAlign(m, c, 'right');
      break;
    case 'moveRowUp':
      changes = moveRow(m, r, -1, br);
      focus = { r: r - 1, c };
      break;
    case 'moveRowDown':
      changes = moveRow(m, r, 1, br);
      focus = { r: r + 1, c };
      break;
    case 'moveColumnLeft':
      changes = moveColumn(m, c, -1);
      focus = { r, c: c - 1 };
      break;
    case 'moveColumnRight':
      changes = moveColumn(m, c, 1);
      focus = { r, c: c + 1 };
      break;
    case 'deleteTable': {
      const range = tableRemoval(state, span);
      changes = [{ ...range, insert: '' }];
      focus = null;
      break;
    }
    default:
      return false;
  }
  if (!changes.length) return false;
  const shifted = op.action === 'deleteTable' ? changes : shiftChanges(changes, span.from);
  const tr = state.update({
    changes: shifted,
    selection: focus ? undefined : { anchor: shifted[0].from },
    annotations: [isolateHistory.of('full'), Transaction.userEvent.of('input')],
    scrollIntoView: true,
  });
  view.dispatch(tr);
  if (!focus) {
    view.focus();
    return true;
  }
  // 표의 시작 앞에 들어간 글자(바깥 파이프 없는 첫 칸 앞의 `| `)는 표의 것이다: 시작은 왼쪽에 붙어 그대로다
  focusCell(view, tr.changes.mapPos(span.from, -1), focus.r, focus.c, 'end');
  return true;
}

// ---------------------------------------------------------------- 새 표

/** 블록 앞에 둘 줄바꿈: 줄 가운데면 둘, 줄 시작이면 앞 줄이 빈 줄이 아닐 때 하나. */
function gapBefore(state: EditorState, from: number): string {
  const doc = state.doc;
  const br = state.lineBreak;
  const head = doc.lineAt(from);
  if (from > head.from) return br + br;
  return head.number > 1 && doc.line(head.number - 1).length > 0 ? br : '';
}

/**
 * `block`(여러 줄 글)을 [from, to) 에 따로 선 블록으로 넣는 변경: 앞뒤 글과는 빈 줄 하나로 떨어진다.
 * 이미 빈 줄이 있으면 더하지 않는다. `start` 는 새 문서에서 블록이 시작하는 위치.
 */
export function placeBlock(state: EditorState, from: number, to: number, block: string): { change: Change; start: number } {
  const doc = state.doc;
  const br = state.lineBreak;
  const tail = doc.lineAt(to);
  const before = gapBefore(state, from);
  let after = '';
  if (to < tail.to) after = br + br;
  else if (tail.number < doc.lines && doc.line(tail.number + 1).length > 0) after = br;
  // CodeMirror 의 위치는 줄바꿈(CRLF 도)을 한 칸으로 센다
  return { change: { from, to, insert: before + block + after }, start: from + state.toText(before).length };
}

/**
 * 표의 원문 `block` 을 [from, to) 에 따로 선 블록으로 넣는 변경. 앞 글과는 `placeBlock` 처럼 빈 줄 하나로 떨어진다.
 * 뒤에는 언제나 빈 줄 하나와 빈 문단 줄 하나가 온다: 표 바로 아래 줄(이나 표 끝)에 친 글은 GFM 이 표의 행으로 읽으므로,
 * 표에서 나온 커서가 설 줄이 있어야 한다(셀 편집기의 `exitBelow` 와 같은 규칙). 뒤에 글이 이어지면 빈 문단 줄 바로 다음 줄이다.
 * 이미 있는 빈 줄은 다시 쓴다. `start` 는 새 문서에서 표가 시작하는 위치, `after` 는 그 빈 문단 줄의 시작.
 */
export function placeTable(state: EditorState, from: number, to: number, block: string): { change: Change; start: number; after: number } {
  const doc = state.doc;
  const br = state.lineBreak;
  const before = gapBefore(state, from);
  const tail = doc.lineAt(to);
  // 표 끝과 다음 글(이나 문서 끝) 사이에 줄바꿈 셋(표 끝, 빈 줄, 빈 문단 줄)이 있어야 한다.
  // 줄 끝에 넣으면 그 줄의 줄바꿈과 뒤따르는 빈 줄마다 하나씩 이미 있다(문서 끝이면 마지막 줄의 것은 없지만 하나 덜 필요하다).
  let after = br + br + br;
  if (to === tail.to) {
    let blank = 0;
    for (let n = tail.number + 1; n <= doc.lines && blank < 2 && doc.line(n).length === 0; n++) blank++;
    after = br.repeat(2 - blank);
  }
  const start = from + state.toText(before).length;
  return { change: { from, to, insert: before + block + after }, start, after: start + state.toText(block).length + 2 };
}

/**
 * 커서가 있는 줄 다음에 빈 표(머리 행 포함 `rows` 행, `cols` 열)를 따로 선 블록으로 넣고 첫 머리 칸에 포커스를 준다.
 * 커서가 빈 줄에 있으면 그 줄에 넣는다. 커서가 표 안이면 표 아래에 넣는다(`tableAwareInsertPos`). 되돌리기 한 번. 잠겨 있으면 false.
 */
export function insertTable(view: EditorView, rowCount = 3, cols = 3): boolean {
  const state = view.state;
  if (isLocked(state)) return false;
  // 칸에 포커스가 있으면(바깥 커서가 표 안이면) 표를 가르지 않고 표 아래에 넣는다
  const line = state.doc.lineAt(tableAwareInsertPos(state, state.selection.main.head));
  const table = newTable(Math.max(0, rowCount - 1), cols, state.lineBreak);
  const { change, start } = placeTable(state, line.to, line.to, table);
  view.dispatch({
    changes: change,
    selection: { anchor: start },
    annotations: [isolateHistory.of('full'), Transaction.userEvent.of('input')],
    scrollIntoView: true,
  });
  if (!focusCell(view, start, 0, 0, 'start')) view.focus();
  return true;
}

/** 칸 글자 격자로 새 표의 원문을 만든다: 첫 행이 머리 행, 짧은 행은 빈 칸으로 채운다. 값은 앞뒤 공백을 떼고 escape 한다. */
export function tableFromGrid(grid: string[][], br: string): string {
  const width = Math.max(1, ...grid.map((g) => g.length));
  const line = (g: string[]) => serializeRow(Array.from({ length: width }, (_, i) => escapeCellText((g[i] ?? '').trim())));
  const [header, ...body] = grid;
  return [line(header ?? []), delimiterRow(Array.from({ length: width }, () => null)), ...body.map(line)].join(br);
}

/** tableExtension 이 싣는 연산 부분: 위젯의 단추가 부른다. */
export function tableCommandsExtension(): Extension {
  return tableOpRunner.of((view, tableFrom, op) => runTableOp(view, tableFrom, op));
}
