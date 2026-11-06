import { StateEffect } from '@codemirror/state';
import { EditorView, WidgetType } from '@codemirror/view';
import { t } from '../../i18n/t';
import { rows, type Align, type Cell, type TableModel } from './model';
import { renderInline } from './renderInline';

/**
 * 표 하나를 격자로 그리는 블록 위젯. 문서가 유일한 원본이고, 위젯은 원문(`source`)에서 다시 그릴 수 있는 그림일 뿐이다.
 *
 * - `eq` 는 원문과 편집 가능 여부만 본다. 표 밖의 글자가 바뀌어 위치만 밀릴 때는 DOM 을 다시 만들지 않는다.
 *   그래서 위치를 DOM 에 박지 않는다: 상호작용할 때 `view.posAtDOM(wrap)` 으로 표의 지금 위치를 다시 읽는다.
 * - `updateDOM` 은 같은 틀을 고쳐 쓴다. 행과 열의 모양이 같으면 글자가 바뀐 셀만 새로 그려, 다른 셀의 DOM 은 그대로다
 *   (Task 4 에서 셀 편집기가 든 칸을 살려 두는 데 쓴다).
 * - 모델의 위치는 표 시작(`source` 의 0) 기준이다.
 */

/** 이 위치에서 시작하는 표를 원문으로 보이거나(없으면 넣고) 다시 격자로 돌린다(있으면 뺀다). 값은 표의 첫 줄 시작 위치. */
export const toggleRawTable = StateEffect.define<number>({ map: (v, m) => m.mapPos(v, -1) });

/** 도구 막대 단추. 행·열 단추의 동작은 Task 5 가 붙인다(지금은 아무것도 하지 않는다). */
// 이름표는 함수로 둔다: 열 때마다 지금 언어로 읽고, 키는 글자로 적혀 catalogs.test 가 본다.
const TOOLS: ReadonlyArray<{ action: string; label: () => string }> = [
  { action: 'insertRowBelow', label: () => t('table.insertRowBelow') },
  { action: 'insertColumnRight', label: () => t('table.insertColumnRight') },
  { action: 'editAsMarkdown', label: () => t('table.editAsMarkdown') },
];

/** 행 하나의 대략 높이(px). 스크롤 위치 추정용이다. */
const ROW_PX = 32;
const TOOLBAR_PX = 28;

const ALIGN_CLASSES = ['lno-al-left', 'lno-al-center', 'lno-al-right'];

/** 셀 요소가 지금 그리고 있는 원문. 바뀌지 않은 셀은 다시 그리지 않는다. */
const drawn = new WeakMap<HTMLElement, string>();

function classify(el: HTMLElement, cell: Cell, align: Align): void {
  for (const c of ALIGN_CLASSES) el.classList.remove(c);
  if (align && !cell.overflow) el.classList.add(`lno-al-${align}`);
  el.classList.toggle('lno-cell-virtual', !!cell.virtual);
  el.classList.toggle('lno-cell-overflow', !!cell.overflow);
  if (cell.overflow) el.title = t('table.overflow');
  else el.removeAttribute('title');
}

function fillCell(el: HTMLElement, cell: Cell): void {
  if (drawn.get(el) === cell.text) return;
  el.replaceChildren();
  renderInline(cell.text, el);
  drawn.set(el, cell.text);
}

function makeCell(doc: Document, header: boolean, cell: Cell, align: Align): HTMLElement {
  const el = doc.createElement(header ? 'th' : 'td');
  el.setAttribute('role', header ? 'columnheader' : 'gridcell');
  classify(el, cell, align);
  fillCell(el, cell);
  return el;
}

function makeTable(doc: Document, m: TableModel): HTMLTableElement {
  const table = doc.createElement('table');
  table.className = 'lno-table';
  table.setAttribute('role', 'grid');
  const thead = doc.createElement('thead');
  const tbody = doc.createElement('tbody');
  rows(m).forEach((row, r) => {
    const tr = doc.createElement('tr');
    row.cells.forEach((cell, c) => tr.appendChild(makeCell(doc, r === 0, cell, m.align[c] ?? null)));
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

function labelToolbar(bar: HTMLElement): void {
  bar.setAttribute('aria-label', t('table.toolbar'));
  for (const b of bar.querySelectorAll<HTMLButtonElement>('button')) {
    const tool = TOOLS.find((x) => x.action === b.dataset.action);
    if (!tool) continue;
    const text = tool.label();
    b.setAttribute('aria-label', text);
    b.textContent = text;
  }
}

function makeToolbar(doc: Document, view: EditorView, wrap: HTMLElement): HTMLElement {
  const bar = doc.createElement('div');
  bar.className = 'lno-table-toolbar';
  bar.setAttribute('role', 'toolbar');
  for (const tool of TOOLS) {
    const b = doc.createElement('button');
    b.type = 'button';
    b.className = 'lno-table-tool';
    b.dataset.action = tool.action;
    bar.appendChild(b);
  }
  labelToolbar(bar);
  bar.addEventListener('click', (e) => {
    const b = (e.target as Element | null)?.closest('button');
    if (!b || !bar.contains(b)) return;
    if (b.dataset.action === 'editAsMarkdown') {
      const from = view.posAtDOM(wrap);
      view.dispatch({ effects: toggleRawTable.of(from), selection: { anchor: from }, scrollIntoView: true });
      view.focus();
    }
  });
  return bar;
}

const toolbarOf = (wrap: HTMLElement) => wrap.querySelector<HTMLElement>(':scope > .lno-table-toolbar');

export class TableWidget extends WidgetType {
  constructor(
    /** 표의 원문(줄 구분은 `\n`). */
    readonly source: string,
    /** `source` 기준 위치의 모델. */
    readonly model: TableModel,
    /** 잠기지 않은 편집기인가. 잠겨 있으면 도구 막대가 없다. (WidgetType 에 이미 `editable` 게터가 있어 이름이 다르다.) */
    readonly canEdit: boolean,
  ) {
    super();
  }

  eq(other: TableWidget): boolean {
    return other.source === this.source && other.canEdit === this.canEdit;
  }

  toDOM(view: EditorView): HTMLElement {
    const doc = view.dom.ownerDocument;
    const wrap = doc.createElement('div');
    wrap.className = 'lno-table-wrap';
    // 막대의 이름표는 열 때 다시 단다: 언어를 바꾼 뒤에 다시 그리지 않아도 새 언어로 읽힌다
    const relabel = () => {
      const bar = toolbarOf(wrap);
      if (bar) labelToolbar(bar);
    };
    wrap.addEventListener('pointerenter', relabel);
    wrap.addEventListener('focusin', relabel);
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
    const bar = toolbarOf(wrap);
    if (this.canEdit && !bar) wrap.prepend(makeToolbar(doc, view, wrap));
    if (!this.canEdit && bar) bar.remove();

    const m = this.model;
    const table = wrap.querySelector<HTMLTableElement>(':scope > table.lno-table');
    if (!table || !sameShape(table, m)) {
      const fresh = makeTable(doc, m);
      if (table) table.replaceWith(fresh);
      else wrap.appendChild(fresh);
      return;
    }
    rows(m).forEach((row, r) =>
      row.cells.forEach((cell, c) => {
        const el = table.rows[r].cells[c];
        classify(el, cell, m.align[c] ?? null);
        fillCell(el, cell);
      }),
    );
  }

  get estimatedHeight(): number {
    return (this.model.body.length + 1) * ROW_PX + (this.canEdit ? TOOLBAR_PX : 0);
  }

  /** 위젯 안의 사건은 모두 위젯이 다룬다: CodeMirror 는 셀과 도구 막대의 클릭·키를 보지 않는다. */
  ignoreEvent(): boolean {
    return true;
  }
}
