// @vitest-environment jsdom
import { Compartment, EditorState, Prec, Transaction, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { history, historyKeymap, undo } from '@codemirror/commands';
import { labnoteMarkdown } from '../../markdownSyntax';
import { tableExtension } from '../../table/field';
import { livePreview } from '../index';
import { getMode, setMode } from '../mode';
import {
  addPropertyCommand,
  editYaml,
  editYamlCommand,
  focusGridLast,
  frontBlock,
  PropertiesWidget,
  propertiesActions,
  rawFront,
} from '../properties';
import type { PickItem } from '@labnoteo/core';
import { setLang } from '../../../i18n/lang';
import type { CommandContext } from '../../../labnote/commands/context';
import { clearCommandsForTest } from '../../../labnote/commands/registry';
import { openPalette } from '../../../labnote/ui/CommandPalette';
import { appCommands, clearAppCommandsForTest, registerAllAppCommands } from '../../commands/appCommands';
import { t } from '../../../i18n/t';
import { insertDate } from '../../../labnote/commands/editorInserts';
import { formatExtensions } from '../../commands/formatCommands';
import { tableOptions } from '../../table/field';

// jsdom 에는 레이아웃이 없다. CodeMirror 가 측정에 쓰는 API 만 빈 값으로 채운다.
const emptyRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
Range.prototype.getClientRects ??= emptyRects;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();
document.execCommand ??= () => false;

const views: EditorView[] = [];

interface Opts {
  lineSeparator?: string;
  extensions?: Extension[];
}

/** 편집기(Editor.tsx 처럼 모드가 'live' 일 때만 라이브 미리보기와 표 확장을 싣는다). */
function view(doc: string, pos: number, opts: Opts = {}): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const extra: Extension[] = [];
  if (opts.lineSeparator) extra.push(EditorState.lineSeparator.of(opts.lineSeparator));
  if (opts.extensions) extra.push(...opts.extensions);
  const start = EditorState.create({
    doc,
    extensions: [
      history(),
      keymap.of(historyKeymap),
      labnoteMarkdown(),
      getMode() === 'live' ? [livePreview(), tableExtension({ save: () => {}, root: document })] : [],
      ...extra,
    ],
  });
  // 줄 구분자가 CRLF 이면 문서는 문자열보다 짧다: 위치는 문서 길이로 자른다
  const state = start.update({ selection: { anchor: Math.min(pos, start.doc.length) } }).state;
  const v = new EditorView({ parent, state });
  views.push(v);
  return v;
}

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    // 저장소가 없어도 모드는 메모리에 산다
  }
  setMode('live');
});

afterEach(() => {
  while (views.length) views.pop()!.destroy();
  document.body.innerHTML = '';
});

const lineEl = (v: EditorView, n: number) => v.contentDOM.querySelectorAll<HTMLElement>('.cm-line')[n - 1];
const visibleText = (v: EditorView, n: number) => lineEl(v, n)?.textContent;
const move = (v: EditorView, pos: number) => v.dispatch({ selection: { anchor: pos } });
/** 칸(키·값)에 보이는 글: 입력이면 그 값, 아니면 글. */
const valueText = (el: Element | null) => (el instanceof HTMLInputElement ? el.value : (el?.textContent ?? ''));
const rows = (v: EditorView): [string, string][] =>
  [...v.contentDOM.querySelectorAll('.lno-props-row')].map((r) => [
    valueText(r.querySelector('.lno-props-key')),
    valueText(r.querySelector('.lno-props-value')),
  ]);
const click = (el: Element) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
function press(v: EditorView, init: KeyboardEventInit) {
  v.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
}

describe('라이브 미리보기: 속성(front matter) 격자', () => {
  it('renders one row per key, in file order', () => {
    const v = view('---\ntitle: a\nstatus: Planned\nlast_updated_date: 2026-11-01\n---\nx', 64);
    expect(rows(v).map(([k]) => k)).toEqual(['제목', '상태', '마지막 수정']);
    expect(rows(v)[1][1]).toBe('계획'); // 저장 값 Planned 를 지역화해 보인다
  });

  it('renders Korean, spaced and quoted keys', () => {
    expect(rows(view('---\n담당자: 이서연\nsample id: 1\n"a.b": 2\n---\nx', 40)).map(([k]) => k)).toEqual(['담당자', 'sample id', 'a.b']);
  });

  it('keeps file order for integer-like keys', () => {
    expect(rows(view('---\nb: 1\n2: x\n---\nx', 16)).map(([k]) => k)).toEqual(['b', '2']);
  });

  it.each(['---\na: 1\n...\nx', '---\na: 1\n', '---\na: [1\n---\nx', '---\na: 1\na: 2\n---\nx'])(
    'falls back to raw for unclosed, dot-closed, invalid and duplicate-key YAML (%#)',
    (doc) => {
      const v = view(doc, doc.length);
      expect(v.contentDOM.querySelector('.lno-props')).toBeNull();
      expect(visibleText(v, 1)).toBe('---');
    },
  );

  it('a nested map row is read-only with Edit as YAML', () => {
    // 줄 배열로 쓴다: 'a:' 뒤의 백슬래시는 escapes.test.ts 가 드라이브 경로로 본다
    const v = view(['---', 'a:', '  b: 1', '---', 'x'].join('\n'), 19);
    expect(v.contentDOM.querySelector('.lno-props-row input')).toBeNull();
    expect(v.contentDOM.querySelector(`.lno-props-row button[aria-label="${t('props.editYaml')}"]`)).not.toBeNull();
  });

  it('lists, wikilinks and last_updated_date get their cell kinds', () => {
    const s = EditorState.create({
      doc: ['---', 'tags:', '  - a', '  - b', 'author: [[이서연]]', 'last_updated_date: 2026-11-01', '---', 'x'].join('\n'),
      extensions: [labnoteMarkdown()],
    });
    const block = frontBlock(s)!;
    expect(block.entries.map((e) => [e.key, e.cell, e.line])).toEqual([
      ['tags', 'list', 1],
      ['author', 'wikilink', 4],
      ['last_updated_date', 'readOnly', 5],
    ]);
    const v = view(s.doc.toString(), s.doc.length);
    expect(rows(v)).toEqual([
      ['태그', 'a, b'],
      ['실험자', '이서연'],
      ['마지막 수정', '2026-11-01'],
    ]);
  });

  it('a CRLF front matter still renders the grid', () => {
    expect(view('---\r\na: 1\r\n---\r\nx', 17, { lineSeparator: '\r\n' }).contentDOM.querySelector('.lno-props')).not.toBeNull();
  });

  it('mixed-EOL front matter stays raw', () => {
    expect(view('---\r\na: 1\r\n---\nx', 16, { lineSeparator: '\n' }).contentDOM.querySelector('.lno-props')).toBeNull();
  });

  it('the empty block shows an empty grid', () => expect(view('---\n---\nx', 9).contentDOM.querySelector('.lno-props')).not.toBeNull());

  it('"Edit as YAML" shows raw; moving the cursor below hides it again', () => {
    const v = view('---\na: 1\n---\nx', 14);
    click(v.contentDOM.querySelector(`button[aria-label="${t('props.editYaml')}"]`)!);
    move(v, 4);
    expect(visibleText(v, 2)).toBe('a: 1');
    move(v, 14);
    expect(v.contentDOM.querySelector('.lno-props')).not.toBeNull();
  });

  it('source mode shows raw front matter', () => {
    setMode('source');
    expect(view('---\na: 1\n---\nx', 14).contentDOM.querySelector('.lno-props')).toBeNull();
  });

  it('does not overlap a table that starts right after the block', () => {
    const v = view('---\na: 1\n---\n| a |\n| - |\n| 1 |\n', 0);
    expect(v.contentDOM.querySelector('.lno-props')).not.toBeNull();
    expect(v.contentDOM.querySelector('.lno-table-wrap')).not.toBeNull();
  });

  it('Ctrl+Home then typing does not touch the front matter', () => {
    const v = view('---\na: 1\n---\nx', 14);
    press(v, { key: 'Home', ctrlKey: true });
    v.dispatch(v.state.replaceSelection('y'), { userEvent: 'input.type' });
    expect(v.state.doc.toString()).toBe('---\na: 1\n---\nyx');
    v.dispatch({ changes: { from: 0, insert: 'z' }, userEvent: 'input.type' });
    expect(v.state.doc.toString().startsWith('---\na: 1\n---\n')).toBe(true);
    v.dispatch({ selection: { anchor: 13 } });
    v.dispatch({ changes: { from: 12, to: 13 }, userEvent: 'delete.backward' });
    expect(v.state.doc.toString().startsWith('---\na: 1\n---\n')).toBe(true);
  });

  it('typing at the end of a note that is only front matter adds a line break first', () => {
    const v = view('---\na: 1\n---', 12);
    v.dispatch({ changes: { from: 12, insert: 'y' }, selection: { anchor: 13 }, userEvent: 'input.type' });
    expect(v.state.doc.toString()).toBe('---\na: 1\n---\ny');
    expect(v.state.selection.main.head).toBe(14);
  });

  it('the guard lets programmatic and labnote command edits through', () => {
    const v = view('---\na: 1\n---\nx', 14);
    v.dispatch({ changes: { from: 4, to: 8, insert: 'a: 2' } });
    expect(v.state.doc.toString()).toBe('---\na: 2\n---\nx');
    v.dispatch({ changes: { from: 4, to: 8, insert: 'a: 3' }, userEvent: 'input.labnote' });
    expect(v.state.doc.toString()).toBe('---\na: 3\n---\nx');
  });

  it('SP2 insert-date into front matter works in raw mode', () => {
    // 계획의 'a: 1' 은 날짜 키가 아니라 planDateInsertion 이 거절한다: 비어 있는 날짜 키(end_date)로 같은 길을 잰다.
    const original = ['---', 'end_date:', '---', 'x'].join('\n');
    const v = view(original, original.length);
    v.dispatch({ effects: editYaml.of(true), selection: { anchor: 13 } });
    expect(v.contentDOM.querySelector('.lno-props')).toBeNull();
    const notify = vi.fn();
    const ctx = {
      host: { notify, t: (s: string) => s },
      settings: { customSampleTypes: [] },
      activePath: () => 'a.labnote.md',
      activeView: () => v,
    };
    expect(insertDate(ctx as never, () => '2026-11-07')).toBe(true);
    expect(notify).not.toHaveBeenCalled();
    expect(v.state.doc.toString()).toMatch(/^---\nend_date: '?2026-11-07'?\n---\nx$/);
    undo(v);
    expect(v.state.doc.toString()).toBe(original);
  });

  it('a compose that makes an invalid block valid keeps it raw, and the next compose update applies', () => {
    const v = view('---\na: 1\na: 2\n---\nx', 9);
    expect(v.contentDOM.querySelector('.lno-props')).toBeNull();
    v.dispatch({ changes: { from: 9, to: 10 }, userEvent: 'delete.forward' });
    v.dispatch({ changes: { from: 9, insert: 'ㄱ' }, selection: { anchor: 10 }, userEvent: 'input.type.compose' });
    expect(v.state.doc.toString()).toBe('---\na: 1\nㄱ: 2\n---\nx');
    expect(v.state.field(rawFront)).toBe(true);
    expect(v.contentDOM.querySelector('.lno-props')).toBeNull();
    v.dispatch({ changes: { from: 9, to: 10, insert: '가' }, selection: { anchor: 10 }, userEvent: 'input.type.compose' });
    expect(v.state.doc.toString()).toBe('---\na: 1\n가: 2\n---\nx');
    v.dispatch({ changes: { from: 10, insert: 'b' }, selection: { anchor: 11 }, userEvent: 'input.type' });
    expect(v.state.doc.toString()).toBe('---\na: 1\n가b: 2\n---\nx');
    move(v, v.state.doc.length);
    expect(v.contentDOM.querySelector('.lno-props')).not.toBeNull();
  });

  it('an IME keydown at the left edge of the grid moves the cursor into the body first', () => {
    const v = view('---\na: 1\n---\nx', 0);
    expect(v.contentDOM.querySelector('.lno-props')).not.toBeNull();
    press(v, { key: 'Process', keyCode: 229 });
    expect(v.state.selection.main.head).toBe(13);
  });

  it('select-all then typing replaces the body and keeps the front matter', () => {
    const v = view('---\na: 1\n---\nxyz', 16);
    v.dispatch({ selection: { anchor: 0, head: 16 } });
    v.dispatch(v.state.replaceSelection('q'), { userEvent: 'input.type' });
    expect(v.state.doc.toString()).toBe('---\na: 1\n---\nq');
    expect(v.state.selection.main.head).toBe(14);
    v.dispatch({ selection: { anchor: 0, head: 14 } });
    v.dispatch({ changes: { from: 0, to: 14 }, userEvent: 'delete.backward' });
    expect(v.state.doc.toString()).toBe('---\na: 1\n---\n');
  });

  it('a moved input keeps its history annotations', () => {
    const v = view('---\na: 1\n---\nx', 14);
    v.dispatch({ changes: { from: 0, insert: 'z' }, userEvent: 'input.type', annotations: Transaction.addToHistory.of(false) });
    expect(v.state.doc.toString()).toBe('---\na: 1\n---\nzx');
    expect(undo(v)).toBe(false);
  });

  it('PropertiesWidget.eq compares the block text and ignores events', () => {
    const s = EditorState.create({ doc: '---\na: 1\n---\nx', extensions: [labnoteMarkdown()] });
    const b = frontBlock(s)!;
    expect(b).toMatchObject({ from: 0, to: 12, text: '---\na: 1\n---' });
    const w = new PropertiesWidget(b);
    expect(w.eq(new PropertiesWidget({ ...b }))).toBe(true);
    expect(w.eq(new PropertiesWidget({ ...b, text: '---\na: 2\n---' }))).toBe(false);
    expect(w.ignoreEvent()).toBe(true);
    expect(w.estimatedHeight).toBeGreaterThan(0);
  });
});

describe('라이브 미리보기: 속성 격자 고치기', () => {
  const original = '---\ntitle: a\nstatus: Planned\nlast_updated_date: 2026-11-01\n---\nx';
  const rowEl = (v: EditorView, key: string) =>
    [...v.contentDOM.querySelectorAll<HTMLElement>('.lno-props-row')].find((r) => r.dataset.key === key)!;
  /** The value input of a row. A wikilink cell shows links until it is opened for editing (Enter on its links, SP4 Task 13). */
  const valueInput = (v: EditorView, key: string) => {
    const links = rowEl(v, key).querySelector<HTMLElement>('.lno-prop-links');
    if (links) links.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    return rowEl(v, key).querySelector<HTMLInputElement>('input.lno-props-value')!;
  };
  const keyInput = (v: EditorView, key: string) => rowEl(v, key).querySelector<HTMLInputElement>('input.lno-props-key')!;
  const enter = (el: Element, init: KeyboardEventInit = {}) =>
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init }));

  it('commits a value on Enter as one undo step with userEvent input.properties', () => {
    const v = view(original, original.length);
    const input = valueInput(v, 'title');
    input.focus();
    input.value = 'b';
    enter(input);
    expect(v.state.doc.toString()).toBe(original.replace('title: a', 'title: b'));
    expect(document.activeElement).toBe(input); // 같은 키들이면 격자는 제자리에서 값만 바꾼다
    undo(v);
    expect(v.state.doc.toString()).toBe(original);
  });

  it('does not commit while the input is composing; commits on Enter after compositionend', () => {
    const v = view(original, original.length);
    const input = valueInput(v, 'title');
    input.focus();
    input.dispatchEvent(new CompositionEvent('compositionstart'));
    input.value = '한';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, keyCode: 229, bubbles: true }));
    expect(v.state.doc.toString()).toBe(original);
    input.dispatchEvent(new FocusEvent('blur')); // 조합 중의 blur 도 적지 않는다
    expect(v.state.doc.toString()).toBe(original);
    input.dispatchEvent(new CompositionEvent('compositionend'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(v.state.doc.toString()).toBe(original.replace('title: a', 'title: 한'));
  });

  it('Escape reverts the input; blur commits', () => {
    const v = view(original, original.length);
    const input = valueInput(v, 'title');
    input.value = 'zz';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(input.value).toBe('a');
    expect(v.state.doc.toString()).toBe(original);
    input.value = 'c';
    input.dispatchEvent(new FocusEvent('blur'));
    expect(v.state.doc.toString()).toBe(original.replace('title: a', 'title: c'));
  });

  it('renames a key from its key input and keeps the value', () => {
    // a key the card does not localise (localised ones such as title are renamed in Edit as YAML)
    const doc = original.replace('title: a', 'note: a');
    const v = view(doc, doc.length);
    const input = keyInput(v, 'note');
    input.value = '메모';
    enter(input);
    expect(v.state.doc.toString()).toBe(doc.replace('note: a', '메모: a'));
    expect(rows(v).map(([k]) => k)).toEqual(['메모', '상태', '마지막 수정']);
    const taken = keyInput(v, '메모');
    taken.value = 'status';
    enter(taken);
    expect(v.state.doc.toString()).toBe(doc.replace('note: a', '메모: a'));
    expect(taken.value).toBe('메모'); // 받지 않은 이름은 되돌린다
  });

  it('the add button with an empty key focuses the key input instead of failing', () => {
    const v = view('---\na: 1\n---\nx', 14);
    const key = v.contentDOM.querySelector<HTMLInputElement>(`.lno-props input[aria-label="${t('props.add')}"]`)!;
    const btn = v.contentDOM.querySelector<HTMLButtonElement>('.lno-props-add-btn')!;
    btn.focus();
    btn.click();
    expect(document.activeElement).toBe(key);
    expect(key.hasAttribute('aria-invalid')).toBe(false);
    expect(v.state.doc.toString()).toBe('---\na: 1\n---\nx');
  });
  it('a printable key pressed on a grid button is swallowed, so it cannot land in another input', () => {
    const v = view('---\na: 1\n---\nx', 14);
    for (const btn of v.contentDOM.querySelectorAll<HTMLButtonElement>('.lno-props button')) {
      const ev = new KeyboardEvent('keydown', { key: '온', bubbles: true, cancelable: true });
      btn.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(true);
      const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
      btn.dispatchEvent(enter);
      expect(enter.defaultPrevented).toBe(false);
    }
  });
  it('removes a row and adds one from the add row', () => {
    const v = view(original, original.length);
    click(rowEl(v, 'title').querySelector(`button[aria-label="${t('props.removeKey', t('props.title'))}"]`)!);
    expect(v.state.doc.toString()).toBe('---\nstatus: Planned\nlast_updated_date: 2026-11-01\n---\nx');
    const key = v.contentDOM.querySelector<HTMLInputElement>(`.lno-props input[aria-label="${t('props.add')}"]`)!;
    const value = v.contentDOM.querySelector<HTMLInputElement>(`.lno-props input[aria-label="${t('props.newValue')}"]`)!;
    key.value = '시료';
    value.value = 's1';
    enter(value);
    expect(v.state.doc.toString()).toBe('---\nstatus: Planned\nlast_updated_date: 2026-11-01\n시료: s1\n---\nx');
    expect(document.activeElement).toBe(v.contentDOM.querySelector(`.lno-props input[aria-label="${t('props.add')}"]`));
  });

  it('last_updated_date has no input and no remove button', () => {
    const v = view(original, original.length);
    expect(rowEl(v, 'last_updated_date').querySelector('input')).toBeNull();
    expect(rowEl(v, 'last_updated_date').querySelector('button')).toBeNull();
  });

  it('a status chip click calls onChangeStatus and never writes directly', () => {
    const onChangeStatus = vi.fn();
    const v = view(original, original.length, { extensions: [propertiesActions.of({ onChangeStatus })] });
    expect(rowEl(v, 'status').querySelector('input.lno-props-value')).toBeNull();
    click(rowEl(v, 'status').querySelector('.lno-chip')!);
    expect(onChangeStatus).toHaveBeenCalledTimes(1);
    expect(v.state.doc.toString()).toBe(original);
  });

  it('a list and a wikilink value are edited as comma-separated text', () => {
    const doc = ['---', 'tags:', '  - a', 'author: [[이서연]]', '---', 'x'].join('\n');
    const v = view(doc, doc.length);
    const tags = valueInput(v, 'tags');
    tags.value = 'a, b';
    enter(tags);
    const author = valueInput(v, 'author');
    author.value = '새이름';
    enter(author);
    expect(v.state.doc.toString()).toBe(['---', 'tags:', '  - a', '  - b', 'author: [[새이름]]', '---', 'x'].join('\n'));
  });

  it('a focused input being edited is not replaced or overwritten when another value changes', () => {
    const v = view(original, original.length);
    const input = valueInput(v, 'title');
    input.focus();
    input.value = 'typing';
    v.dispatch({ changes: { from: 21, to: 28, insert: 'Done' } }); // status: Planned → Done (프로그램 편집)
    expect(valueInput(v, 'title')).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe('typing');
    expect(rowEl(v, 'status').querySelector('.lno-chip')!.textContent).toBe('완료');
  });

  it('a composing Ctrl+B inside a grid input never formats the note body', () => {
    const doc = '---\ntitle: a\n---\nhello';
    const v = view(doc, 0, { extensions: [formatExtensions()] });
    v.dispatch({ selection: { anchor: 17, head: 21 } }); // 'hell'
    const input = valueInput(v, 'title');
    input.focus();
    input.dispatchEvent(new CompositionEvent('compositionstart'));
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'b', code: 'KeyB', ctrlKey: true, isComposing: true, keyCode: 229, bubbles: true, cancelable: true }),
    );
    expect(v.state.doc.toString()).toBe(doc);
  });

  it('a value typed into a focused input survives a programmatic change to its own key', () => {
    const v = view(original, original.length);
    const input = valueInput(v, 'title');
    input.focus();
    input.value = 'typing';
    v.dispatch({ changes: { from: 11, to: 12, insert: 'z' } }); // title: a → z (프로그램 편집)
    expect(valueInput(v, 'title')).toBe(input);
    expect(input.value).toBe('typing');
  });

  it('a blur during composition commits once the composition ends', async () => {
    const v = view(original, original.length);
    const input = valueInput(v, 'title');
    input.focus();
    input.dispatchEvent(new CompositionEvent('compositionstart'));
    input.value = '한';
    input.blur(); // 조합 중에 초점을 잃는다
    expect(v.state.doc.toString()).toBe(original);
    input.dispatchEvent(new CompositionEvent('compositionend'));
    await Promise.resolve();
    expect(v.state.doc.toString()).toBe(original.replace('title: a', 'title: 한'));
  });

  it('Mod-s inside a grid input commits the pending value, then saves', () => {
    let saved = '';
    const v = view(original, original.length, {
      extensions: [Prec.highest(tableOptions.of({ save: () => (saved = v.state.doc.toString()), root: document }))],
    });
    const input = valueInput(v, 'title');
    input.focus();
    input.value = 'b';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 's', code: 'KeyS', ctrlKey: true, bubbles: true, cancelable: true }));
    expect(saved).toBe(original.replace('title: a', 'title: b')); // 적은 뒤에 저장한다
  });

  const focusAndBlurAll = (v: EditorView) => {
    for (const input of v.contentDOM.querySelectorAll<HTMLInputElement>('.lno-props input')) {
      input.focus();
      input.blur();
    }
  };

  it('focus and blur on a block-scalar row leave the document unchanged', () => {
    const doc = ['---', 'summary: |', '  line one', '  line two', 'b: 1', '---', 'x'].join('\n');
    const v = view(doc, doc.length);
    expect(rowEl(v, 'summary').dataset.cell).toBe('nested');
    focusAndBlurAll(v);
    expect(v.state.doc.toString()).toBe(doc);
  });

  it('a quoted scalar with a line break is not flattened by focus and blur', () => {
    const doc = '---\na: "x\\ny"\nb: 1\n---\nx';
    const v = view(doc, doc.length);
    focusAndBlurAll(v);
    expect(v.state.doc.toString()).toBe(doc);
  });

  it('Enter in a locked view does not change the document; inputs are read-only', () => {
    const v = view(original, original.length, { extensions: [EditorState.readOnly.of(true), EditorView.editable.of(false)] });
    const input = valueInput(v, 'title');
    expect(input.readOnly).toBe(true);
    input.focus();
    input.value = 'b';
    enter(input);
    expect(v.state.doc.toString()).toBe(original);
    expect(v.contentDOM.querySelector<HTMLInputElement>(`.lno-props input[aria-label="${t('props.add')}"]`)!.readOnly).toBe(true);
    expect(rowEl(v, 'title').querySelector<HTMLButtonElement>('.lno-props-remove')!.disabled).toBe(true);
  });

  it('a lock that arrives after the grid is drawn makes the inputs read-only, and unlocking restores them', () => {
    const lock = new Compartment();
    const v = view(original, original.length, { extensions: [lock.of([])] });
    expect(valueInput(v, 'title').readOnly).toBe(false);
    v.dispatch({ effects: lock.reconfigure([EditorState.readOnly.of(true), EditorView.editable.of(false)]) });
    expect(valueInput(v, 'title').readOnly).toBe(true);
    v.dispatch({ effects: lock.reconfigure([]) });
    expect(valueInput(v, 'title').readOnly).toBe(false);
  });

  it('the status row key is not editable and has no remove button', () => {
    const v = view(original, original.length);
    expect(rowEl(v, 'status').querySelector('input.lno-props-key')).toBeNull();
    expect(rowEl(v, 'status').querySelector('.lno-props-remove')).toBeNull();
  });

  it('Mod-e with focus inside a grid input flips the global mode exactly once', () => {
    setMode('live');
    const v = view(original, original.length);
    const input = valueInput(v, 'title');
    input.focus();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', code: 'KeyE', ctrlKey: true, bubbles: true, cancelable: true }));
    expect(getMode()).toBe('source');
  });
});

describe('라이브 미리보기: 속성 명령과 키보드로 격자 들어가기', () => {
  const addInput = (v: EditorView) => v.dom.querySelector(`.lno-props input[aria-label="${t('props.add')}"]`);
  /** 앱 명령을 그 뷰가 열린 노트인 맥락에서 돌린다. */
  const runAppCommand = async (id: string, v: EditorView) => {
    registerAllAppCommands();
    const c = appCommands().find((x) => x.id === id)!;
    expect(c).toBeTruthy();
    const notify = vi.fn();
    await c.run({ host: { notify }, activePath: () => 'a.labnote.md', activeView: () => v } as unknown as CommandContext);
    return notify;
  };
  afterEach(() => {
    clearAppCommandsForTest();
    clearCommandsForTest();
  });

  it('props-add on a plain note inserts an empty block and focuses the add-row input', () => {
    const v = view('x', 0);
    press(v, { key: ';', code: 'Semicolon', keyCode: 186, ctrlKey: true });
    expect(v.state.doc.toString()).toBe('---\n---\nx');
    expect(addInput(v)).not.toBeNull();
    expect(document.activeElement).toBe(addInput(v));
    undo(v);
    expect(v.state.doc.toString()).toBe('x');
  });

  it('props-add with existing front matter only focuses the add-row input', () => {
    const doc = '---\na: 1\n---\nx';
    const v = view(doc, 14);
    expect(addPropertyCommand(v)).toBe(true);
    expect(v.state.doc.toString()).toBe(doc);
    expect(document.activeElement).toBe(addInput(v));
  });

  it('props-add in source mode opens an empty line inside the block', () => {
    setMode('source');
    const v = view('x', 0);
    expect(addPropertyCommand(v)).toBe(true);
    expect(v.state.doc.toString()).toBe('---\n\n---\nx');
    expect(v.state.selection.main.head).toBe(4);
  });

  it('props-add does nothing in a locked view', () => {
    const v = view('x', 0, { extensions: [EditorState.readOnly.of(true)] });
    expect(addPropertyCommand(v)).toBe(false);
    expect(v.state.doc.toString()).toBe('x');
  });

  it('props-add from the palette runs on the open note', async () => {
    const v = view('x', 0);
    await runAppCommand('props-add', v);
    expect(v.state.doc.toString()).toBe('---\n---\nx');
  });

  it('props-edit-yaml shows the raw block', async () => {
    const v = view('---\na: 1\n---\nx', 14);
    await runAppCommand('props-edit-yaml', v);
    expect(v.contentDOM.querySelector('.lno-props')).toBeNull();
    expect(visibleText(v, 2)).toBe('a: 1');
    expect(v.state.selection.main.head).toBe(4);
  });

  it('props-edit-yaml without front matter returns false', () => {
    const v = view('x', 0);
    expect(editYamlCommand(v)).toBe(false);
    expect(v.state.doc.toString()).toBe('x');
  });

  it('ArrowUp on the first body line focuses the last grid input; Escape returns to the body', () => {
    const v = view('---\na: 1\nb: 2\n---\nx', 19);
    press(v, { key: 'ArrowUp', keyCode: 38 });
    const last = [...v.dom.querySelectorAll('.lno-props input')].pop();
    expect(document.activeElement).toBe(last);
    last!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.activeElement).toBe(v.contentDOM);
    expect(v.state.selection.main.head).toBe(18); // to + 1
  });

  it('ArrowLeft at the body start focuses the last grid input; ArrowLeft elsewhere moves normally', () => {
    const v = view('---\na: 1\n---\nxy', 14);
    press(v, { key: 'ArrowLeft', keyCode: 37 }); // to + 1 = 13 이 아니다
    expect(document.activeElement instanceof HTMLInputElement).toBe(false);
    move(v, 13);
    press(v, { key: 'ArrowLeft', keyCode: 37 });
    expect(document.activeElement).toBe([...v.dom.querySelectorAll('.lno-props input')].pop());
  });

  it('Escape in a value input reverts it and returns to the body', () => {
    const v = view('---\na: 1\n---\nx', 14);
    const input = v.contentDOM.querySelector<HTMLInputElement>('input.lno-props-value')!;
    input.focus();
    input.value = 'zz';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(input.value).toBe('1');
    expect(v.state.doc.toString()).toBe('---\na: 1\n---\nx');
    expect(document.activeElement).toBe(v.contentDOM);
    expect(v.state.selection.main.head).toBe(13);
  });

  it('ArrowUp without a grid (source mode) is left to the editor', () => {
    setMode('source');
    const v = view('---\na: 1\n---\nx', 13);
    expect(focusGridLast(v)).toBe(false);
  });

  it('the palette lists both commands', async () => {
    setLang('ko');
    registerAllAppCommands();
    const pick = vi.fn(async () => undefined);
    await openPalette({ host: { pick, notify: vi.fn() }, activePath: () => undefined, activeView: () => undefined } as unknown as CommandContext);
    const rows = (pick.mock.calls[0] as unknown as [PickItem<{ kbd?: string }>[]])[0].map((i) => `${i.label}|${i.value.kbd ?? ''}`);
    expect(rows).toEqual(expect.arrayContaining(['속성 추가하기|Ctrl+;', '속성을 YAML로 편집하기|']));
  });
});
