// @vitest-environment jsdom
import { createRef } from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView, runScopeHandlers } from '@codemirror/view';
import { history } from '@codemirror/commands';
import { labnoteMarkdown } from '../../markdownSyntax';
import { Editor, type EditorHandle } from '../../Editor';
import { catalogs } from '../../../i18n/t';
import { ERROR_KINDS_FIXTURE } from '../../../__tests__/fixtures';
import type { VaultChange } from '../../../vault/useVaultEvents';
import { tableExtension } from '../field';
import { activeCell, activeCellView, cellEdit, focusCell, liveCellEditors } from '../cellEditor';

// jsdom 에는 레이아웃이 없다. CodeMirror 가 측정에 쓰는 API 만 빈 값으로 채운다.
const emptyRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
Range.prototype.getClientRects ??= emptyRects;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();
// 그림자 루트 안에서 포커스를 주면 CodeMirror 가 선택을 읽으려고 execCommand 를 부른다(jsdom 에는 없다).
document.execCommand ??= () => false;

const LOCKED = [EditorState.readOnly.of(true), EditorView.editable.of(false)];
const views: EditorView[] = [];

interface Mounted {
  view: EditorView;
  saves: number;
  changes: number;
}

function mount(doc: string, opts: { locked?: boolean; lock?: Compartment; extra?: Extension[] } = {}): Mounted {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const lock = opts.lock ?? new Compartment();
  const out = { saves: 0, changes: 0 } as Mounted;
  out.view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        history(),
        labnoteMarkdown(),
        tableExtension({ save: () => void out.saves++, root: document }),
        lock.of(opts.locked ? LOCKED : []),
        EditorView.updateListener.of((u) => void (u.docChanged && out.changes++)),
        ...(opts.extra ?? []),
      ],
    }),
  });
  views.push(out.view);
  return out;
}

afterEach(() => {
  while (views.length) views.pop()!.destroy();
  document.body.innerHTML = '';
});

const wrapOf = (v: EditorView, i = 0) => v.dom.querySelectorAll<HTMLElement>('.lno-table-wrap')[i];
const cellEl = (v: EditorView, r: number, c: number, i = 0) =>
  wrapOf(v, i).querySelector<HTMLTableElement>(':scope > .lno-table-scroll > table')!.rows[r].cells[c] as HTMLElement;
const nestedIn = (el: Element) => {
  const dom = el.querySelector<HTMLElement>('.cm-editor');
  return dom ? EditorView.findFromDOM(dom) : null;
};
const click = (el: Element) => el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));

/** 사용자가 셀 편집기에서 커서 자리에 한 글자씩 친 것과 같다. */
function type(nv: EditorView, text: string): void {
  for (const ch of text) {
    const { from, to } = nv.state.selection.main;
    nv.dispatch({ changes: { from, to, insert: ch }, selection: { anchor: from + ch.length }, userEvent: 'input.type' });
  }
}
const isMac = /Mac/.test(navigator.platform);
function key(nv: EditorView, k: string, mods: { shift?: boolean; mod?: boolean } = {}): boolean {
  const ev = new KeyboardEvent('keydown', {
    key: k,
    shiftKey: !!mods.shift,
    ctrlKey: !!mods.mod && !isMac,
    metaKey: !!mods.mod && isMac,
    bubbles: true,
    cancelable: true,
  });
  return runScopeHandlers(nv, ev, 'editor');
}
const nested = (v: EditorView) => activeCellView(v)!;

const T = '| a | b |\n| --- | --- |\n| 1 | 2 |';

describe('셀 편집기: 띄우기', () => {
  it('셀을 누르면 그 칸에 셀 편집기 하나가 뜬다: 내용은 셀의 원문 조각', () => {
    const m = mount(`앞\n\n| a | b |\n| --- | --- |\n| x \\| y | **굵게** |\n`);
    const td = cellEl(m.view, 1, 1);
    click(td);
    const nv = nestedIn(td)!;
    expect(nv).not.toBeNull();
    expect(nv).toBe(activeCellView(m.view));
    expect(nv.state.doc.toString()).toBe('**굵게**');
    expect(liveCellEditors()).toBe(1);
    expect(m.view.state.field(activeCell)).toEqual({ tableFrom: 3, r: 1, c: 1 });
    expect(td.classList.contains('lno-cell-active')).toBe(true);
    expect(nv.contentDOM.getAttribute('aria-label')).toBe(catalogs.ko['table.cellEditor']);
    // 다른 칸을 누르면 앞의 편집기는 사라지고 새 칸에 하나만 남는다
    const other = cellEl(m.view, 1, 0);
    click(other);
    expect(liveCellEditors()).toBe(1);
    expect(nestedIn(td)).toBeNull();
    expect(td.textContent).toBe('굵게'); // 다시 격자 그림으로
    expect(nestedIn(other)!.state.doc.toString()).toBe('x \\| y');
  });

  it('focusCell 은 키보드 진입처럼 칸을 연다: 처음이나 끝에 커서', () => {
    const m = mount(`${T}\n`);
    expect(focusCell(m.view, 0, 0, 1, 'start')).toBe(true);
    expect(nested(m.view).state.doc.toString()).toBe('b');
    expect(nested(m.view).state.selection.main.head).toBe(0);
    expect(focusCell(m.view, 0, 1, 0, 'end')).toBe(true);
    expect(nested(m.view).state.selection.main.head).toBe(1);
    expect(liveCellEditors()).toBe(1);
    expect(focusCell(m.view, 0, 5, 0)).toBe(false);
    expect(focusCell(m.view, 99, 0, 0)).toBe(false);
  });

  it('끝 백슬래시를 지키는 escape 공백은 셀 편집기에 보이지 않는다', () => {
    const m = mount('| p |\n| --- |\n| C:\\  |\n');
    focusCell(m.view, 0, 1, 0);
    expect(nested(m.view).state.doc.toString()).toBe('C:\\');
  });
});

describe('셀 편집기: 입력 전달', () => {
  it('친 글자는 한 글자씩 바깥 문서에 들어가고 updateListener 가 docChanged 를 본다 (자동 저장)', () => {
    const m = mount(`${T}\n`);
    focusCell(m.view, 0, 1, 0);
    const before = m.changes;
    type(nested(m.view), 'x');
    expect(m.view.state.doc.toString()).toBe(`| a | b |\n| --- | --- |\n| 1x | 2 |\n`);
    type(nested(m.view), 'y');
    expect(m.view.state.doc.toString()).toBe(`| a | b |\n| --- | --- |\n| 1xy | 2 |\n`);
    expect(m.changes - before).toBe(2);
    // 바깥 선택은 셀 안의 같은 자리다(되돌리면 그 칸으로 돌아온다)
    expect(m.view.state.selection.main.head).toBe(`| a | b |\n| --- | --- |\n| 1xy`.length);
  });

  it('전달한 트랜잭션은 cellEdit 표지와 원래의 userEvent 를 단다', () => {
    const seen: Array<{ cell: string | undefined; ue: boolean }> = [];
    const m = mount(`${T}\n`, {
      extra: [EditorView.updateListener.of((u) => u.transactions.forEach((tr) => tr.docChanged && seen.push({ cell: tr.annotation(cellEdit), ue: tr.isUserEvent('input.type') })))],
    });
    focusCell(m.view, 0, 1, 1);
    type(nested(m.view), 'z');
    expect(seen).toEqual([{ cell: '0:1:1', ue: true }]);
  });

  it('같은 셀 편집기와 같은 칸이 20번의 입력(한글 포함) 내내 살아 있다 (IME 지킴)', () => {
    const m = mount(`앞\n\n${T}\n\n뒤\n`);
    const td = cellEl(m.view, 1, 0);
    click(td);
    const nv = nestedIn(td)!;
    const dom = nv.dom;
    nv.dispatch({ selection: { anchor: nv.state.doc.length } }); // jsdom 에는 레이아웃이 없어 누른 자리를 알 수 없다
    const text = '가나다라마바사아자차카타파하 abc!';
    type(nv, text.slice(0, 20));
    expect(activeCellView(m.view)).toBe(nv);
    expect(nv.dom).toBe(dom);
    expect(cellEl(m.view, 1, 0)).toBe(td);
    expect(td.contains(dom)).toBe(true);
    expect(liveCellEditors()).toBe(1);
    expect(m.view.state.doc.toString()).toContain(`| 1${text.slice(0, 20)} | 2 |`);
  });

  it('공백을 앞뒤에 쳐도 바깥 칸에는 공백이 쌓이지 않고, 이어 친 글자는 제자리에 들어간다', () => {
    const m = mount(`${T}\n`);
    focusCell(m.view, 0, 1, 0);
    type(nested(m.view), ' ');
    expect(m.view.state.doc.toString()).toBe(`${T}\n`);
    type(nested(m.view), 'b');
    expect(m.view.state.doc.toString()).toBe(`| a | b |\n| --- | --- |\n| 1 b | 2 |\n`);
    nested(m.view).dispatch({ selection: { anchor: 0 } });
    type(nested(m.view), '  ');
    type(nested(m.view), 'q');
    expect(nested(m.view).state.doc.toString()).toBe('  q1 b');
    expect(m.view.state.doc.toString()).toBe(`| a | b |\n| --- | --- |\n| q1 b | 2 |\n`);
  });

  it('빠진(가상) 셀에 치면 행 끝에 칸을 만든다', () => {
    const m = mount('| a | b |\n| --- | --- |\n| 1 |\n');
    focusCell(m.view, 0, 1, 1);
    type(nested(m.view), 'xy');
    expect(m.view.state.doc.toString()).toBe('| a | b |\n| --- | --- |\n| 1 | xy |\n');
  });

  it('끝 백슬래시는 escape 공백과 함께 써서 C:\\ 가 그대로 돌아온다', () => {
    const m = mount('| p |\n| --- |\n| x |\n');
    focusCell(m.view, 0, 1, 0);
    const nv = nested(m.view);
    nv.dispatch({ changes: { from: 0, to: 1, insert: '' } });
    type(nv, 'C:\\');
    expect(nv.state.doc.toString()).toBe('C:\\');
    expect(m.view.state.doc.toString()).toBe('| p |\n| --- |\n| C:\\  |\n');
    type(nv, 'd');
    expect(m.view.state.doc.toString()).toBe('| p |\n| --- |\n| C:\\d |\n');
  });

  it('CRLF 문서에서도 제자리에 쓴다', () => {
    const m = mount('| a | b |\r\n| --- | --- |\r\n| 1 | 2 |\r\n', { extra: [EditorState.lineSeparator.of('\r\n')] });
    focusCell(m.view, 0, 1, 1);
    type(nested(m.view), '한');
    expect(m.view.state.sliceDoc()).toBe('| a | b |\r\n| --- | --- |\r\n| 1 | 2한 |\r\n');
  });
});

describe('셀 편집기: escape', () => {
  it('친 | 는 \\| 가 되고, 붙여 넣은 줄바꿈은 <br> 이 된다', () => {
    const m = mount(`${T}\n`);
    focusCell(m.view, 0, 1, 0);
    const nv = nested(m.view);
    type(nv, '|');
    expect(nv.state.doc.toString()).toBe('1\\|');
    expect(nv.state.selection.main.head).toBe(3);
    nv.dispatch({ changes: { from: 3, insert: 'p\r\nq\nr' }, selection: { anchor: 8 }, userEvent: 'input.paste' });
    expect(nv.state.doc.toString()).toBe('1\\|p<br>q<br>r');
    expect(nv.state.selection.main.head).toBe(nv.state.doc.length);
    expect(m.view.state.doc.toString()).toBe(`| a | b |\n| --- | --- |\n| 1\\|p<br>q<br>r | 2 |\n`);
    // 셀 수는 그대로다
    expect(cellEl(m.view, 1, 1).textContent).toBe('2');
  });

  it('escape 된 파이프 앞에 백슬래시를 쳐도 칸이 갈라지지 않는다', () => {
    const m = mount('| a |\n| --- |\n| x \\| y |\n');
    focusCell(m.view, 0, 1, 0);
    const nv = nested(m.view);
    nv.dispatch({ selection: { anchor: 2 } });
    type(nv, '\\');
    expect(nv.state.doc.toString()).toBe('x \\\\\\| y');
    expect(m.view.state.doc.toString()).toBe('| a |\n| --- |\n| x \\\\\\| y |\n');
  });

  it('Shift-Enter 는 <br> 을 넣는다', () => {
    const m = mount(`${T}\n`);
    focusCell(m.view, 0, 1, 1);
    expect(key(nested(m.view), 'Enter', { shift: true })).toBe(true);
    expect(nested(m.view).state.doc.toString()).toBe('2<br>');
    expect(m.view.state.doc.toString()).toBe(`| a | b |\n| --- | --- |\n| 1 | 2<br> |\n`);
  });
});

describe('셀 편집기: 되돌리기와 저장', () => {
  it('Mod-z 는 바깥 문서를 되돌려 원문이 정확히 돌아오고, 셀 편집기도 따라온다. Mod-y 는 다시 한다', () => {
    const doc = `앞\n\n${T}\n`;
    const m = mount(doc);
    focusCell(m.view, 3, 1, 1);
    const nv = nested(m.view);
    type(nv, '345');
    expect(m.view.state.doc.toString()).not.toBe(doc);
    expect(key(nv, 'z', { mod: true })).toBe(true);
    expect(m.view.state.doc.toString()).toBe(doc);
    expect(activeCellView(m.view)).toBe(nv);
    expect(nv.state.doc.toString()).toBe('2');
    expect(key(nv, 'y', { mod: true })).toBe(true);
    expect(m.view.state.doc.toString()).toBe(`앞\n\n| a | b |\n| --- | --- |\n| 1 | 2345 |\n`);
    expect(nv.state.doc.toString()).toBe('2345');
    expect(key(nv, 'z', { mod: true, shift: true })).toBe(true); // 다시 하기할 것이 없어도 셀 편집기 기본 동작으로 새지 않는다
  });

  it('Mod-s 는 편집기의 저장을 부른다', () => {
    const m = mount(`${T}\n`);
    focusCell(m.view, 0, 0, 0);
    expect(key(nested(m.view), 's', { mod: true })).toBe(true);
    expect(m.saves).toBe(1);
  });
});

describe('셀 편집기: 키보드 이동', () => {
  it('Tab / Shift-Tab 은 행 순서로 다음·이전 칸, Enter 는 아래 칸', () => {
    const m = mount(`${T}\n`);
    focusCell(m.view, 0, 0, 0);
    key(nested(m.view), 'Tab');
    expect(m.view.state.field(activeCell)).toMatchObject({ r: 0, c: 1 });
    key(nested(m.view), 'Tab');
    expect(m.view.state.field(activeCell)).toMatchObject({ r: 1, c: 0 });
    expect(nested(m.view).state.doc.toString()).toBe('1');
    key(nested(m.view), 'Tab', { shift: true });
    expect(m.view.state.field(activeCell)).toMatchObject({ r: 0, c: 1 });
    key(nested(m.view), 'Enter');
    expect(m.view.state.field(activeCell)).toMatchObject({ r: 1, c: 1 });
    expect(liveCellEditors()).toBe(1);
  });

  it('마지막 칸의 Tab 은 행을 하나 더하고 그리로 간다: 되돌리기 한 번에 행이 빠진다', () => {
    const doc = `${T}\n\n뒤\n`;
    const m = mount(doc);
    focusCell(m.view, 0, 1, 1);
    key(nested(m.view), 'Tab');
    expect(m.view.state.doc.toString()).toBe(`${T}\n|  |  |\n\n뒤\n`);
    expect(m.view.state.field(activeCell)).toMatchObject({ r: 2, c: 0 });
    type(nested(m.view), '새');
    expect(m.view.state.doc.toString()).toBe(`${T}\n| 새 |  |\n\n뒤\n`);
    key(nested(m.view), 'z', { mod: true });
    expect(m.view.state.doc.toString()).toBe(`${T}\n|  |  |\n\n뒤\n`);
    key(nested(m.view), 'z', { mod: true });
    expect(m.view.state.doc.toString()).toBe(doc);
  });

  it('마지막 행의 Enter 는 행을 더하고 같은 열의 새 칸으로 간다', () => {
    const m = mount(`${T}\n`);
    focusCell(m.view, 0, 1, 1);
    key(nested(m.view), 'Enter');
    expect(m.view.state.doc.toString()).toBe(`${T}\n|  |  |\n`);
    expect(m.view.state.field(activeCell)).toMatchObject({ r: 2, c: 1 });
  });

  it('Escape 는 표 뒤로 나가고 셀 편집기를 걷는다', () => {
    const doc = `${T}\n\n뒤`;
    const m = mount(doc);
    const td = cellEl(m.view, 1, 0);
    focusCell(m.view, 0, 1, 0);
    key(nested(m.view), 'Escape');
    expect(liveCellEditors()).toBe(0);
    expect(m.view.state.field(activeCell)).toBeNull();
    expect(m.view.state.selection.main.head).toBe(T.length + 1);
    expect(td.textContent).toBe('1');
    expect(td.classList.contains('lno-cell-active')).toBe(false);
  });

  it('Mod-Enter 는 표 아래에 빈 줄을 두고 새 줄을 만들어 나간다 (되돌리기 한 번)', () => {
    const m = mount(T);
    focusCell(m.view, 0, 1, 0);
    key(nested(m.view), 'Enter', { mod: true });
    expect(m.view.state.doc.toString()).toBe(`${T}\n\n`);
    expect(m.view.state.selection.main.head).toBe(T.length + 2);
    expect(liveCellEditors()).toBe(0);
  });

  it('칸 경계의 화살표는 옆 칸으로 가고, 표 끝에서는 표 밖으로 나간다', () => {
    const doc = `앞\n${'\n'}${T}\n\n뒤`;
    const m = mount(doc);
    const from = doc.indexOf('| a');
    focusCell(m.view, from, 0, 0, 'end');
    key(nested(m.view), 'ArrowRight');
    expect(m.view.state.field(activeCell)).toMatchObject({ r: 0, c: 1 });
    expect(nested(m.view).state.selection.main.head).toBe(0);
    key(nested(m.view), 'ArrowLeft');
    expect(m.view.state.field(activeCell)).toMatchObject({ r: 0, c: 0 });
    key(nested(m.view), 'ArrowDown');
    expect(m.view.state.field(activeCell)).toMatchObject({ r: 1, c: 0 });
    key(nested(m.view), 'ArrowDown');
    expect(liveCellEditors()).toBe(0);
    expect(m.view.state.selection.main.head).toBe(from + T.length + 1);
    focusCell(m.view, from, 0, 1);
    key(nested(m.view), 'ArrowUp');
    expect(liveCellEditors()).toBe(0);
    expect(m.view.state.selection.main.head).toBe(from - 1);
  });

  it('바깥 편집기에서 ArrowDown 으로 표에 들어가면 머리 행의 칸에, ArrowUp 이면 마지막 행의 칸에 든다', () => {
    const doc = `앞\n${T}\n\n뒤`;
    const m = mount(`앞\n\n${T}\n\n뒤`);
    void doc;
    m.view.dispatch({ selection: { anchor: 1 } });
    expect(runScopeHandlers(m.view, new KeyboardEvent('keydown', { key: 'ArrowDown' }), 'editor')).toBe(false); // 다음 줄은 빈 줄
    m.view.dispatch({ selection: { anchor: 2 } });
    expect(runScopeHandlers(m.view, new KeyboardEvent('keydown', { key: 'ArrowDown' }), 'editor')).toBe(true);
    expect(m.view.state.field(activeCell)).toMatchObject({ tableFrom: 3, r: 0, c: 0 });
    key(nested(m.view), 'Escape');
    m.view.dispatch({ selection: { anchor: m.view.state.doc.length - 2 } }); // 표 아래 빈 줄
    expect(runScopeHandlers(m.view, new KeyboardEvent('keydown', { key: 'ArrowUp' }), 'editor')).toBe(true);
    expect(m.view.state.field(activeCell)).toMatchObject({ tableFrom: 3, r: 1, c: 0 });
  });
});

describe('셀 편집기: 밖의 변경', () => {
  it('되돌리기 말고도 밖에서 그 칸을 바꾸면 셀 편집기의 글자가 바뀐다; 다른 곳의 변경은 건드리지 않는다', () => {
    const doc = `앞\n\n${T}\n`;
    const m = mount(doc);
    focusCell(m.view, 3, 1, 0);
    const nv = nested(m.view);
    type(nv, ' ');
    m.view.dispatch({ changes: { from: 0, insert: '더 ' } });
    expect(nv.state.doc.toString()).toBe('1 '); // 칸과 상관없는 변경: 친 공백도 그대로
    expect(m.view.state.field(activeCell)).toEqual({ tableFrom: 5, r: 1, c: 0 });
    const at = m.view.state.doc.toString().indexOf('| 1 |') + 2;
    m.view.dispatch({ changes: { from: at, to: at + 1, insert: '밖' } });
    expect(activeCellView(m.view)).toBe(nv);
    expect(nv.state.doc.toString()).toBe('밖');
    // 위에 행이 들어와도 같은 칸을 따라간다
    const head = m.view.state.doc.toString().indexOf('| 밖');
    m.view.dispatch({ changes: { from: head, insert: '| p | q |\n' } });
    expect(m.view.state.field(activeCell)).toEqual({ tableFrom: 5, r: 2, c: 0 });
    expect(activeCellView(m.view)).toBe(nv);
    expect(cellEl(m.view, 2, 0).contains(nv.dom)).toBe(true);
    expect(cellEl(m.view, 1, 0).textContent).toBe('p');
    type(nv, '!');
    expect(m.view.state.doc.toString()).toBe(`더 앞\n\n| a | b |\n| --- | --- |\n| p | q |\n| 밖! | 2 |\n`);
  });

  it('그 칸의 행이 지워지면 셀 편집기를 걷는다', () => {
    const doc = `${T}\n| 3 | 4 |\n`;
    const m = mount(doc);
    focusCell(m.view, 0, 1, 1);
    const row = doc.indexOf('| 1');
    m.view.dispatch({ changes: { from: row, to: doc.indexOf('| 3') } });
    expect(liveCellEditors()).toBe(0);
    expect(m.view.state.field(activeCell)).toBeNull();
  });

  it('setState(조용한 다시 읽기)는 셀 편집기를 걷고, 그 뒤의 입력은 새 문서에 쓰이지 않는다', () => {
    const m = mount(`${T}\n`);
    focusCell(m.view, 0, 1, 0);
    const nv = nested(m.view);
    const fresh = `| a | b |\n| --- | --- |\n| 새 | 글 |\n`;
    m.view.setState(EditorState.create({ doc: fresh, extensions: [history(), labnoteMarkdown(), tableExtension({ save: () => {}, root: document })] }));
    expect(liveCellEditors()).toBe(0);
    expect(m.view.dom.querySelectorAll('.lno-table .cm-editor')).toHaveLength(0);
    type(nv, 'stale');
    expect(m.view.state.doc.toString()).toBe(fresh);
    expect(m.view.state.field(activeCell)).toBeNull();
  });

  it('위젯이 사라지면(마크다운으로 편집) 셀 편집기도 걷힌다', () => {
    const m = mount(`${T}\n`);
    focusCell(m.view, 0, 1, 0);
    (wrapOf(m.view).querySelector(`button[data-action="editAsMarkdown"]`) as HTMLButtonElement).click();
    expect(liveCellEditors()).toBe(0);
  });
});

describe('셀 편집기: 잠금', () => {
  it('잠그면 셀 편집기가 읽기 전용이 되어 입력이 막히고, 잠긴 격자는 눌러도 열리지 않는다', () => {
    const lock = new Compartment();
    const m = mount(`${T}\n`, { lock });
    focusCell(m.view, 0, 1, 0);
    const nv = nested(m.view);
    m.view.dispatch({ effects: lock.reconfigure(LOCKED) });
    expect(nv.state.readOnly).toBe(true);
    expect(nv.contentDOM.getAttribute('contenteditable')).toBe('false');
    type(nv, 'x');
    expect(m.view.state.doc.toString()).toBe(`${T}\n`);
    expect(nv.state.doc.toString()).toBe('1');
    key(nv, 'Tab');
    key(nv, 'Tab');
    key(nv, 'Tab');
    expect(m.view.state.doc.toString()).toBe(`${T}\n`); // 잠긴 채로는 행도 늘지 않는다
    m.view.dispatch({ effects: lock.reconfigure([]) });
    expect(activeCellView(m.view)!.state.readOnly).toBe(false);

    const locked = mount(`${T}\n`, { locked: true });
    click(cellEl(locked.view, 1, 0));
    expect(activeCellView(locked.view)).toBeNull();
    expect(focusCell(locked.view, 0, 1, 0)).toBe(false);
  });
});

// ---------------------------------------------------------------- 편집기 전체

const P = 'lab/t.labnote.md';

function mountEditor(files: Record<string, string>) {
  const calls: string[] = [];
  const invoke = (async (cmd: string, args: Record<string, unknown>) => {
    calls.push(cmd);
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
  const handlers = new Set<(e: { payload: VaultChange }) => void>();
  const listen = (async (_e: string, h: (e: { payload: VaultChange }) => void) => {
    handlers.add(h);
    return () => handlers.delete(h);
  }) as never;
  const ref = createRef<EditorHandle>();
  const utils = render(<Editor ref={ref} path={P} invoke={invoke} listen={listen} autosaveMs={60_000} />);
  const view = () => {
    const root = (utils.container.querySelector('section > div') as HTMLElement).shadowRoot!;
    return EditorView.findFromDOM(root.querySelector('.cm-editor') as HTMLElement)!;
  };
  const emit = (payload: VaultChange) => act(async () => handlers.forEach((h) => h({ payload })));
  return { files, calls, ref, view, emit, utils, writes: () => calls.filter((c) => c === 'vault_modify').length };
}

describe('셀 편집기: 편집기 안에서', () => {
  it('표는 격자로 그려지고, 칸에서 친 마지막 글자까지 Mod-s 와 flush 가 저장한다', async () => {
    const e = mountEditor({ [P]: `# 노트\n\n${T}\n` });
    await waitFor(() => expect(e.view().state.doc.toString()).toBe(`# 노트\n\n${T}\n`));
    await waitFor(() => expect(e.view().state.readOnly).toBe(false));
    const v = e.view();
    const td = cellEl(v, 1, 1);
    await act(async () => void click(td));
    const nv = nestedIn(td)!;
    expect(nv).not.toBeNull();
    nv.dispatch({ selection: { anchor: nv.state.doc.length } }); // jsdom 에는 레이아웃이 없어 누른 자리를 알 수 없다
    await act(async () => type(nv, '9'));
    await act(async () => void key(nv, 's', { mod: true }));
    await waitFor(() => expect(e.files[P]).toBe(`# 노트\n\n| a | b |\n| --- | --- |\n| 1 | 29 |\n`));
    await act(async () => type(nv, '8'));
    await act(async () => void (await e.ref.current!.flush()));
    expect(e.files[P]).toBe(`# 노트\n\n| a | b |\n| --- | --- |\n| 1 | 298 |\n`);
  });

  it('칸에 포커스가 있는 채로 조용히 다시 읽어도 셀 편집기가 새지 않고 낡은 글자를 쓰지 않는다', async () => {
    const e = mountEditor({ [P]: `${T}\n` });
    await waitFor(() => expect(e.view().state.readOnly).toBe(false));
    const v = e.view();
    await act(async () => void click(cellEl(v, 1, 0)));
    const nv = activeCellView(v)!;
    expect(liveCellEditors()).toBe(1);
    e.files[P] = `| a | b |\n| --- | --- |\n| 밖 | 2 |\n`;
    await e.emit({ path: P, kind: 'modified' });
    await waitFor(() => expect(e.view().state.doc.toString()).toBe(e.files[P]));
    expect(liveCellEditors()).toBe(0);
    await act(async () => type(nv, 'stale'));
    expect(e.view().state.doc.toString()).toBe(`| a | b |\n| --- | --- |\n| 밖 | 2 |\n`);
    await act(async () => void (await e.ref.current!.flush()));
    expect(e.writes()).toBe(0);
    e.utils.unmount();
  });
});
