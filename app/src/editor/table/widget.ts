import { Facet, StateEffect } from '@codemirror/state';
import { EditorView, WidgetType } from '@codemirror/view';
import { t } from '../../i18n/t';
import { rows, type Align, type Cell, type TableModel } from './model';
import { sampleCellDecorator } from '../../samples/cellMarks';
import { renderInline, type InlineDecorator } from './renderInline';

/**
 * 표 하나를 격자로 그리는 블록 위젯. 문서가 유일한 원본이고, 위젯은 원문(`source`)에서 다시 그릴 수 있는 그림일 뿐이다.
 *
 * - `eq` 는 원문과 편집 가능 여부만 본다. 표 밖의 글자가 바뀌어 위치만 밀릴 때는 DOM 을 다시 만들지 않는다.
 *   그래서 위치를 DOM 에 박지 않는다: 상호작용할 때 `view.posAtDOM(wrap)` 으로 표의 지금 위치를 다시 읽는다.
 * - `updateDOM` 은 같은 틀을 고쳐 쓴다. 행과 열의 모양이 같으면 글자가 바뀐 셀만 새로 그려, 다른 셀의 DOM 은 그대로다
 *   (Task 4 에서 셀 편집기가 든 칸을 살려 두는 데 쓴다).
 * - 모델의 위치는 표 시작(`source` 의 0) 기준이다.
 * - 도구 막대와 오른쪽 클릭 메뉴의 단추는 `tableOpRunner`(commands.ts)를 부른다. 이름표는 열 때마다 지금 언어로 단다.
 * - 도구 막대는 작은 단추 넷(아래에 행, 오른쪽에 열, 정렬 돌리기, 더 보기)이고 표 위 오른쪽에 겹쳐 뜬다: 자리를 차지하지 않는다.
 *   모든 연산은 메뉴(오른쪽 클릭, "더 보기", 칸에서 ContextMenu 키·Shift-F10)에 있다.
 * - 메뉴는 연 자리(누른 점, 또는 단추나 칸)에 뜨고, 편집기 스크롤 틀 안에 다 보이도록 뒤집거나 민다. 자리는 CSSOM 으로 적는다
 *   (`style` 속성은 CSP 가 막는다).
 */

/** 이 위치에서 시작하는 표를 원문으로 보이거나(없으면 넣고) 다시 격자로 돌린다(있으면 뺀다). 값은 표의 첫 줄 시작 위치. */
export const toggleRawTable = StateEffect.define<number>({ map: (v, m) => m.mapPos(v, -1) });

/** 표 연산의 이름. 도구 막대와 오른쪽 클릭 메뉴의 단추가 같은 이름을 쓴다(commands.ts 의 runTableOp). */
export type TableAction =
  | 'insertRowAbove'
  | 'insertRowBelow'
  | 'insertColumnLeft'
  | 'insertColumnRight'
  | 'deleteRow'
  | 'deleteColumn'
  | 'alignLeft'
  | 'alignCenter'
  | 'alignRight'
  | 'moveRowUp'
  | 'moveRowDown'
  | 'moveColumnLeft'
  | 'moveColumnRight'
  | 'copyTSV'
  | 'editAsMarkdown'
  | 'deleteTable';

/**
 * 도구 막대와 메뉴의 단추, 보이는 순서대로.
 * 이름표는 함수로 둔다: 열 때마다 지금 언어로 읽고, 키는 글자로 적혀 catalogs.test 가 본다.
 */
const TOOLS: ReadonlyArray<{ action: TableAction; label: () => string }> = [
  { action: 'insertRowAbove', label: () => t('table.insertRowAbove') },
  { action: 'insertRowBelow', label: () => t('table.insertRowBelow') },
  { action: 'insertColumnLeft', label: () => t('table.insertColumnLeft') },
  { action: 'insertColumnRight', label: () => t('table.insertColumnRight') },
  { action: 'deleteRow', label: () => t('table.deleteRow') },
  { action: 'deleteColumn', label: () => t('table.deleteColumn') },
  { action: 'alignLeft', label: () => t('table.alignLeft') },
  { action: 'alignCenter', label: () => t('table.alignCenter') },
  { action: 'alignRight', label: () => t('table.alignRight') },
  { action: 'moveRowUp', label: () => t('table.moveRowUp') },
  { action: 'moveRowDown', label: () => t('table.moveRowDown') },
  { action: 'moveColumnLeft', label: () => t('table.moveColumnLeft') },
  { action: 'moveColumnRight', label: () => t('table.moveColumnRight') },
  { action: 'copyTSV', label: () => t('table.copyTSV') },
  { action: 'editAsMarkdown', label: () => t('table.editAsMarkdown') },
  { action: 'deleteTable', label: () => t('table.deleteTable') },
];

/** 도구 막대의 단추: 표 연산 둘과, 위젯이 직접 다루는 정렬 돌리기·더 보기. */
type StripAction = 'insertRowBelow' | 'insertColumnRight' | 'cycleAlign' | 'more';

/** 도구 막대의 작은 단추. 보이는 글자는 기호이고, 이름(aria-label 과 title)은 번역 카탈로그에서 읽는다. */
const STRIP: ReadonlyArray<{ action: StripAction; glyph: string; label: () => string }> = [
  { action: 'insertRowBelow', glyph: '+\u2193', label: () => t('table.insertRowBelow') },
  { action: 'insertColumnRight', glyph: '+\u2192', label: () => t('table.insertColumnRight') },
  { action: 'cycleAlign', glyph: '\u2261', label: () => t('table.alignCycle') },
  { action: 'more', glyph: '\u22ef', label: () => t('table.more') },
];

/**
 * 표 연산을 하는 쪽(commands.ts). 위젯은 commands 를 모른다(순환 import 를 피한다): 단추를 누르면 이 facet 의 함수를 부른다.
 * (r, c) 는 연산의 기준 칸이다. 해냈으면 true.
 */
export type TableOpRunner = (view: EditorView, tableFrom: number, op: { action: TableAction; r: number; c: number }) => boolean;
export const tableOpRunner = Facet.define<TableOpRunner, TableOpRunner | null>({ combine: (v) => v[0] ?? null });

/**
 * 셀 편집기(cellEditor.ts)와 이어지는 자리. 위젯은 셀 편집기를 모른다(순환 import 를 피한다):
 * 칸을 누르면 이 facet 의 함수를 부르고, 셀 편집기가 든 칸은 `activeCells` 로 알아본다.
 */
export type CellActivator = (view: EditorView, tableFrom: number, r: number, c: number, event: MouseEvent) => void;
export const cellActivator = Facet.define<CellActivator, CellActivator | null>({ combine: (v) => v[0] ?? null });

/** 셀 편집기가 들어 있는 칸과 그 편집기의 손잡이. */
export interface CellHandle {
  /** 표 DOM 을 다시 그렸거나 행이 밀렸다: 셀 편집기를 지금 활성 칸의 요소로 옮긴다(못 찾으면 걷는다). */
  relocate(table: HTMLTableElement): void;
  /** 위젯 DOM 이 사라진다: 셀 편집기를 걷는다. */
  release(): void;
}
export const activeCells = new WeakMap<HTMLElement, CellHandle>();

/** 행 하나의 대략 높이(px). 스크롤 위치 추정용이다. */
const ROW_PX = 32;
/** 표 틀의 위아래 여백(px, theme.ts 의 `.lno-table-wrap` padding). 도구 막대는 겹쳐 뜨므로 높이에 넣지 않는다. */
const WRAP_PX = 16;

const ALIGN_CLASSES = ['lno-al-left', 'lno-al-center', 'lno-al-right'];

/** 셀 요소가 지금 그리고 있는 원문(과 샘플 표시 열쇠). 바뀌지 않은 셀은 다시 그리지 않는다. */
const drawn = new WeakMap<HTMLElement, string>();

/** 셀을 그릴 때의 꾸밈(샘플 ID 표시, Task 10)과 그 열쇠. 열쇠가 바뀌면 글자가 같아도 다시 그린다. */
interface Paint {
  decorate: InlineDecorator | undefined;
  key: string;
}
const PLAIN: Paint = { decorate: undefined, key: '' };

function classify(el: HTMLElement, cell: Cell, align: Align): void {
  for (const c of ALIGN_CLASSES) el.classList.remove(c);
  if (align && !cell.overflow) el.classList.add(`lno-al-${align}`);
  el.classList.toggle('lno-cell-virtual', !!cell.virtual);
  el.classList.toggle('lno-cell-overflow', !!cell.overflow);
  if (cell.overflow) el.title = t('table.overflow');
  else el.removeAttribute('title');
}

function fillCell(el: HTMLElement, cell: Cell, paint: Paint): void {
  // 셀 편집기가 든 칸은 건드리지 않는다: 그 칸의 DOM 과 편집기가 자기 입력에도 살아 있어야 한글 조합이 깨지지 않는다
  const mark = `${paint.key}\u0000${cell.text}`;
  if (activeCells.has(el) || drawn.get(el) === mark) return;
  el.replaceChildren();
  renderInline(cell.text, el, paint.decorate);
  drawn.set(el, mark);
}

function makeCell(doc: Document, header: boolean, cell: Cell, align: Align, paint: Paint): HTMLElement {
  const el = doc.createElement(header ? 'th' : 'td');
  el.setAttribute('role', header ? 'columnheader' : 'gridcell');
  classify(el, cell, align);
  fillCell(el, cell, paint);
  return el;
}

function makeTable(doc: Document, m: TableModel, paint: Paint): HTMLTableElement {
  const table = doc.createElement('table');
  table.className = 'lno-table';
  table.setAttribute('role', 'grid');
  const thead = doc.createElement('thead');
  const tbody = doc.createElement('tbody');
  rows(m).forEach((row, r) => {
    const tr = doc.createElement('tr');
    row.cells.forEach((cell, c) => tr.appendChild(makeCell(doc, r === 0, cell, m.align[c] ?? null, paint)));
    (r === 0 ? thead : tbody).appendChild(tr);
  });
  table.append(thead, tbody);
  return table;
}

/** 표 DOM 의 모양(행 수와 행마다 셀 수)이 모델과 같은가. */
function sameShape(table: HTMLTableElement, m: TableModel): boolean {
  const all = rows(m);
  if (table.rows.length !== all.length) return false;
  return all.every((row, r) => table.rows[r].cells.length === row.cells.length);
}

// ---------------------------------------------------------------- 단추

/** 두 번 눌러야 하는 "표 지우기" 단추가 한 번 눌린 상태인가. */
const isArmed = (b: HTMLElement) => b.dataset.armed === 'true';

function setLabel(b: HTMLElement): void {
  const strip = b.dataset.glyph !== undefined ? STRIP.find((x) => x.action === b.dataset.action) : undefined;
  if (strip) {
    const name = strip.label();
    b.setAttribute('aria-label', name);
    b.title = name;
    b.textContent = strip.glyph;
    return;
  }
  const text =
    b.dataset.action === 'deleteTable' && isArmed(b) ? t('table.deleteTableConfirm') : TOOLS.find((x) => x.action === b.dataset.action)?.label();
  if (text === undefined) return;
  b.setAttribute('aria-label', text);
  b.textContent = text;
}

/** 한 번 눌린 "표 지우기" 를 처음 상태로 돌린다. */
function disarm(root: Element): void {
  for (const b of root.querySelectorAll<HTMLElement>('button[data-armed="true"]')) {
    delete b.dataset.armed;
    setLabel(b);
  }
}

function labelToolbar(bar: HTMLElement): void {
  bar.setAttribute('aria-label', t('table.toolbar'));
  for (const b of bar.querySelectorAll<HTMLButtonElement>('button')) setLabel(b);
}

/** 이 표에서 마지막으로 누르거나 포커스를 준 칸. 셀 편집기가 떠 있지 않을 때 연산의 기준이 된다. */
const lastCell = new WeakMap<HTMLElement, { r: number; c: number }>();
/** 틀이 지금 그리고 있는 위젯(sync 가 바꾼다). 이벤트 처리기가 지금의 모델을 읽는다. */
const current = new WeakMap<HTMLElement, TableWidget>();

function cellOf(wrap: HTMLElement, target: EventTarget | null): HTMLTableCellElement | null {
  const el = (target as Element | null)?.closest?.('th, td') as HTMLTableCellElement | null;
  return el && wrap.contains(el) ? el : null;
}
const indexOf = (el: HTMLTableCellElement) => ({ r: (el.parentElement as HTMLTableRowElement).rowIndex, c: el.cellIndex });

/**
 * 연산의 기준 칸: 셀 편집기가 든 칸, 없으면 마지막으로 고른 칸, 그것도 없으면 마지막 행의 마지막 열
 * (그래서 칸을 고르지 않고 누른 "아래에 행 추가" 는 표 끝에 붙는다).
 */
function targetCell(wrap: HTMLElement): { r: number; c: number } {
  const m = current.get(wrap)?.model;
  const height = m ? m.body.length + 1 : 1;
  const width = m ? m.width : 1;
  const active = wrap.querySelector<HTMLTableCellElement>('.lno-cell-active');
  const at = active ? indexOf(active) : lastCell.get(wrap);
  if (at && at.r < height && at.c < width) return at;
  return { r: height - 1, c: width - 1 };
}

const isLocked = (view: EditorView) => view.state.readOnly || !view.state.facet(EditorView.editable);

/**
 * 단추 하나를 누른다. "표 지우기" 는 처음 누르면 "다시 누르면 지웁니다" 로 바뀌고, 그 상태에서 한 번 더 눌러야 지운다
 * (확인 창 없이). 연산을 불렀으면 true, 지우기를 준비만 했으면 false.
 */
function runButton(view: EditorView, wrap: HTMLElement, b: HTMLElement): boolean {
  let action = b.dataset.action as TableAction | StripAction | undefined;
  if (!action) return false;
  if (action === 'more') {
    disarm(wrap);
    if (b.dataset.closing) {
      delete b.dataset.closing;
      return false;
    }
    openMenu(view, wrap, targetCell(wrap), b, () => b.focus());
    return false;
  }
  if (action === 'cycleAlign') {
    // 왼쪽(정렬 없음 포함) → 가운데 → 오른쪽 → 왼쪽
    const at = targetCell(wrap);
    const align = current.get(wrap)?.model.align[at.c] ?? null;
    action = align === 'center' ? 'alignRight' : align === 'right' ? 'alignLeft' : 'alignCenter';
  }
  if (action === 'deleteTable' && !isArmed(b)) {
    b.dataset.armed = 'true';
    setLabel(b);
    return false;
  }
  disarm(wrap);
  const run = view.state.facet(tableOpRunner);
  if (!run) return false;
  run(view, view.posAtDOM(wrap), { action, ...targetCell(wrap) });
  return true;
}

function makeButton(doc: Document, action: TableAction): HTMLButtonElement {
  const b = doc.createElement('button');
  b.type = 'button';
  b.className = 'lno-btn lno-table-tool';
  b.dataset.action = action;
  setLabel(b);
  return b;
}

/** 도구 막대의 작은 단추(기호 글자, 이름은 aria-label 과 title). */
function makeStripButton(doc: Document, tool: (typeof STRIP)[number]): HTMLButtonElement {
  const b = doc.createElement('button');
  b.type = 'button';
  b.className = 'lno-btn lno-table-tool lno-table-strip-tool';
  b.dataset.action = tool.action;
  b.dataset.glyph = '';
  if (tool.action === 'more') {
    b.setAttribute('aria-haspopup', 'menu');
    b.setAttribute('aria-expanded', 'false');
  }
  setLabel(b);
  return b;
}

function makeToolbar(doc: Document, view: EditorView, wrap: HTMLElement): HTMLElement {
  const bar = doc.createElement('div');
  bar.className = 'lno-widget lno-table-toolbar';
  bar.setAttribute('role', 'toolbar');
  for (const tool of STRIP) bar.appendChild(makeStripButton(doc, tool));
  labelToolbar(bar);
  // 셀 편집기의 포커스를 뺏지 않는다: 누르는 동안에도 셀 편집기가 든 칸이 연산의 기준으로 남는다
  bar.addEventListener('mousedown', (e) => {
    const b = (e.target as Element | null)?.closest<HTMLElement>('button');
    if (!b) return;
    e.preventDefault();
    // 메뉴가 열린 채 "더 보기" 를 누르면(표 틀의 mousedown 이 곧 메뉴를 닫는다) 이어지는 click 은 다시 열지 않는다: 여닫기
    if (b.dataset.action === 'more' && menuOf(wrap)) b.dataset.closing = 'true';
  });
  bar.addEventListener('click', (e) => {
    const b = (e.target as Element | null)?.closest('button');
    if (b && bar.contains(b)) runButton(view, wrap, b);
  });
  bar.addEventListener('focusout', (e) => {
    if (!bar.contains(e.relatedTarget as Node | null)) disarm(bar);
  });
  return bar;
}

// ---------------------------------------------------------------- 오른쪽 클릭 메뉴

const menuOf = (wrap: HTMLElement) => wrap.querySelector<HTMLElement>(':scope > .lno-table-menu');
function closeMenu(wrap: HTMLElement): void {
  menuOf(wrap)?.remove();
  wrap.querySelector('.lno-table-toolbar button[aria-expanded="true"]')?.setAttribute('aria-expanded', 'false');
}

/** 메뉴를 붙일 자리: 누른 점(화면 좌표), 또는 그 아래에 붙일 요소(단추나 칸). */
type MenuAnchor = { x: number; y: number } | Element;

/** [start, start+size) 가 hi 를 넘으면 alt 의 반대쪽(alt-size)으로 뒤집고, 그래도 넘치면 [lo, hi) 안으로 민다(lo 쪽이 우선). */
function fit(start: number, alt: number, size: number, lo: number, hi: number): number {
  const p = start + size > hi ? alt - size : start;
  return Math.max(lo, Math.min(p, hi - size));
}

/**
 * 메뉴를 붙일 자리에 둔다. 편집기 스크롤 틀(창과 겹치는 부분)이 보이는 영역이다: 오른쪽이 모자라면 왼쪽으로, 아래가 모자라면
 * 위로 뒤집고, 그래도 넘치면 안으로 민다. 영역보다 길면 높이를 줄여 메뉴 안에서 스크롤한다.
 * 자리는 표 틀(position: relative) 기준 left/top 이고 CSSOM 으로 적는다: CSP 가 style 속성을 막는다.
 */
function placeMenu(view: EditorView, wrap: HTMLElement, menu: HTMLElement, anchor: MenuAnchor): void {
  const win = wrap.ownerDocument.defaultView;
  const area = view.scrollDOM.getBoundingClientRect();
  const lo = { x: Math.max(area.left, 0), y: Math.max(area.top, 0) };
  const hi = {
    x: win?.innerWidth ? Math.min(area.right, win.innerWidth) : area.right,
    y: win?.innerHeight ? Math.min(area.bottom, win.innerHeight) : area.bottom,
  };
  menu.style.removeProperty('max-height');
  const size = menu.getBoundingClientRect();
  let h = size.height;
  const room = hi.y - lo.y;
  if (room > 0 && h > room) {
    menu.style.setProperty('max-height', `${room}px`);
    h = room;
  }
  let left: number;
  let top: number;
  if (anchor instanceof Element) {
    // 요소 아래 왼쪽에 붙인다. 모자라면 요소의 오른쪽 끝·위쪽 끝에 맞춰 뒤집는다
    const a = anchor.getBoundingClientRect();
    left = fit(a.left, a.right, size.width, lo.x, hi.x);
    top = fit(a.bottom, a.top, h, lo.y, hi.y);
  } else {
    left = fit(anchor.x, anchor.x, size.width, lo.x, hi.x);
    top = fit(anchor.y, anchor.y, h, lo.y, hi.y);
  }
  const box = wrap.getBoundingClientRect();
  menu.style.setProperty('left', `${Math.round(left - box.left)}px`);
  menu.style.setProperty('top', `${Math.round(top - box.top)}px`);
}

/** 그 칸에서 할 수 없는 연산(머리 행 지우기, 첫 행을 위로 등)은 메뉴에서 끈다. */
function applicable(action: TableAction, m: TableModel, r: number, c: number): boolean {
  switch (action) {
    case 'deleteRow':
      return r >= 1;
    case 'moveRowUp':
      return r >= 2;
    case 'moveRowDown':
      return r >= 1 && r < m.body.length;
    case 'deleteColumn':
      return m.width > 1;
    case 'moveColumnLeft':
      return c >= 1;
    case 'moveColumnRight':
      return c < m.width - 1;
    default:
      return true;
  }
}

/**
 * 표 메뉴. 열 때마다 새로 만들어 지금 언어의 이름표를 단다. `anchor` 자리에 뜨고, Escape 로 닫으면 `restore` 가 포커스를 돌려준다
 * (단추로 열었으면 그 단추, 칸에서 키로 열었으면 그 칸, 오른쪽 클릭이면 바깥 편집기).
 */
function openMenu(
  view: EditorView,
  wrap: HTMLElement,
  at: { r: number; c: number },
  anchor: MenuAnchor,
  restore: () => void = () => view.focus(),
): void {
  closeMenu(wrap);
  const doc = wrap.ownerDocument;
  const m = current.get(wrap)?.model;
  const menu = doc.createElement('div');
  menu.className = 'lno-widget lno-popover lno-table-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', t('table.menu'));
  for (const tool of TOOLS) {
    const b = makeButton(doc, tool.action);
    b.setAttribute('role', 'menuitem');
    b.disabled = !!m && !applicable(tool.action, m, at.r, at.c);
    menu.appendChild(b);
  }
  const items = () => Array.from(menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
  menu.addEventListener('click', (e) => {
    const b = (e.target as Element | null)?.closest('button');
    if (!b || !menu.contains(b) || b.disabled) return;
    lastCell.set(wrap, at);
    // 지우기를 준비만 했으면 메뉴는 열린 채로 두어 한 번 더 누를 수 있게 한다
    if (!runButton(view, wrap, b) && b.dataset.action === 'deleteTable') return;
    closeMenu(wrap);
  });
  menu.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeMenu(wrap);
      restore();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const list = items();
    const i = list.indexOf(doc.activeElement as HTMLButtonElement);
    list[(i + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length]?.focus();
  });
  menu.addEventListener('focusout', (e) => {
    const to = e.relatedTarget as Node | null;
    if (to && !menu.contains(to)) closeMenu(wrap);
  });
  wrap.appendChild(menu);
  placeMenu(view, wrap, menu, anchor);
  if (anchor instanceof Element && anchor.getAttribute('aria-haspopup') === 'menu') anchor.setAttribute('aria-expanded', 'true');
  items()[0]?.focus();
}

/**
 * 칸(셀 편집기가 든 칸 등)에 붙여 표 메뉴를 연다: 칸에서 ContextMenu 키나 Shift-F10 을 눌렀을 때(cellEditor.ts).
 * 잠겼거나 연산할 쪽이 없으면 열지 않고 false. `restore` 는 Escape 로 닫을 때 포커스를 그 칸으로 돌려준다.
 */
export function openTableMenu(view: EditorView, cell: HTMLElement, restore: () => void): boolean {
  const wrap = cell.closest<HTMLElement>('.lno-table-wrap');
  const el = wrap && cellOf(wrap, cell);
  if (!wrap || !el || isLocked(view) || !view.state.facet(tableOpRunner)) return false;
  const at = indexOf(el);
  lastCell.set(wrap, at);
  openMenu(view, wrap, at, el, restore);
  return true;
}

// ---------------------------------------------------------------- 칸

/**
 * 셀 편집기를 걷은 칸을 셀 글자로 다시 그린다. 다음 갱신 때는 모델 글자로 한 번 더 맞춘다.
 * `decorate` 는 바깥 편집기의 샘플 표시(`sampleCellDecorator(outer.state)`)다.
 */
export function paintCell(el: HTMLElement, text: string, decorate?: InlineDecorator): void {
  drawn.delete(el);
  el.replaceChildren();
  renderInline(text, el, decorate);
}

const activeIn = (root: Element) => {
  const el = root.querySelector<HTMLElement>('.lno-cell-active');
  return el ? activeCells.get(el) : undefined;
};

/** 칸을 누르면(잠기지 않았을 때) 셀 편집기를 띄운다. 셀 편집기가 이미 든 칸은 그 편집기가 다룬다. 오른쪽 클릭은 메뉴를 연다. */
function listenForCells(wrap: HTMLElement, view: EditorView): void {
  wrap.addEventListener('mousedown', (e) => {
    const menu = menuOf(wrap);
    if (menu && !menu.contains(e.target as Node | null)) closeMenu(wrap);
    if (e.button !== 0) return;
    const el = cellOf(wrap, e.target);
    if (!el) return;
    lastCell.set(wrap, indexOf(el));
    if (activeCells.has(el)) return;
    const activate = view.state.facet(cellActivator);
    if (!activate || isLocked(view)) return;
    const { r, c } = indexOf(el);
    e.preventDefault(); // 바깥 편집기가 포커스를 가져가지 않게
    activate(view, view.posAtDOM(wrap), r, c, e);
  });
  wrap.addEventListener('focusin', (e) => {
    const el = cellOf(wrap, e.target);
    if (el) lastCell.set(wrap, indexOf(el));
  });
  wrap.addEventListener('contextmenu', (e) => {
    // 메뉴 안(키보드로 연 뒤 ContextMenu 키를 뗄 때 오는 사건 포함): 기본 메뉴를 띄우지 않고 열린 메뉴를 그대로 둔다
    const menu = menuOf(wrap);
    if (menu && menu.contains(e.target as Node | null)) return e.preventDefault();
    const el = cellOf(wrap, e.target);
    if (!el || isLocked(view) || !view.state.facet(tableOpRunner)) return;
    e.preventDefault();
    const at = indexOf(el);
    lastCell.set(wrap, at);
    openMenu(view, wrap, at, { x: e.clientX, y: e.clientY });
  });
  wrap.addEventListener('pointerleave', () => disarm(wrap));
}

const toolbarOf = (wrap: HTMLElement) => wrap.querySelector<HTMLElement>(':scope > .lno-table-toolbar');

/**
 * 표만 감싸 가로로 스크롤하는 안쪽 틀(없으면 만든다). 바깥 틀은 넘침을 자르지 않아야 오른쪽 클릭 메뉴가 표 밖으로 펼쳐진다:
 * 메뉴는 이 틀이 아니라 바깥 틀의 자식이다.
 */
function scrollBox(wrap: HTMLElement): HTMLElement {
  const found = wrap.querySelector<HTMLElement>(':scope > .lno-table-scroll');
  if (found) return found;
  const box = wrap.ownerDocument.createElement('div');
  box.className = 'lno-table-scroll';
  wrap.insertBefore(box, menuOf(wrap));
  return box;
}

/** 틀 안의 격자 표. 셀 편집기(cellEditor.ts)도 이것으로 칸을 찾는다. */
export const tableOf = (wrap: HTMLElement) => wrap.querySelector<HTMLTableElement>(':scope > .lno-table-scroll > table.lno-table');

export class TableWidget extends WidgetType {
  constructor(
    /** 표의 원문(줄 구분은 `\n`). */
    readonly source: string,
    /** `source` 기준 위치의 모델. */
    readonly model: TableModel,
    /** 잠기지 않은 편집기인가. 잠겨 있으면 도구 막대가 없다. (WidgetType 에 이미 `editable` 게터가 있어 이름이 다르다.) */
    readonly canEdit: boolean,
    /**
     * 셀의 샘플 표시 열쇠(`sampleCellKey`: 설정과 판, 노트 경로, 노트가 정의한 ID). 설정이 없으면 ''.
     * 바뀌면 같은 원문이라도 셀을 다시 그린다.
     */
    readonly samplesKey: string = '',
  ) {
    super();
  }

  eq(other: TableWidget): boolean {
    return other.source === this.source && other.canEdit === this.canEdit && other.samplesKey === this.samplesKey;
  }

  toDOM(view: EditorView): HTMLElement {
    const doc = view.dom.ownerDocument;
    const wrap = doc.createElement('div');
    wrap.className = 'lno-table-wrap';
    // 막대의 이름표와 넘치는 셀의 title 은 열 때 다시 단다: 언어를 바꾼 뒤에 다시 그리지 않아도 새 언어로 읽힌다
    const relabel = () => {
      const bar = toolbarOf(wrap);
      if (bar) labelToolbar(bar);
      const title = t('table.overflow');
      for (const c of wrap.querySelectorAll<HTMLElement>('.lno-cell-overflow')) c.title = title;
    };
    wrap.addEventListener('pointerenter', relabel);
    wrap.addEventListener('focusin', relabel);
    listenForCells(wrap, view);
    this.sync(wrap, view);
    return wrap;
  }

  updateDOM(dom: HTMLElement, view: EditorView): boolean {
    this.sync(dom, view);
    return true;
  }

  /** 틀 안의 도구 막대와 표를 이 위젯에 맞춘다. 모양이 같으면 셀 단위로 고친다. */
  private sync(wrap: HTMLElement, view: EditorView): void {
    const doc = wrap.ownerDocument;
    current.set(wrap, this);
    const bar = toolbarOf(wrap);
    if (this.canEdit && !bar) wrap.prepend(makeToolbar(doc, view, wrap));
    if (!this.canEdit) {
      bar?.remove();
      closeMenu(wrap);
    }

    const m = this.model;
    const paint: Paint = this.samplesKey ? { decorate: sampleCellDecorator(view.state), key: this.samplesKey } : PLAIN;
    const table = tableOf(wrap);
    const active = table ? activeIn(table) : undefined;
    if (!table || !sameShape(table, m)) {
      const fresh = makeTable(doc, m, paint);
      if (table) table.replaceWith(fresh);
      else scrollBox(wrap).appendChild(fresh);
      active?.relocate(fresh);
      return;
    }
    // 위에 행이 들어오는 등으로 활성 칸이 옮겨 갔으면 편집기를 먼저 옮긴다: 비운 칸은 아래에서 다시 그린다
    active?.relocate(table);
    rows(m).forEach((row, r) =>
      row.cells.forEach((cell, c) => {
        const el = table.rows[r].cells[c];
        classify(el, cell, m.align[c] ?? null);
        fillCell(el, cell, paint);
      }),
    );
  }

  get estimatedHeight(): number {
    return (this.model.body.length + 1) * ROW_PX + WRAP_PX;
  }

  destroy(dom: HTMLElement): void {
    activeIn(dom)?.release();
  }

  /** 위젯 안의 사건은 모두 위젯이 다룬다: CodeMirror 는 셀과 도구 막대의 클릭·키를 보지 않는다. */
  ignoreEvent(): boolean {
    return true;
  }
}
