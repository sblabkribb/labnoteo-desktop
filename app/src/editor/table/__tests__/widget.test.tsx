// @vitest-environment jsdom
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { labnoteMarkdown } from '../../markdownSyntax';
import { editorThemeSpec } from '../../theme';
import { catalogs } from '../../../i18n/t';
import { setLang } from '../../../i18n/lang';
import { findTables, rawTables, tableExtension, tableField, toggleRawTable } from '../field';
import { TableWidget } from '../widget';
import { parseTable } from '../model';
import { displayText, renderInline } from '../renderInline';

// jsdom 에는 레이아웃이 없다. CodeMirror 가 측정에 쓰는 API 만 빈 값으로 채운다.
const emptyRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
Range.prototype.getClientRects ??= emptyRects;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();

const LOCKED = [EditorState.readOnly.of(true), EditorView.editable.of(false)];
const views: EditorView[] = [];

function mount(doc: string, opts: { locked?: boolean; extra?: Extension[]; lock?: Compartment } = {}): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const lock = opts.lock ?? new Compartment();
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
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
  vi.restoreAllMocks();
});

const wraps = (v: EditorView) => Array.from(v.dom.querySelectorAll<HTMLElement>('.lno-table-wrap'));
const cellTexts = (wrap: Element) =>
  Array.from(wrap.querySelectorAll('tr')).map((tr) => Array.from(tr.querySelectorAll('th, td')).map((c) => c.textContent));

const T1 = '| a | b |\n| --- | --- |\n| 1 | 2 |';
const T2 = '| x | y | z |\n| --- | --- | --- |\n| 3 | 4 | 5 |\n| 6 | 7 | 8 |';

describe('표 위젯: 렌더링', () => {
  it('맨 위 표마다 위젯 하나: div.lno-table-wrap > table.lno-table[role=grid], th 와 td[role=gridcell]', () => {
    const v = mount(`# 제목\n\n${T1}\n\n본문\n\n${T2}\n`);
    const ws = wraps(v);
    expect(ws).toHaveLength(2);
    for (const w of ws) {
      const table = w.querySelector(':scope > .lno-table-scroll > table.lno-table');
      expect(table).not.toBeNull();
      expect(table!.getAttribute('role')).toBe('grid');
      for (const td of w.querySelectorAll('td')) expect(td.getAttribute('role')).toBe('gridcell');
    }
    expect(cellTexts(ws[0])).toEqual([['a', 'b'], ['1', '2']]);
    expect(ws[0].querySelectorAll('th')).toHaveLength(2);
    expect(cellTexts(ws[1])).toEqual([['x', 'y', 'z'], ['3', '4', '5'], ['6', '7', '8']]);
    // 표 원문은 줄로 그려지지 않는다
    expect(v.contentDOM.textContent).not.toContain('| --- |');
    expect(v.contentDOM.textContent).toContain('본문');
  });

  it('인용과 목록 안의 표는 원문 그대로다', () => {
    const doc = `> ${T1.split('\n').join('\n> ')}\n\n- ${T1.split('\n').join('\n  ')}\n`;
    const v = mount(doc);
    // 구문 트리에는 표가 있다: 제외 규칙이 실제로 일한다
    let tables = 0;
    syntaxTree(v.state).iterate({ enter: (n) => void (n.name === 'Table' && tables++) });
    expect(tables).toBe(2);
    expect(wraps(v)).toHaveLength(0);
    expect(findTables(v.state)).toEqual([]);
    expect(v.contentDOM.textContent).toContain('| --- | --- |');
  });

  it('위젯은 표의 줄 전체를 덮는다: 줄 시작부터 마지막 행의 줄 끝까지', () => {
    const doc = `앞\n\n${T1}\n뒤에 붙은 행\n\n끝`;
    const v = mount(doc);
    const [t] = findTables(v.state);
    expect(t.from).toBe(doc.indexOf('| a'));
    // Lezer 와 GFM 은 빈 줄 전까지 이어진 줄을 표의 행으로 본다
    expect(t.to).toBe(doc.indexOf('\n\n끝'));
    expect(cellTexts(wraps(v)[0])).toEqual([['a', 'b'], ['1', '2'], ['뒤에 붙은 행', '']]);
  });

  it('정렬은 클래스로: lno-al-left|center|right, 정렬 없음은 클래스 없음, style 속성은 없다', () => {
    const v = mount('| l | c | r | n |\n| :-- | :-: | --: | --- |\n| 1 | 2 | 3 | 4 |\n');
    const [w] = wraps(v);
    const head = Array.from(w.querySelectorAll('th'));
    const body = Array.from(w.querySelectorAll('td'));
    for (const row of [head, body]) {
      expect(row[0].classList.contains('lno-al-left')).toBe(true);
      expect(row[1].classList.contains('lno-al-center')).toBe(true);
      expect(row[2].classList.contains('lno-al-right')).toBe(true);
      expect([...row[3].classList].filter((c) => c.startsWith('lno-al-'))).toEqual([]);
    }
    expect(w.querySelector('[style]')).toBeNull();
  });

  it('짧은 행의 빠진 셀은 빈 가상 셀, 넘치는 셀은 lno-cell-overflow 로 보인다 (지우지 않는다)', () => {
    const v = mount('| a | b |\n| --- | --- |\n| 1 |\n| 1 | 2 | 3 |\n');
    const [w] = wraps(v);
    expect(cellTexts(w)).toEqual([['a', 'b'], ['1', ''], ['1', '2', '3']]);
    const tds = w.querySelectorAll('tr')[1].querySelectorAll('td');
    expect(tds[1].classList.contains('lno-cell-virtual')).toBe(true);
    const over = w.querySelectorAll('tr')[2].querySelectorAll('td')[2];
    expect(over.classList.contains('lno-cell-overflow')).toBe(true);
    expect(over.getAttribute('title')).toBe(catalogs.ko['table.overflow']);
  });

  it('넘치는 셀의 title 도 언어를 바꾼 뒤 표에 들어오면 새 언어로 바뀐다', () => {
    setLang('ko');
    const v = mount('| a | b |\n| --- | --- |\n| 1 | 2 | 3 |\n');
    const [w] = wraps(v);
    const over = w.querySelector('.lno-cell-overflow')!;
    expect(over.getAttribute('title')).toBe(catalogs.ko['table.overflow']);
    setLang('en');
    w.dispatchEvent(new Event('pointerenter'));
    expect(over.getAttribute('title')).toBe(catalogs.en['table.overflow']);
    setLang('ko');
    w.dispatchEvent(new Event('focusin'));
    expect(over.getAttribute('title')).toBe(catalogs.ko['table.overflow']);
  });

  it('CRLF 문서에서도 셀이 맞다', () => {
    const v = mount('앞\r\n\r\n| a | b |\r\n| --- | --- |\r\n| 1 | 2 |\r\n', { extra: [EditorState.lineSeparator.of('\r\n')] });
    expect(cellTexts(wraps(v)[0])).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('셀 글자는 DOM 노드로만 그린다: <img onerror> 와 <script> 는 글자로 보인다', () => {
    const v = mount('| a | b |\n| --- | --- |\n| <img src=x onerror=alert(1)> | <script>alert(2)</script> |\n');
    const [w] = wraps(v);
    expect(w.querySelector('img')).toBeNull();
    expect(w.querySelector('script')).toBeNull();
    expect(w.querySelector('[onerror]')).toBeNull();
    expect(cellTexts(w)[1]).toEqual(['<img src=x onerror=alert(1)>', '<script>alert(2)</script>']);
  });

  it('estimatedHeight 는 행 수에 비례하는 양수다', () => {
    const v = mount(`${T2}\n`);
    const deco = v.state.field(tableField);
    const it = deco.iter();
    const w = it.value!.spec.widget as TableWidget;
    expect(w).toBeInstanceOf(TableWidget);
    expect(w.estimatedHeight).toBeGreaterThan(0);
    const small = new TableWidget(T1, parseTable(T1, 0, T1.length)!, true);
    expect(w.estimatedHeight).toBeGreaterThan(small.estimatedHeight);
    expect(w.ignoreEvent()).toBe(true);
  });
});

describe('셀 안의 인라인 마크다운', () => {
  const render = (text: string) => {
    const host = document.createElement('div');
    renderInline(text, host);
    return host;
  };

  it('코드, 굵게, 기울임, 취소선, 링크, <br>, escape 한 파이프', () => {
    // 셀 글자에는 escape 안 된 파이프가 없다(모델이 거기서 나눈다): 코드 스팬 안의 파이프도 백슬래시를 앞에 두고 적혀 있다
    const h = render('`c\\|d` **b** *e* ~~s~~ [label](http://x) a<br>b \\| q');
    expect(h.querySelector('code')!.textContent).toBe('c|d');
    expect(h.querySelector('strong')!.textContent).toBe('b');
    expect(h.querySelector('em')!.textContent).toBe('e');
    expect(h.querySelector('s')!.textContent).toBe('s');
    const link = h.querySelector('.lno-table-link')!;
    expect(link.textContent).toBe('label');
    expect(link.getAttribute('title')).toBe('http://x');
    expect(link.getAttribute('href')).toBeNull(); // 읽기 전용 그림: 클릭해서 어디로도 가지 않는다
    expect(h.querySelectorAll('br')).toHaveLength(1);
    expect(h.textContent).toBe('c|d b e s label ab | q');
  });

  it('줄 맨 앞의 #, -, > 도 블록이 아니라 글자다', () => {
    expect(render('# x').textContent).toBe('# x');
    expect(render('- x').textContent).toBe('- x');
    expect(render('> x').textContent).toBe('> x');
    expect(render('1. x').textContent).toBe('1. x');
  });

  it('끝 백슬래시를 지키는 escape 공백은 정확히 하나만 떼고 보인다', () => {
    expect(displayText('C:\\ ')).toBe('C:\\');
    expect(displayText('a\\\\\\ ')).toBe('a\\\\\\');
    // 백슬래시가 짝수면 escape 공백이 아니다(셀 내용 끝에 공백이 올 수 없으니 그대로 둔다)
    expect(displayText('a\\\\ ')).toBe('a\\\\ ');
    expect(displayText('a ')).toBe('a ');
    expect(render('C:\\ ').textContent).toBe('C:\\');
  });

  it('위젯 셀에서도 escape 공백이 사라진다', () => {
    const v = mount('| p |\n| --- |\n| C:\\  |\n');
    expect(cellTexts(wraps(v)[0])).toEqual([['p'], ['C:\\']]);
  });
});

describe('표 위젯: 갱신', () => {
  it('표와 상관없는 글자가 바뀌면 DOM 을 다시 만들지 않는다 (eq)', () => {
    const v = mount(`앞\n\n${T1}\n`);
    const before = wraps(v)[0];
    const toDOM = vi.spyOn(TableWidget.prototype, 'toDOM');
    const updateDOM = vi.spyOn(TableWidget.prototype, 'updateDOM');
    v.dispatch({ changes: { from: 0, insert: '더 ' } });
    v.dispatch({ changes: { from: v.state.doc.length, insert: '\n뒤' } });
    expect(wraps(v)[0]).toBe(before);
    expect(toDOM).not.toHaveBeenCalled();
    expect(updateDOM).not.toHaveBeenCalled();
  });

  it('셀 글자가 바뀌면 같은 DOM 을 고쳐 쓴다 (updateDOM): 바뀐 셀만 새로 그린다', () => {
    const doc = `${T1}\n`;
    const v = mount(doc);
    const before = wraps(v)[0];
    const keep = before.querySelectorAll('td')[1];
    const keepText = keep.firstChild;
    const toDOM = vi.spyOn(TableWidget.prototype, 'toDOM');
    const at = doc.indexOf('1 |');
    v.dispatch({ changes: { from: at, to: at + 1, insert: '**새**' } });
    expect(toDOM).not.toHaveBeenCalled();
    const after = wraps(v)[0];
    expect(after).toBe(before);
    expect(cellTexts(after)).toEqual([['a', 'b'], ['새', '2']]);
    expect(after.querySelector('td strong')!.textContent).toBe('새');
    // 바뀌지 않은 셀은 손대지 않는다
    expect(after.querySelectorAll('td')[1]).toBe(keep);
    expect(keep.firstChild).toBe(keepText);
  });

  it('행이 늘면 같은 틀 안에서 표를 다시 그린다', () => {
    const doc = `${T1}\n`;
    const v = mount(doc);
    const before = wraps(v)[0];
    v.dispatch({ changes: { from: doc.length - 1, insert: '\n| 3 | 4 |' } });
    expect(wraps(v)[0]).toBe(before);
    expect(cellTexts(before)).toEqual([['a', 'b'], ['1', '2'], ['3', '4']]);
  });
});

describe('표 위젯: 도구 막대와 원문 편집', () => {
  const button = (w: Element, key: string) =>
    Array.from(w.querySelectorAll('button')).find((b) => b.getAttribute('aria-label') === catalogs.ko[key]) as HTMLButtonElement | undefined;

  it('도구 막대는 진짜 <button> 이고 이름표는 t() 를 거친다 (ko 와 en)', () => {
    const v = mount(`${T1}\n`);
    const [w] = wraps(v);
    const bar = w.querySelector('.lno-table-toolbar')!;
    expect(bar).not.toBeNull();
    expect(bar.getAttribute('role')).toBe('toolbar');
    expect(bar.getAttribute('aria-label')).toBe(catalogs.ko['table.toolbar']);
    const buttons = Array.from(bar.querySelectorAll('button'));
    expect(buttons.length).toBeGreaterThanOrEqual(3);
    for (const b of buttons) {
      expect(b.type).toBe('button');
      const label = b.getAttribute('aria-label')!;
      expect(Object.values(catalogs.ko)).toContain(label);
    }
    expect(button(w, 'table.editAsMarkdown')).toBeDefined();
    // 언어를 바꾸면 다음에 막대를 열 때(포인터가 들어오거나 포커스가 들어올 때) 이름표가 바뀐다
    setLang('en');
    w.dispatchEvent(new Event('pointerenter'));
    expect(bar.getAttribute('aria-label')).toBe(catalogs.en['table.toolbar']);
    for (const b of bar.querySelectorAll('button')) expect(Object.values(catalogs.en)).toContain(b.getAttribute('aria-label'));
  });

  it('잠긴 편집기는 격자만 보이고 도구 막대가 없다; 잠금을 풀면 생긴다', () => {
    const lock = new Compartment();
    const v = mount(`${T1}\n`, { locked: true, lock });
    const [w] = wraps(v);
    expect(w.querySelector('.lno-table-toolbar')).toBeNull();
    expect(w.querySelectorAll('button')).toHaveLength(0);
    expect(cellTexts(w)).toEqual([['a', 'b'], ['1', '2']]);
    v.dispatch({ effects: lock.reconfigure([]) });
    expect(wraps(v)[0].querySelector('.lno-table-toolbar')).not.toBeNull();
    v.dispatch({ effects: lock.reconfigure(LOCKED) });
    expect(wraps(v)[0].querySelector('.lno-table-toolbar')).toBeNull();
  });

  it('"마크다운으로 편집" 은 그 표를 원문으로 돌리고, 선택이 표를 떠나면 격자로 돌아온다', () => {
    const doc = `앞\n\n${T1}\n\n${T2}\n\n뒤`;
    const v = mount(doc);
    const from = doc.indexOf('| a');
    button(wraps(v)[0], 'table.editAsMarkdown')!.click();
    expect(v.state.field(rawTables).size).toBe(1);
    expect(wraps(v)).toHaveLength(1); // 두 번째 표만 격자
    expect(v.contentDOM.textContent).toContain('| a | b |');
    expect(v.state.selection.main.head).toBe(from);
    // 원문 표 안에서 움직이고 고쳐도 원문 그대로다
    v.dispatch({ selection: { anchor: from + 3 } });
    v.dispatch({ changes: { from: from + 2, insert: 'q' }, selection: { anchor: from + 3 } });
    expect(wraps(v)).toHaveLength(1);
    // 표 밖으로 나가면 격자
    v.dispatch({ selection: { anchor: 0 } });
    expect(v.state.field(rawTables).size).toBe(0);
    expect(wraps(v)).toHaveLength(2);
    expect(cellTexts(wraps(v)[0])[0]).toEqual(['qa', 'b']);
  });

  it('효과를 다시 보내면 원문 표시가 꺼진다; 표 앞에 글자가 들어가도 표시는 표를 따라간다', () => {
    const doc = `앞\n\n${T1}\n`;
    const v = mount(doc);
    const from = doc.indexOf('| a');
    v.dispatch({ effects: toggleRawTable.of(from), selection: { anchor: from } });
    expect(wraps(v)).toHaveLength(0);
    v.dispatch({ changes: { from: 0, insert: '더 ' } });
    expect(v.state.field(rawTables).iter().from).toBe(from + 2);
    expect(wraps(v)).toHaveLength(0);
    v.dispatch({ effects: toggleRawTable.of(from + 2) });
    expect(wraps(v)).toHaveLength(1);
  });

  it('원문 표시를 켜는 트랜잭션의 선택이 표 밖이어도 그 트랜잭션에서는 꺼지지 않는다', () => {
    const doc = `앞\n\n${T1}\n`;
    const v = mount(doc);
    const from = doc.indexOf('| a');
    v.dispatch({ effects: toggleRawTable.of(from), selection: { anchor: 0 } });
    expect(v.state.field(rawTables).size).toBe(1);
    expect(wraps(v)).toHaveLength(0);
    // 다음 선택 변경에서 머리가 밖이면 격자로 돌아온다
    v.dispatch({ selection: { anchor: 1 } });
    expect(v.state.field(rawTables).size).toBe(0);
    expect(wraps(v)).toHaveLength(1);
  });

  it('원문 표시 중 첫 줄 앞에서 Enter 를 쳐도 원문으로 남는다', () => {
    const doc = `앞\n\n${T1}\n`;
    const v = mount(doc);
    const from = doc.indexOf('| a');
    v.dispatch({ effects: toggleRawTable.of(from), selection: { anchor: from } });
    v.dispatch({ changes: { from, insert: '\n' }, selection: { anchor: from + 1 } });
    expect(v.state.field(rawTables).size).toBe(1);
    expect(wraps(v)).toHaveLength(0);
    v.dispatch({ selection: { anchor: from + 4 } });
    expect(wraps(v)).toHaveLength(0);
    // 표 밖으로 나가면 격자
    v.dispatch({ selection: { anchor: 0 } });
    expect(v.state.field(rawTables).size).toBe(0);
    expect(wraps(v)).toHaveLength(1);
  });

  it('원문 표시 중 구분 줄을 지웠다 다시 쳐도, 선택이 표 안이면 원문으로 남는다', () => {
    const doc = `앞\n\n${T1}\n\n뒤`;
    const v = mount(doc);
    const from = doc.indexOf('| a');
    const dash = doc.indexOf('---', from);
    v.dispatch({ effects: toggleRawTable.of(from), selection: { anchor: from } });
    // 첫 칸의 `---` 를 지워 잠깐 표가 아니게 된다
    v.dispatch({ changes: { from: dash, to: dash + 3 }, selection: { anchor: dash } });
    expect(findTables(v.state)).toHaveLength(0);
    expect(v.state.field(rawTables).size).toBe(1);
    // `:--` 로 다시 친다
    v.dispatch({ changes: { from: dash, insert: ':--' }, selection: { anchor: dash + 3 } });
    expect(findTables(v.state)).toHaveLength(1);
    expect(v.state.field(rawTables).size).toBe(1);
    expect(wraps(v)).toHaveLength(0);
    // 표 밖으로 나가면 격자로 돌아오고 정렬이 반영된다
    v.dispatch({ selection: { anchor: v.state.doc.length } });
    expect(v.state.field(rawTables).size).toBe(0);
    expect(wraps(v)).toHaveLength(1);
    expect(cellTexts(wraps(v)[0])).toEqual([['a', 'b'], ['1', '2']]);
  });
});

describe('테마', () => {
  it('lno-table 규칙은 editorThemeSpec 에 있다 (그림자 루트 안에서 걸린다)', () => {
    const keys = Object.keys(editorThemeSpec);
    for (const k of ['.lno-table-wrap', '.lno-table', '.lno-table-toolbar', '.lno-al-center', '.lno-al-right', '.lno-cell-overflow'])
      expect(keys.some((key) => key.includes(k)), k).toBe(true);
  });

  it('가로 스크롤은 표만 감싼 안쪽 틀이 맡는다: 바깥 틀은 넘침을 자르지 않아 메뉴가 표 밖으로 펼쳐진다', () => {
    const spec = editorThemeSpec as Record<string, Record<string, unknown>>;
    const wrap = spec['.lno-table-wrap'];
    // overflow-x 가 auto 이면 overflow-y 도 auto 로 계산되어 메뉴가 표 틀에 잘린다
    for (const k of ['overflow', 'overflowX', 'overflowY']) expect(wrap[k] ?? 'visible', k).toBe('visible');
    expect(spec['.lno-table-scroll']?.overflowX).toBe('auto');
    const v = mount(`${T1}\n`);
    const w = wraps(v)[0];
    const scroll = w.querySelector(':scope > .lno-table-scroll')!;
    expect(Array.from(scroll.children).map((c) => c.className)).toEqual(['lno-table']);
  });
});
