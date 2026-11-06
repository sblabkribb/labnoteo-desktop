// @vitest-environment jsdom
import { createRef } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView, runScopeHandlers } from '@codemirror/view';
import { history, isolateHistory, undo, undoDepth } from '@codemirror/commands';
import { labnoteMarkdown } from '../../markdownSyntax';
import { Editor, type EditorHandle } from '../../Editor';
import { catalogs } from '../../../i18n/t';
import { setLang } from '../../../i18n/lang';
import { ERROR_KINDS_FIXTURE } from '../../../__tests__/fixtures';
import type { VaultChange } from '../../../vault/useVaultEvents';
import { tableExtension } from '../field';
import { activeCell, activeCellView, focusCell, liveCellEditors } from '../cellEditor';
import { insertTable, runTableOp, tableToTSV, type TableAction } from '../commands';
import { parseTable } from '../model';

// jsdom 에는 레이아웃이 없다. CodeMirror 가 측정에 쓰는 API 만 빈 값으로 채운다.
const emptyRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
Range.prototype.getClientRects ??= emptyRects;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();
document.execCommand ??= () => false;

const LOCKED = [EditorState.readOnly.of(true), EditorView.editable.of(false)];
const views: EditorView[] = [];

function mount(doc: string, opts: { locked?: boolean; lock?: Compartment; extra?: Extension[] } = {}): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const lock = opts.lock ?? new Compartment();
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        history(),
        labnoteMarkdown(),
        tableExtension({ save: () => {}, root: document }),
        lock.of(opts.locked ? LOCKED : []),
        ...(opts.extra ?? []),
      ],
    }),
  });
  views.push(view);
  return view;
}

afterEach(() => {
  while (views.length) views.pop()!.destroy();
  document.body.innerHTML = '';
});

const wrapOf = (v: EditorView, i = 0) => v.dom.querySelectorAll<HTMLElement>('.lno-table-wrap')[i];
const cellEl = (v: EditorView, r: number, c: number) =>
  wrapOf(v).querySelector<HTMLTableElement>(':scope > .lno-table-scroll > table')!.rows[r].cells[c] as HTMLElement;
const tool = (v: EditorView, action: string) =>
  wrapOf(v).querySelector<HTMLButtonElement>(`.lno-table-toolbar button[data-action="${action}"]`)!;
const menuOf = (v: EditorView) => wrapOf(v)?.querySelector<HTMLElement>('.lno-table-menu') ?? null;
const pressMouse = (el: Element) => el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
/** 진짜 누르기처럼: mousedown 다음 click. */
const press = (el: HTMLElement) => {
  pressMouse(el);
  el.click();
};
const rightClick = (el: Element) => el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));

const T3 = '| a | b | c |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |';

describe('runTableOp: 연산마다 되돌리기 한 번', () => {
  const cases: Array<{ action: TableAction; r: number; c: number; out: string; focus: { r: number; c: number } }> = [
    { action: 'insertRowAbove', r: 1, c: 1, out: '| a | b | c |\n| --- | --- | --- |\n|  |  |  |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |', focus: { r: 1, c: 1 } },
    { action: 'insertRowBelow', r: 1, c: 1, out: '| a | b | c |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n|  |  |  |\n| 4 | 5 | 6 |', focus: { r: 2, c: 1 } },
    { action: 'insertRowBelow', r: 0, c: 0, out: '| a | b | c |\n| --- | --- | --- |\n|  |  |  |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |', focus: { r: 1, c: 0 } },
    { action: 'deleteRow', r: 1, c: 1, out: '| a | b | c |\n| --- | --- | --- |\n| 4 | 5 | 6 |', focus: { r: 1, c: 1 } },
    { action: 'deleteRow', r: 2, c: 0, out: '| a | b | c |\n| --- | --- | --- |\n| 1 | 2 | 3 |', focus: { r: 1, c: 0 } },
    {
      action: 'insertColumnLeft',
      r: 1,
      c: 1,
      out: '| a |  | b | c |\n| --- | --- | --- | --- |\n| 1 |  | 2 | 3 |\n| 4 |  | 5 | 6 |',
      focus: { r: 1, c: 1 },
    },
    {
      action: 'insertColumnRight',
      r: 1,
      c: 1,
      out: '| a | b |  | c |\n| --- | --- | --- | --- |\n| 1 | 2 |  | 3 |\n| 4 | 5 |  | 6 |',
      focus: { r: 1, c: 2 },
    },
    { action: 'deleteColumn', r: 1, c: 1, out: '| a | c |\n| --- | --- |\n| 1 | 3 |\n| 4 | 6 |', focus: { r: 1, c: 1 } },
    { action: 'deleteColumn', r: 1, c: 2, out: '| a | b |\n| --- | --- |\n| 1 | 2 |\n| 4 | 5 |', focus: { r: 1, c: 1 } },
    { action: 'alignLeft', r: 1, c: 1, out: '| a | b | c |\n| --- | :--- | --- |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |', focus: { r: 1, c: 1 } },
    { action: 'alignCenter', r: 1, c: 1, out: '| a | b | c |\n| --- | :---: | --- |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |', focus: { r: 1, c: 1 } },
    { action: 'alignRight', r: 1, c: 1, out: '| a | b | c |\n| --- | ---: | --- |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |', focus: { r: 1, c: 1 } },
    { action: 'moveRowUp', r: 2, c: 1, out: '| a | b | c |\n| --- | --- | --- |\n| 4 | 5 | 6 |\n| 1 | 2 | 3 |', focus: { r: 1, c: 1 } },
    { action: 'moveRowDown', r: 1, c: 2, out: '| a | b | c |\n| --- | --- | --- |\n| 4 | 5 | 6 |\n| 1 | 2 | 3 |', focus: { r: 2, c: 2 } },
    { action: 'moveColumnLeft', r: 1, c: 1, out: '| b | a | c |\n| --- | --- | --- |\n| 2 | 1 | 3 |\n| 5 | 4 | 6 |', focus: { r: 1, c: 0 } },
    { action: 'moveColumnRight', r: 1, c: 1, out: '| a | c | b |\n| --- | --- | --- |\n| 1 | 3 | 2 |\n| 4 | 6 | 5 |', focus: { r: 1, c: 2 } },
  ];

  for (const k of cases) {
    it(`${k.action} (${k.r}, ${k.c})`, () => {
      const doc = `앞\n\n${T3}\n\n뒤`;
      const v = mount(doc);
      const from = doc.indexOf('| a');
      expect(runTableOp(v, from, { action: k.action, r: k.r, c: k.c })).toBe(true);
      expect(v.state.doc.toString()).toBe(`앞\n\n${k.out}\n\n뒤`);
      expect(undoDepth(v.state)).toBe(1);
      // 포커스는 알맞은 칸으로 간다
      expect(v.state.field(activeCell)).toEqual({ tableFrom: from, ...k.focus });
      expect(liveCellEditors()).toBe(1);
      undo(v);
      expect(v.state.doc.toString()).toBe(doc);
      expect(undoDepth(v.state)).toBe(0);
    });
  }

  it('연산 바로 앞뒤의 타이핑과 섞이지 않는다: 되돌리기는 연산만 되돌린다', () => {
    const doc = `앞\n\n${T3}\n\n뒤`;
    const v = mount(doc);
    const from = doc.indexOf('| a');
    // 표 바로 앞에 타이핑(같은 묶음 시간 안)
    v.dispatch({ changes: { from: from - 2, insert: 'x' }, userEvent: 'input.type' });
    const typed = v.state.doc.toString();
    // 표 지우기는 포커스를 칸으로 옮기지 않는다: 뒤따르는 타이핑과 묶이지 않게 막는 것은 isolateHistory 뿐이다
    expect(runTableOp(v, from + 1, { action: 'deleteTable', r: 0, c: 0 })).toBe(true);
    const opped = v.state.doc.toString();
    expect(opped).toBe('앞x\n\n뒤');
    v.dispatch({ changes: { from: from + 1, insert: 'z' }, userEvent: 'input.type' });
    undo(v);
    expect(v.state.doc.toString()).toBe(opped);
    undo(v);
    expect(v.state.doc.toString()).toBe(typed);
    undo(v);
    expect(v.state.doc.toString()).toBe(doc);
  });

  it('문서를 바꾸는 연산의 트랜잭션은 모두 isolateHistory("full") 를 단다', () => {
    const seen: Array<string | undefined> = [];
    const spy = EditorView.updateListener.of((u) => {
      for (const tr of u.transactions) if (tr.docChanged) seen.push(tr.annotation(isolateHistory));
    });
    for (const k of cases) {
      const doc = `${T3}\n`;
      const v = mount(doc, { extra: [spy] });
      expect(runTableOp(v, 0, { action: k.action, r: k.r, c: k.c })).toBe(true);
    }
    const w = mount('앞', { extra: [spy] });
    insertTable(w);
    expect(seen.length).toBeGreaterThanOrEqual(cases.length + 1);
    expect(new Set(seen)).toEqual(new Set(['full']));
  });

  it('할 수 없는 연산(머리 행 지우기, 첫 행 위로, 한 열뿐인 표의 열 지우기)은 아무것도 하지 않는다', () => {
    const v = mount(`${T3}\n`);
    expect(runTableOp(v, 0, { action: 'deleteRow', r: 0, c: 0 })).toBe(false);
    expect(runTableOp(v, 0, { action: 'moveRowUp', r: 1, c: 0 })).toBe(false);
    expect(runTableOp(v, 0, { action: 'moveColumnLeft', r: 1, c: 0 })).toBe(false);
    expect(runTableOp(v, 99, { action: 'insertRowBelow', r: 1, c: 0 })).toBe(false);
    expect(v.state.doc.toString()).toBe(`${T3}\n`);
    const one = mount('| a |\n| --- |\n| 1 |\n');
    expect(runTableOp(one, 0, { action: 'deleteColumn', r: 1, c: 0 })).toBe(false);
    expect(undoDepth(v.state)).toBe(0);
  });

  it('CRLF 문서에서도 새 줄은 state.lineBreak 로 들어간다', () => {
    const doc = '| a | b |\r\n| --- | --- |\r\n| 1 | 2 |\r\n';
    const v = mount(doc, { extra: [EditorState.lineSeparator.of('\r\n')] });
    expect(runTableOp(v, 0, { action: 'insertRowBelow', r: 1, c: 0 })).toBe(true);
    expect(v.state.sliceDoc()).toBe('| a | b |\r\n| --- | --- |\r\n| 1 | 2 |\r\n|  |  |\r\n');
  });

  it('표 지우기는 표와 그 뒤의 빈 줄 하나를 지운다(되돌리기 한 번)', () => {
    const doc = `앞\n\n${T3}\n\n뒤`;
    const v = mount(doc);
    expect(runTableOp(v, 3, { action: 'deleteTable', r: 0, c: 0 })).toBe(true);
    expect(v.state.doc.toString()).toBe('앞\n\n뒤');
    expect(liveCellEditors()).toBe(0);
    undo(v);
    expect(v.state.doc.toString()).toBe(doc);
    const end = mount(`앞\n\n${T3}`);
    expect(runTableOp(end, 3, { action: 'deleteTable', r: 0, c: 0 })).toBe(true);
    expect(end.state.doc.toString()).toBe('앞');
  });

  it('잠긴 편집기에서는 아무 연산도 하지 않는다', () => {
    const v = mount(`${T3}\n`, { locked: true });
    expect(runTableOp(v, 0, { action: 'insertRowBelow', r: 1, c: 0 })).toBe(false);
    expect(insertTable(v)).toBe(false);
    expect(v.state.doc.toString()).toBe(`${T3}\n`);
  });

  it('tableToTSV 는 escape 를 풀고 <br> 을 줄바꿈으로 적는다 (Excel 이 읽는 따옴표)', () => {
    const src = '| a | b \\| c |\n| --- | --- |\n| x<br>y | C:\\  |\n| 1 |';
    const m = parseTable(src, 0, src.length)!;
    expect(tableToTSV(m)).toBe('a\tb | c\r\n"x\ny"\tC:\\\r\n1\t');
  });
});

describe('도구 막대와 오른쪽 클릭 메뉴', () => {
  it('셀 편집 중에 막대 단추를 누르면 그 칸 기준으로 연산하고 포커스는 새 칸으로 간다', () => {
    const v = mount(`${T3}\n`);
    focusCell(v, 0, 1, 1);
    press(tool(v, 'insertRowBelow'));
    expect(v.state.doc.toString()).toBe('| a | b | c |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n|  |  |  |\n| 4 | 5 | 6 |\n');
    expect(v.state.field(activeCell)).toEqual({ tableFrom: 0, r: 2, c: 1 });
    expect(activeCellView(v)).not.toBeNull();
  });

  it('칸을 고르지 않았으면 행·열 추가는 표 끝(마지막 행 아래, 마지막 열 오른쪽)에 붙는다', () => {
    const v = mount(`${T3}\n`);
    tool(v, 'insertRowBelow').click();
    expect(v.state.doc.toString()).toBe(`${T3}\n|  |  |  |\n`);
    tool(v, 'insertColumnRight').click();
    expect(v.state.doc.toString().split('\n')[0]).toBe('| a | b | c |  |');
  });

  it('도구 막대의 단추는 모든 연산을 담고 이름표는 t() 를 거친다', () => {
    const v = mount(`${T3}\n`);
    const labels = Array.from(wrapOf(v).querySelectorAll('.lno-table-toolbar button')).map((b) => b.getAttribute('aria-label'));
    for (const key of [
      'table.insertRowAbove',
      'table.insertRowBelow',
      'table.insertColumnLeft',
      'table.insertColumnRight',
      'table.deleteRow',
      'table.deleteColumn',
      'table.alignLeft',
      'table.alignCenter',
      'table.alignRight',
      'table.moveRowUp',
      'table.moveRowDown',
      'table.moveColumnLeft',
      'table.moveColumnRight',
      'table.copyTSV',
      'table.editAsMarkdown',
      'table.deleteTable',
    ])
      expect(labels).toContain(catalogs.ko[key]);
  });

  it('오른쪽 클릭 메뉴: 그 칸 기준으로 연산하고, 이름표는 열 때의 언어를 따른다', () => {
    const v = mount(`${T3}\n`);
    rightClick(cellEl(v, 2, 0));
    let menu = menuOf(v)!;
    expect(menu).not.toBeNull();
    // 메뉴는 스크롤하는 안쪽 틀 밖(바깥 틀의 자식)에 뜬다: 작은 표에도 잘리지 않는다
    expect(menu.parentElement).toBe(wrapOf(v));
    expect(menu.closest('.lno-table-scroll')).toBeNull();
    expect(menu.getAttribute('role')).toBe('menu');
    expect(menu.getAttribute('aria-label')).toBe(catalogs.ko['table.menu']);
    const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]'));
    expect(items.map((b) => b.textContent)).toContain(catalogs.ko['table.deleteRow']);
    // 마지막 행이므로 아래로 옮길 수 없다
    expect(menu.querySelector<HTMLButtonElement>('[data-action="moveRowDown"]')!.disabled).toBe(true);
    menu.querySelector<HTMLButtonElement>('[data-action="deleteRow"]')!.click();
    expect(v.state.doc.toString()).toBe('| a | b | c |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n');
    expect(menuOf(v)).toBeNull();
    // 언어를 바꾸고 다시 열면 새 언어다
    setLang('en');
    rightClick(cellEl(v, 1, 1));
    menu = menuOf(v)!;
    expect(menu.getAttribute('aria-label')).toBe(catalogs.en['table.menu']);
    expect(Array.from(menu.querySelectorAll('button')).map((b) => b.textContent)).toContain(catalogs.en['table.deleteRow']);
    // Escape 로 닫힌다
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(menuOf(v)).toBeNull();
  });

  it('잠긴 편집기는 오른쪽 클릭 메뉴를 열지 않는다', () => {
    const v = mount(`${T3}\n`, { locked: true });
    rightClick(cellEl(v, 1, 0));
    expect(menuOf(v)).toBeNull();
  });

  it('표 지우기는 두 번 눌러야 한다: 첫 번째는 "다시 누르면 지웁니다" 로 바뀐다', () => {
    const v = mount(`앞\n\n${T3}\n`);
    const b = tool(v, 'deleteTable');
    expect(b.textContent).toBe(catalogs.ko['table.deleteTable']);
    press(b);
    expect(v.state.doc.toString()).toBe(`앞\n\n${T3}\n`);
    expect(b.textContent).toBe(catalogs.ko['table.deleteTableConfirm']);
    expect(b.getAttribute('aria-label')).toBe(catalogs.ko['table.deleteTableConfirm']);
    press(b);
    expect(v.state.doc.toString()).toBe('앞\n\n');
  });

  it('표 지우기 준비는 포인터가 표를 떠나면 풀린다', () => {
    const v = mount(`${T3}\n`);
    const b = tool(v, 'deleteTable');
    press(b);
    wrapOf(v).dispatchEvent(new Event('pointerleave'));
    expect(b.textContent).toBe(catalogs.ko['table.deleteTable']);
    press(b);
    expect(v.state.doc.toString()).toBe(`${T3}\n`);
  });

  it('TSV 로 복사는 클립보드에 표를 쓴다', async () => {
    const writes: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (s: string) => void writes.push(s) },
    });
    const v = mount('| a | b |\n| --- | --- |\n| 1 | 2 |\n');
    tool(v, 'copyTSV').click();
    await waitFor(() => expect(writes).toEqual(['a\tb\r\n1\t2']));
    expect(v.state.doc.toString()).toBe('| a | b |\n| --- | --- |\n| 1 | 2 |\n');
  });
});

describe('insertTable', () => {
  it('커서 줄 다음에 빈 줄로 떨어진 3×3 표를 넣고 첫 머리 칸에 포커스를 준다(되돌리기 한 번)', () => {
    const v = mount('앞 글\n뒤 글');
    v.dispatch({ selection: { anchor: 2 } });
    expect(insertTable(v)).toBe(true);
    const table = '|  |  |  |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |';
    expect(v.state.doc.toString()).toBe(`앞 글\n\n${table}\n\n뒤 글`);
    expect(v.state.field(activeCell)).toEqual({ tableFrom: 5, r: 0, c: 0 });
    expect(activeCellView(v)).not.toBeNull();
    expect(wrapOf(v).querySelectorAll('tr')).toHaveLength(3);
    expect(wrapOf(v).querySelectorAll('tr')[0].children).toHaveLength(3);
    expect(undoDepth(v.state)).toBe(1);
    undo(v);
    expect(v.state.doc.toString()).toBe('앞 글\n뒤 글');
  });

  it('빈 문서와 빈 줄에서는 앞에 줄을 더하지 않는다', () => {
    const v = mount('');
    expect(insertTable(v, 2, 2)).toBe(true);
    expect(v.state.doc.toString()).toBe('|  |  |\n| --- | --- |\n|  |  |');
    const w = mount('앞\n\n');
    w.dispatch({ selection: { anchor: w.state.doc.length } });
    expect(insertTable(w, 2, 1)).toBe(true);
    expect(w.state.doc.toString()).toBe('앞\n\n|  |\n| --- |\n|  |');
  });

  it('CRLF 문서에서는 CRLF 로 넣는다', () => {
    const v = mount('앞\r\n', { extra: [EditorState.lineSeparator.of('\r\n')] });
    v.dispatch({ selection: { anchor: 0 } });
    insertTable(v, 2, 1);
    expect(v.state.sliceDoc()).toBe('앞\r\n\r\n|  |\r\n| --- |\r\n|  |\r\n');
    expect(v.state.field(activeCell)).toEqual({ tableFrom: 3, r: 0, c: 0 });
  });
});

// ---------------------------------------------------------------- 편집기의 "표 넣기" 단추

const P = 'lab/t.labnote.md';

function mountEditor(files: Record<string, string>) {
  const invoke = (async (cmd: string, args: Record<string, unknown>) => {
    const path = args.path as string;
    if (cmd === 'vault_read') {
      if (!(path in files)) throw { kind: ERROR_KINDS_FIXTURE.notFound, message: 'x' };
      return files[path];
    }
    if (cmd === 'vault_modify') {
      files[path] = args.content as string;
      return { kind: 'ok' };
    }
    throw new Error(`unexpected ${cmd}`);
  }) as never;
  const listen = (async () => () => {}) as never;
  const ref = createRef<EditorHandle>();
  const utils = render(<Editor ref={ref} path={P} invoke={invoke} listen={listen} autosaveMs={60_000} />);
  const view = () => {
    const root = (utils.container.querySelector('section > div') as HTMLElement).shadowRoot!;
    return EditorView.findFromDOM(root.querySelector('.cm-editor') as HTMLElement)!;
  };
  return { files, ref, view, utils };
}

describe('편집기의 표 넣기 단추', () => {
  it('읽기 전에는 꺼져 있고, 누르면 3×3 표를 넣고 머리 칸에 포커스를 준다', async () => {
    const e = mountEditor({ [P]: '# 노트\n' });
    const button = screen.getByRole('button', { name: catalogs.ko['table.insert'] }) as HTMLButtonElement;
    expect(button.className).toBe('secondary');
    await waitFor(() => expect(e.view().state.readOnly).toBe(false));
    await waitFor(() => expect(button.disabled).toBe(false));
    await act(async () => button.click());
    const v = e.view();
    expect(v.state.doc.toString()).toBe('# 노트\n\n|  |  |  |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |\n');
    expect(v.state.field(activeCell)).toMatchObject({ r: 0, c: 0 });
    expect(activeCellView(v)).not.toBeNull();
    e.utils.unmount();
  });

  it('Mod-Alt-t 로도 넣는다', async () => {
    const e = mountEditor({ [P]: '본문' });
    await waitFor(() => expect(e.view().state.readOnly).toBe(false));
    const v = e.view();
    const isMac = /Mac/.test(navigator.platform);
    const ev = new KeyboardEvent('keydown', { key: 't', altKey: true, ctrlKey: !isMac, metaKey: isMac, bubbles: true, cancelable: true });
    await act(async () => void runScopeHandlers(v, ev, 'editor'));
    expect(v.state.doc.toString()).toBe('본문\n\n|  |  |  |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |');
    e.utils.unmount();
  });

  it('단추의 이름은 언어를 따른다', async () => {
    const e = mountEditor({ [P]: '' });
    await act(async () => setLang('en'));
    expect(screen.getByRole('button', { name: catalogs.en['table.insert'] })).toBeDefined();
    e.utils.unmount();
  });
});
