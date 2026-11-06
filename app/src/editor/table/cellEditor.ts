import {
  Annotation,
  Compartment,
  EditorState,
  Facet,
  MapMode,
  Prec,
  StateEffect,
  StateField,
  Transaction,
  type ChangeSpec,
  type Text,
  type Extension,
  type TransactionSpec,
} from '@codemirror/state';
import { EditorView, ViewPlugin, keymap, type KeyBinding, type ViewUpdate } from '@codemirror/view';
import { isolateHistory, redo, undo } from '@codemirror/commands';
import { t } from '../../i18n/t';
import { markdownHighlighting } from '../theme';
import { labnoteMarkdown } from '../markdownSyntax';
import { cellAt, escapeCellText, insertRow, parseTable, rows, setCell, type Change, type TableModel } from './model';
import { displayText } from './renderInline';
import { activeCells, cellActivator, openTableMenu, paintCell, tableOf, type CellHandle } from './widget';
// field.ts 도 이 파일을 가져온다(tableExtension). 순환이므로 이 파일의 맨 위 코드는 field 의 값을 쓰지 않는다: 함수 안에서만 쓴다.
import { findTables, tableField, tableOptions, type TableSpan } from './field';

/**
 * 표 칸 안의 셀 편집기(연구 문서 §4.4 의 A 안).
 *
 * - 바깥 편집기마다 셀 편집기는 많아야 하나다. 칸을 누르거나 키보드로 들어오면 그 칸(td)에 중첩 EditorView 를 띄운다.
 *   셀 편집기의 문서는 그 칸의 원문 마크다운(escape 한 파이프와 `<br>` 이 적힌 그대로)이다.
 * - 셀 편집기의 입력은 트랜잭션마다 곧바로 바깥 문서로 간다(`setCell`, 바뀐 글자만 남긴 최소 변경). 원래의 userEvent 와
 *   `cellEdit` 표지를 달고, 바깥 선택을 칸 안의 같은 자리에 둔다. 그래서 자동 저장·저장 안 됨 표시·충돌 처리·되돌리기가
 *   바깥 문서 하나로 그대로 돈다. Mod-s 와 닫기 전 flush 는 언제나 마지막 글자까지 본다.
 * - 셀 편집기에는 기록(history)이 없다. Mod-z / Mod-y / Mod-Shift-z 는 바깥 편집기를 되돌린다.
 * - 밖에서 그 칸이 바뀌면(되돌리기, 다시 읽기, 다른 쓰기) 칸을 다시 찾아 셀 편집기의 글자를 바꾸고(메아리 막음 표지),
 *   칸이 없어졌으면 셀 편집기를 걷는다. 상태를 통째로 바꾸면(setState) 플러그인과 함께 걷힌다.
 * - 셀 편집기가 든 칸은 위젯이 다시 그리지 않는다: 자기 입력으로 표가 다시 그려져도 같은 DOM, 같은 편집기다(한글 조합).
 */

export interface ActiveCell {
  /** 표의 첫 줄 시작 위치. */
  tableFrom: number;
  /** 0 이 머리 행, 1.. 이 본문 행. */
  r: number;
  c: number;
}

/** 셀 편집기에서 온 바깥 트랜잭션의 표지. 값은 `${tableFrom}:${r}:${c}`. */
export const cellEdit = Annotation.define<string>();
/** 바깥에서 셀 편집기로 보낸 트랜잭션의 표지(다시 바깥으로 보내지 않는다). */
const fromOuter = Annotation.define<boolean>();
export const setActiveCell = StateEffect.define<ActiveCell | null>();

const LOCKED = [EditorState.readOnly.of(true), EditorView.editable.of(false)];
const isLocked = (state: EditorState) => state.readOnly || !state.facet(EditorView.editable);
/** 빈 줄: 공백뿐인 줄도 빈 줄로 본다(GFM 도 그렇게 읽는다). */
const isBlank = (text: string) => text.trim() === '';

/**
 * 표의 마지막 줄(줄 번호 `last`) 끝에 더 넣어야 할 줄바꿈 수. 넣은 뒤 커서가 설 줄은 표 끝에서 두 줄 아래다.
 * 표 바로 아래 줄에 친 글은 GFM 이 표의 행으로 읽고, 문단 바로 위 줄에 친 글은 그 문단과 이어진다. 그래서 커서 줄 위에는
 * 언제나 빈 줄 하나, 뒤에 글이 이어지면 아래에도 빈 줄 하나가 있어야 한다: 표, 빈 줄, 커서, 빈 줄, 문단.
 * 이미 있는 빈 줄(공백뿐인 줄 포함)은 다시 쓴다. 0 이면 문서를 바꾸지 않고 `last + 2` 번째 줄에 커서를 둔다.
 */
export function missingBelowTable(doc: Text, last: number): number {
  let blank = 0;
  while (last + blank < doc.lines && isBlank(doc.line(last + 1 + blank).text)) blank++;
  const textFollows = last + blank < doc.lines;
  return Math.max(0, (textFollows ? 3 : 2) - blank);
}

// ---------------------------------------------------------------- 표 찾기

interface Located {
  span: TableSpan;
  /** span.from 기준 위치의 모델. */
  m: TableModel;
}

/** `tableFrom` 에서 시작하는 맨 위 표. */
function tableAt(state: EditorState, tableFrom: number): Located | null {
  const span = findTables(state).find((s) => s.from === tableFrom);
  return span ? locate(state, span) : null;
}

function locate(state: EditorState, span: TableSpan): Located | null {
  // 위치는 CodeMirror 의 것(줄바꿈 한 칸): 줄 구분자와 상관없이 `\n` 으로 읽는다(field.ts 와 같다)
  const src = state.doc.sliceString(span.from, span.to);
  const m = parseTable(src, 0, src.length);
  return m ? { span, m } : null;
}

/** 격자로 그려진 표들(원문으로 보이는 표는 빠진다). */
function renderedTables(state: EditorState): TableSpan[] {
  const out: TableSpan[] = [];
  const deco = state.field(tableField, false);
  if (!deco) return out;
  for (let it = deco.iter(); it.value; it.next()) out.push({ from: it.from, to: it.to });
  return out;
}

const shift = (changes: Change[], base: number): Change[] => changes.map((c) => ({ from: c.from + base, to: c.to + base, insert: c.insert }));

/** 앞뒤의 같은 글자를 떼어 실제로 바뀐 부분만 남긴다. */
function diff(from: number, before: string, after: string): Change {
  let p = 0;
  while (p < before.length && p < after.length && before[p] === after[p]) p++;
  let s = 0;
  while (s < before.length - p && s < after.length - p && before[before.length - 1 - s] === after[after.length - 1 - s]) s++;
  return { from: from + p, to: from + before.length - s, insert: after.slice(p, after.length - s) };
}

/** GFM 이 셀에서 떼는 공백(스페이스와 탭)만 뗀다. */
const trimBlank = (s: string) => s.replace(/^[ \t]+|[ \t]+$/g, '');
const leadingBlank = (s: string) => s.length - s.replace(/^[ \t]+/, '').length;

// ---------------------------------------------------------------- 활성 칸

/** 밖의 변경 뒤에 같은 칸을 다시 찾는다. 그 행이 지워졌거나 표가 없어졌으면 null. */
function remap(ac: ActiveCell, tr: Transaction): ActiveCell | null {
  const old = tableAt(tr.startState, ac.tableFrom);
  const row = old && rows(old.m)[ac.r];
  const cell = row?.cells[ac.c];
  if (!old || !row || !cell) return null;
  const base = old.span.from;
  const ch = tr.changes;
  // 행의 어느 한쪽 끝이 지운 범위 안쪽에 있으면 그 행이 지워졌다(가운데 행은 끝이, 마지막 행은 시작이 안쪽이다)
  if (ch.mapPos(base + row.from, 1, MapMode.TrackDel) === null || ch.mapPos(base + row.to, -1, MapMode.TrackDel) === null) return null;
  const p = ch.mapPos(base + cell.contentFrom, 1);
  const span = findTables(tr.state).find((s) => s.from <= p && p <= s.to);
  const now = span && locate(tr.state, span);
  if (!now) return null;
  const at = cellAt(now.m, p - now.span.from);
  if (!at) return null;
  // 가상 셀의 자리는 행 끝이라 cellAt 은 마지막 실제 셀을 준다: 열은 그대로 둔다
  const c = cell.virtual ? ac.c : at.c;
  if (now.span.from === ac.tableFrom && at.r === ac.r && c === ac.c) return ac;
  return { tableFrom: now.span.from, r: at.r, c };
}

/** 셀 편집기가 든 칸. 셀 편집기를 띄우고 걷는 쪽(이 파일)만 바꾼다. */
export const activeCell = StateField.define<ActiveCell | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setActiveCell)) value = e.value;
    if (!value || !tr.docChanged || tr.effects.some((e) => e.is(setActiveCell))) return value;
    if (tr.annotation(cellEdit) !== undefined) {
      // 그 칸 안의 변경: 표의 시작만 따라간다(파이프 없는 첫 칸에 `| ` 가 붙어도 표는 같은 자리에서 시작한다)
      const tableFrom = tr.changes.mapPos(value.tableFrom, -1);
      return tableFrom === value.tableFrom ? value : { ...value, tableFrom };
    }
    return remap(value, tr);
  },
});

// ---------------------------------------------------------------- 셀 편집기

const sessions = new WeakMap<EditorView, Session>();
/** 셀 편집기 → 그 칸이 든 바깥 편집기. */
const outers = new WeakMap<EditorView, EditorView>();
let live = 0;

/** 셀 편집기의 바깥 편집기. 셀 편집기가 아니거나 이미 걷혔으면 null. */
export function outerOf(nested: EditorView): EditorView | null {
  const outer = outers.get(nested);
  return outer && sessions.get(outer)?.nested === nested ? outer : null;
}

/**
 * 셀 편집기에 더 싣는 확장(붙여 넣기 등, paste.ts). 바깥 편집기의 상태에서 읽어 셀 편집기를 띄울 때 싣는다.
 * 이 파일이 그 모듈을 가져오지 않아도 되게 facet 으로 잇는다.
 */
export const cellExtras = Facet.define<Extension>();

/** 셀 편집기에서도 듣는 바깥 편집기의 명령 키. `run` 은 바깥 편집기를 받는다. */
export interface OuterKey {
  key: string;
  run: (outer: EditorView) => boolean;
}

/**
 * 셀 편집기에서 바깥 편집기로 넘기는 키(표 넣기 Mod-Alt-t 등, commands.ts). 셀 편집기의 키 사건은 바깥 편집기의 keymap 에
 * 닿지 않으므로 여기 실은 키만 셀 안에서도 듣는다. 이 파일이 그 모듈을 가져오지 않아도 되게(순환) facet 으로 잇는다.
 */
export const cellOuterKeys = Facet.define<OuterKey>();

/** 지금 살아 있는 셀 편집기 수(테스트가 새는지 본다). */
export const liveCellEditors = () => live;

/** 이 편집기의 칸 안에 떠 있는 셀 편집기. */
export function activeCellView(view: EditorView): EditorView | null {
  return sessions.get(view)?.nested ?? null;
}

/** 셀 편집기에 들어오는 글자를 칸에 맞게 바꾼다: escape 안 된 파이프는 앞에 백슬래시를 붙이고, 줄바꿈은 `<br>` 로. */
const escapeFilter = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || tr.annotation(fromOuter)) return tr;
  const next = tr.newDoc.toString();
  const fixed = escapeCellText(next);
  if (fixed === next) return tr;
  const userEvent = tr.annotation(Transaction.userEvent);
  const first: TransactionSpec = {
    changes: tr.changes,
    selection: tr.selection,
    effects: tr.effects,
    scrollIntoView: tr.scrollIntoView,
    annotations: userEvent ? Transaction.userEvent.of(userEvent) : [],
  };
  // 두 번째 변경은 첫 변경 뒤의 문서 기준이다. 커서는 그 변경을 따라 옮겨진다.
  return [first, { changes: diff(0, next, fixed), sequential: true }];
});

/** 잠긴 셀 편집기에는 바깥에서 보낸 것 말고는 아무 변경도 들어가지 않는다. */
const lockFilter = EditorState.changeFilter.of((tr) => !!tr.annotation(fromOuter) || !tr.startState.readOnly);

/**
 * 셀 편집기를 띄울 때의 선택. 'all' 은 칸 글자 전체를 고른다: Tab·Shift-Tab·Enter 와 바깥에서 키보드로 들어올 때
 * (스프레드시트처럼 이어 친 글자가 내용을 바꾼다). 칸 경계의 화살표는 'start'·'end', 마우스는 누른 자리(숫자)다.
 */
type Place = 'start' | 'end' | 'all' | number;

/** 칸 글자 `text` 에서 `place` 의 선택(anchor, head). */
function placeRange(place: Place, text: string): { anchor: number; head: number } {
  if (place === 'all') return { anchor: 0, head: text.length };
  const head = place === 'start' ? 0 : place === 'end' ? text.length : Math.max(0, Math.min(place, text.length));
  return { anchor: head, head };
}

class Session implements CellHandle {
  dead = false;
  readonly nested: EditorView;
  private readonly lock = new Compartment();

  constructor(
    readonly outer: EditorView,
    public td: HTMLElement,
    text: string,
    place: Place,
  ) {
    const opts = outer.state.facet(tableOptions);
    td.replaceChildren();
    td.classList.add('lno-cell-active');
    activeCells.set(td, this);
    sessions.set(outer, this);
    live++;
    this.nested = new EditorView({
      parent: td,
      root: opts?.root,
      state: EditorState.create({
        doc: text,
        selection: placeRange(place, text),
        extensions: [
          labnoteMarkdown(),
          markdownHighlighting,
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ 'aria-label': t('table.cellEditor') }),
          this.lock.of(isLocked(outer.state) ? LOCKED : []),
          lockFilter,
          escapeFilter,
          Prec.highest(keymap.of(this.keys())),
          outer.state.facet(cellExtras),
          EditorView.updateListener.of((u) => u.geometryChanged && this.outer.requestMeasure()),
        ],
      }),
      dispatchTransactions: (trs, v) => {
        if (this.dead) return;
        v.update(trs);
        const local = trs.filter((tr) => tr.docChanged && !tr.annotation(fromOuter));
        if (local.length) this.forward(local[local.length - 1].annotation(Transaction.userEvent), local[0].startState.doc.toString());
      },
    });
    outers.set(this.nested, outer);
    // 바깥 편집기나 다른 컨트롤로 포커스가 옮겨 가면 걷는다. 창 밖으로 나간 것(relatedTarget 없음)은 그대로 둔다.
    this.nested.contentDOM.addEventListener('focusout', (e) => {
      const to = e.relatedTarget as Node | null;
      if (this.dead || !to || this.td.contains(to)) return;
      this.close();
    });
  }

  private get cell(): ActiveCell | null {
    return this.outer.state.field(activeCell, false) ?? null;
  }

  // ---------------------------------------------------------------- 바깥으로

  /**
   * 셀 편집기의 글자를 바깥 칸에 쓴다. 앞뒤 공백은 GFM 이 버리므로 쓰지 않는다(친 공백은 셀 편집기에 남는다).
   * 쓰지 못하면 셀 편집기가 문서에 없는 글자를 보이지 않게 한다: 칸이 있으면 문서의 칸 글자로 되돌리고(pull),
   * 표나 칸을 찾지 못하면 이번 입력 전의 글자(`before`, 마지막으로 문서와 맞춘 글자)로 되돌려 걷는다.
   */
  private forward(userEvent: string | undefined, before: string): void {
    const ac = this.cell;
    const found = ac && tableAt(this.outer.state, ac.tableFrom);
    const cell = found && rows(found.m)[ac.r]?.cells[ac.c];
    if (!ac || !found || !cell) {
      const now = this.nested.state.doc;
      if (now.toString() !== before) this.nested.dispatch({ changes: { from: 0, to: now.length, insert: before }, annotations: fromOuter.of(true) });
      return this.close({ refocus: true });
    }
    if (isLocked(this.outer.state)) return this.pull();
    const raw = this.nested.state.doc.toString();
    const text = trimBlank(raw);
    if (text === displayText(cell.text)) return;
    const changes = shift(setCell(found.m, ac.r, ac.c, text), found.span.from);
    if (changes.length !== 1) return this.pull();
    const [ch] = changes;
    // 칸 글자가 새 문서에서 시작하는 자리. 덧붙는 것은 공백과 파이프뿐이라 글자를 그대로 찾을 수 있다.
    const start = text ? ch.from + ch.insert.indexOf(text) : ch.from;
    const offset = Math.max(0, Math.min(this.nested.state.selection.main.head - leadingBlank(raw), text.length));
    const annotations = [cellEdit.of(`${ac.tableFrom}:${ac.r}:${ac.c}`)];
    if (userEvent) annotations.push(Transaction.userEvent.of(userEvent));
    this.outer.dispatch({
      changes: diff(ch.from, this.outer.state.doc.sliceString(ch.from, ch.to), ch.insert),
      selection: { anchor: start + offset },
      annotations,
    });
  }

  // ---------------------------------------------------------------- 바깥에서

  /** 바깥의 칸 글자로 셀 편집기를 맞춘다(같으면 그대로). 커서는 바깥 커서가 칸 안이면 그 자리, 아니면 끝. */
  pull(): void {
    const ac = this.cell;
    const found = ac && tableAt(this.outer.state, ac.tableFrom);
    const cell = found && rows(found.m)[ac.r]?.cells[ac.c];
    if (!ac || !found || !cell) return this.close({ refocus: true, clear: false });
    const text = displayText(cell.text);
    const current = this.nested.state.doc.toString();
    if (trimBlank(current) === text) return;
    const start = found.span.from + cell.contentFrom;
    const head = this.outer.state.selection.main.head - start;
    this.nested.dispatch({
      changes: { from: 0, to: current.length, insert: text },
      selection: { anchor: head >= 0 && head <= text.length ? head : text.length },
      annotations: fromOuter.of(true),
    });
  }

  /** 바깥 편집기의 갱신(셀 편집기에서 온 것이 아닌 것)에 따라간다. 바깥이 갱신하는 도중이므로 바깥에 dispatch 하지 않는다. */
  outerUpdate(u: ViewUpdate): void {
    const locked = isLocked(u.state);
    if (locked !== isLocked(u.startState)) {
      this.nested.dispatch({ effects: this.lock.reconfigure(locked ? LOCKED : []), annotations: fromOuter.of(true) });
    }
    const undoing = u.transactions.some((tr) => tr.isUserEvent('undo') || tr.isUserEvent('redo'));
    if (!u.state.field(activeCell, false)) this.close({ refocus: !undoing, clear: false });
    else if (u.transactions.some((tr) => tr.docChanged && tr.annotation(cellEdit) === undefined)) this.pull();
    if (undoing) this.followSelection(u.state);
  }

  /** 되돌린 뒤 바깥 커서가 다른 칸에 있으면 그 칸으로, 표 밖이면 바깥 편집기로 간다. */
  private followSelection(state: EditorState): void {
    const head = state.selection.main.head;
    const span = renderedTables(state).find((s) => s.from <= head && head <= s.to);
    const found = span && locate(state, span);
    const at = found && cellAt(found.m, head - found.span.from);
    const ac = state.field(activeCell, false);
    if (!this.dead && ac && found && at && ac.tableFrom === found.span.from && ac.r === at.r && ac.c === at.c) return;
    const outer = this.outer;
    queueMicrotask(() => {
      if (found && at) {
        const cell = rows(found.m)[at.r].cells[at.c];
        focusCell(outer, found.span.from, at.r, at.c, head - found.span.from - cell.contentFrom);
      } else if (!this.dead) this.leave(head);
    });
  }

  // ---------------------------------------------------------------- 위젯이 부른다

  relocate(table: HTMLTableElement): void {
    const ac = this.cell;
    const target = ac && (table.rows[ac.r]?.cells[ac.c] as HTMLElement | undefined);
    if (!target) return this.close({ refocus: true, clear: false, repaint: false });
    if (target === this.td) return;
    const focused = this.nested.hasFocus;
    const old = this.td;
    activeCells.delete(old);
    old.classList.remove('lno-cell-active');
    old.replaceChildren(); // 위젯이 곧 모델 글자로 다시 그린다(그린 표시가 없다)
    paintCell(old, '');
    this.td = target;
    target.replaceChildren(this.nested.dom);
    target.classList.add('lno-cell-active');
    activeCells.set(target, this);
    if (focused) queueMicrotask(() => !this.dead && this.nested.focus());
  }

  release(): void {
    this.close({ refocus: true, clear: false, repaint: false });
  }

  // ---------------------------------------------------------------- 걷기

  /**
   * 셀 편집기를 걷는다. `clear` 면 활성 칸을 비운다(바깥이 갱신하는 도중이 아닐 때만 곧바로, 아니면 다음 마이크로태스크에).
   * `refocus` 면 셀 편집기에 포커스가 있었을 때 바깥 편집기로 포커스를 돌려준다.
   */
  close(o: { refocus?: boolean; clear?: boolean; repaint?: boolean } = {}): void {
    if (this.dead) return;
    const { refocus = false, clear = true, repaint = true } = o;
    const focused = this.nested.hasFocus;
    const text = this.nested.state.doc.toString();
    const ac = this.cell;
    this.dead = true;
    live--;
    if (sessions.get(this.outer) === this) sessions.delete(this.outer);
    activeCells.delete(this.td);
    this.td.classList.remove('lno-cell-active');
    this.nested.destroy();
    if (repaint && this.td.isConnected) paintCell(this.td, text);
    const outer = this.outer;
    if (clear || (refocus && focused)) {
      queueMicrotask(() => {
        if (clear && ac && outer.state.field(activeCell, false) === ac) outer.dispatch({ effects: setActiveCell.of(null) });
        if (refocus && focused && !sessions.get(outer)) outer.focus();
      });
    }
  }

  /** 걷고 바깥 편집기의 `pos` 로 간다. */
  leave(pos: number, changes?: ChangeSpec): void {
    const outer = this.outer;
    this.close({ clear: false });
    outer.dispatch({
      changes,
      selection: { anchor: pos },
      effects: setActiveCell.of(null),
      annotations: changes ? [isolateHistory.of('full'), Transaction.userEvent.of('input')] : [],
      scrollIntoView: true,
    });
    outer.focus();
  }

  // ---------------------------------------------------------------- 키

  private located(): (Located & { ac: ActiveCell }) | null {
    const ac = this.cell;
    const found = ac && tableAt(this.outer.state, ac.tableFrom);
    return ac && found ? { ...found, ac } : null;
  }

  private go(r: number, c: number, place: Place): boolean {
    const ac = this.cell;
    if (ac) focusCell(this.outer, ac.tableFrom, r, c, place);
    return true;
  }

  /** 표 끝에 행을 하나 더하고(되돌리기 한 번) 그 행의 c 칸으로 간다. */
  private addRow(c: number): boolean {
    const at = this.located();
    if (!at || isLocked(this.outer.state)) return true;
    const changes = shift(insertRow(at.m, at.m.body.length, this.outer.state.lineBreak), at.span.from);
    this.outer.dispatch({ changes, annotations: [isolateHistory.of('full'), Transaction.userEvent.of('input')] });
    focusCell(this.outer, at.span.from, at.m.body.length + 1, c, 'all');
    return true;
  }

  private next(): boolean {
    const at = this.located();
    if (!at) return false;
    const { r, c } = at.ac;
    if (c + 1 < at.m.width) return this.go(r, c + 1, 'all');
    if (r < at.m.body.length) return this.go(r + 1, 0, 'all');
    return this.addRow(0);
  }

  private prev(): boolean {
    const at = this.located();
    if (!at) return false;
    const { r, c } = at.ac;
    if (c > 0) return this.go(r, c - 1, 'all');
    if (r > 0) return this.go(r - 1, at.m.width - 1, 'all');
    return true;
  }

  private down(): boolean {
    const at = this.located();
    if (!at) return false;
    const { r, c } = at.ac;
    return r < at.m.body.length ? this.go(r + 1, c, 'all') : this.addRow(c);
  }

  /**
   * 표 위(앞 줄의 끝)나 아래로 나간다. 아래로는 언제나 `exitBelow` 와 같다: 표 바로 아래 줄(이나 표 끝)에 커서를 두면
   * 이어 친 글이 표의 행(이나 넘치는 칸)이 되고 그 아래 문단까지 표에 빨려 든다.
   */
  private exit(dir: -1 | 1): boolean {
    if (dir > 0) return this.exitBelow();
    const at = this.located();
    if (!at) return false;
    this.leave(Math.max(0, at.span.from - 1));
    return true;
  }

  /**
   * 표 아래 새 줄로 나간다(Escape, Mod-Enter, 마지막 행의 ArrowDown·ArrowRight). 커서 줄은 표와 빈 줄 하나로 떨어지고,
   * 뒤에 글이 이어지면 그 글과도 빈 줄 하나로 떨어진다(`missingBelowTable`). 모자란 줄은 만든다(되돌리기 한 번).
   */
  private exitBelow(): boolean {
    const at = this.located();
    if (!at) return false;
    const doc = this.outer.state.doc;
    const br = this.outer.state.lineBreak;
    const end = at.span.to;
    if (isLocked(this.outer.state)) {
      // 잠긴 문서는 바꾸지 않는다: 표 뒤에 있는 빈 줄(둘이면 둘째)로, 없으면 표 바로 뒤로 커서만 옮긴다
      let pos = end;
      for (let n = doc.lineAt(end).number + 1; n <= doc.lines && n <= doc.lineAt(end).number + 2 && isBlank(doc.line(n).text); n++)
        pos = doc.line(n).from;
      this.leave(pos);
      return true;
    }
    const last = doc.lineAt(end).number;
    const missing = missingBelowTable(doc, last);
    if (missing) this.leave(end + 2, { from: end, insert: br.repeat(missing) });
    else this.leave(doc.line(last + 2).from);
    return true;
  }

  /** 커서가 셀 편집기의 첫(또는 마지막) 화면 줄에 있는가. 레이아웃이 없으면 그렇다고 본다. */
  private atEdgeLine(forward: boolean): boolean {
    const v = this.nested;
    const head = v.state.selection.main.head;
    const edge = forward ? v.state.doc.length : 0;
    if (head === edge) return true;
    const a = v.coordsAtPos(head);
    const b = v.coordsAtPos(edge);
    if (!a || !b || (!a.top && !a.bottom)) return true;
    return forward ? a.bottom >= b.bottom - 1 : a.top <= b.top + 1;
  }

  private arrow(dir: 'left' | 'right' | 'up' | 'down'): boolean {
    const sel = this.nested.state.selection.main;
    if (!sel.empty) return false;
    const at = this.located();
    if (!at) return false;
    const { r, c } = at.ac;
    const len = this.nested.state.doc.length;
    const last = at.m.body.length;
    switch (dir) {
      case 'left':
        if (sel.head !== 0) return false;
        if (c > 0) return this.go(r, c - 1, 'end');
        return r > 0 ? this.go(r - 1, at.m.width - 1, 'end') : this.exit(-1);
      case 'right':
        if (sel.head !== len) return false;
        if (c + 1 < at.m.width) return this.go(r, c + 1, 'start');
        return r < last ? this.go(r + 1, 0, 'start') : this.exit(1);
      case 'up':
        if (!this.atEdgeLine(false)) return false;
        return r > 0 ? this.go(r - 1, c, 'end') : this.exit(-1);
      case 'down':
        if (!this.atEdgeLine(true)) return false;
        return r < last ? this.go(r + 1, c, 'end') : this.exit(1);
    }
  }

  /** 이 칸에 붙여 표 메뉴를 연다(ContextMenu 키, Shift-F10). Escape 로 닫으면 이 칸으로 돌아온다. */
  private menu(): boolean {
    const ac = this.cell;
    if (!ac) return false;
    const outer = this.outer;
    const { tableFrom, r, c } = ac;
    return openTableMenu(outer, this.td, () => void focusCell(outer, tableFrom, r, c, 'end'));
  }

  private keys(): KeyBinding[] {
    const outer = this.outer;
    return [
      { key: 'ContextMenu', run: () => this.menu(), preventDefault: true },
      { key: 'Shift-F10', run: () => this.menu(), preventDefault: true },
      { key: 'Tab', run: () => this.next(), shift: () => this.prev() },
      { key: 'Enter', run: () => this.down() },
      {
        key: 'Shift-Enter',
        run: (v) => {
          v.dispatch(v.state.replaceSelection('<br>'), { userEvent: 'input' });
          return true;
        },
      },
      { key: 'Mod-Enter', run: () => this.exitBelow() },
      { key: 'Escape', run: () => this.exit(1) },
      { key: 'ArrowLeft', run: () => this.arrow('left') },
      { key: 'ArrowRight', run: () => this.arrow('right') },
      { key: 'ArrowUp', run: () => this.arrow('up') },
      { key: 'ArrowDown', run: () => this.arrow('down') },
      // 셀 편집기에는 기록이 없다: 바깥 편집기를 되돌린다. 할 것이 없어도 셀 편집기의 기본 동작으로 새지 않게 true.
      { key: 'Mod-z', run: () => (undo(outer), true), preventDefault: true },
      { key: 'Mod-y', run: () => (redo(outer), true), preventDefault: true },
      { key: 'Mod-Shift-z', run: () => (redo(outer), true), preventDefault: true },
      {
        key: 'Mod-s',
        preventDefault: true,
        run: () => {
          outer.state.facet(tableOptions)?.save();
          return true;
        },
      },
      ...outer.state.facet(cellOuterKeys).map((k): KeyBinding => ({ key: k.key, preventDefault: true, run: () => k.run(outer) })),
    ];
  }
}

// ---------------------------------------------------------------- 띄우기

/** 표(`tableFrom` 에서 시작하는 격자)의 r 행 c 칸 요소. */
function cellElement(view: EditorView, tableFrom: number, r: number, c: number): HTMLElement | null {
  for (const wrap of view.contentDOM.querySelectorAll<HTMLElement>('.lno-table-wrap')) {
    let pos: number;
    try {
      pos = view.posAtDOM(wrap);
    } catch {
      continue;
    }
    if (pos !== tableFrom) continue;
    const table = tableOf(wrap);
    return (table?.rows[r]?.cells[c] as HTMLElement | undefined) ?? null;
  }
  return null;
}

/**
 * 표의 r 행(0 이 머리 행) c 칸에 셀 편집기를 띄우고 포커스를 준다. 이미 다른 칸에 떠 있으면 그것을 걷는다.
 * `place` 는 커서 자리: 처음, 끝, 또는 칸 글자 안의 위치. 잠긴 편집기이거나 칸이 없으면 false.
 */
export function focusCell(view: EditorView, tableFrom: number, r: number, c: number, place: Place = 'end'): boolean {
  if (isLocked(view.state)) return false;
  const found = tableAt(view.state, tableFrom);
  const cell = found && rows(found.m)[r]?.cells[c];
  if (!found || !cell) return false;
  const td = cellElement(view, tableFrom, r, c);
  if (!td) return false;
  const text = displayText(cell.text);
  const { head } = placeRange(place, text);
  const current = sessions.get(view);
  if (current && current.td === td && !current.dead) {
    current.nested.dispatch({ selection: placeRange(place, current.nested.state.doc.toString()), annotations: fromOuter.of(true) });
    current.nested.focus();
    return true;
  }
  current?.close({ clear: false });
  // 바깥 선택도 칸 안에 둔다: 되돌리기가 이 자리로 돌아온다
  view.dispatch({
    effects: setActiveCell.of({ tableFrom, r, c }),
    selection: { anchor: found.span.from + cell.contentFrom + Math.min(head, cell.contentTo - cell.contentFrom) },
  });
  const session = new Session(view, td, text, place);
  session.nested.focus();
  view.requestMeasure();
  return true;
}

/** 바깥 편집기에서 ArrowDown/ArrowUp 으로 격자에 들어간다: 같은 열(가로 위치로 어림한다)의 첫 행이나 마지막 행 칸. */
function enterFromOuter(view: EditorView, dir: 1 | -1): boolean {
  if (isLocked(view.state)) return false;
  const sel = view.state.selection.main;
  if (!sel.empty) return false;
  const head = sel.head;
  const line = view.state.doc.lineAt(head);
  const span = renderedTables(view.state).find((s) =>
    dir > 0 ? s.from === line.to + 1 || head === s.from : s.to === line.from - 1 || head === s.to,
  );
  const found = span && locate(view.state, span);
  if (!found) return false;
  const r = dir > 0 ? 0 : found.m.body.length;
  return focusCell(view, found.span.from, r, columnAt(view, found.span.from, head), 'all');
}

/** 커서의 가로 위치가 든 머리 행 칸의 열. 알 수 없으면 0. */
function columnAt(view: EditorView, tableFrom: number, head: number): number {
  let x: number | undefined;
  try {
    x = view.coordsAtPos(head)?.left;
  } catch {
    x = undefined;
  }
  const first = cellElement(view, tableFrom, 0, 0);
  const row = first?.parentElement as HTMLTableRowElement | null | undefined;
  if (x === undefined || !row) return 0;
  for (let c = 0; c < row.cells.length; c++) {
    const rect = row.cells[c].getBoundingClientRect();
    if (x >= rect.left && x < rect.right) return c;
  }
  return 0;
}

const plugin = ViewPlugin.fromClass(
  class {
    constructor(readonly view: EditorView) {}
    update(u: ViewUpdate) {
      sessions.get(u.view)?.outerUpdate(u);
    }
    destroy() {
      // 상태를 통째로 바꾸거나(조용한 다시 읽기) 편집기를 닫는다: 셀 편집기도 걷는다
      sessions.get(this.view)?.close({ clear: false, repaint: false });
    }
  },
);

/** tableExtension 이 싣는 셀 편집 부분. */
export function cellEditorExtension(): Extension {
  return [
    activeCell,
    plugin,
    cellActivator.of((view, tableFrom, r, c, event) => {
      if (!focusCell(view, tableFrom, r, c, 'end')) return;
      const nested = activeCellView(view);
      const pos = nested?.posAtCoords({ x: event.clientX, y: event.clientY });
      if (nested && pos != null) nested.dispatch({ selection: { anchor: pos }, annotations: fromOuter.of(true) });
    }),
    Prec.high(
      keymap.of([
        { key: 'ArrowDown', run: (v) => enterFromOuter(v, 1) },
        { key: 'ArrowUp', run: (v) => enterFromOuter(v, -1) },
      ]),
    ),
  ];
}
