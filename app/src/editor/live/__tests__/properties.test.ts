// @vitest-environment jsdom
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { history, historyKeymap, undo } from '@codemirror/commands';
import { labnoteMarkdown } from '../../markdownSyntax';
import { tableExtension } from '../../table/field';
import { livePreview } from '../index';
import { getMode, setMode } from '../mode';
import { editYaml, frontBlock, PropertiesWidget } from '../properties';
import { t } from '../../../i18n/t';
import { insertDate } from '../../../labnote/commands/editorInserts';

// jsdom 에는 레이아웃이 없다. CodeMirror 가 측정에 쓰는 API 만 빈 값으로 채운다.
const emptyRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
Range.prototype.getClientRects ??= emptyRects;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();
document.execCommand ??= () => false;

const views: EditorView[] = [];

interface Opts {
  lineSeparator?: string;
}

/** 편집기(Editor.tsx 처럼 모드가 'live' 일 때만 라이브 미리보기와 표 확장을 싣는다). */
function view(doc: string, pos: number, opts: Opts = {}): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const extra: Extension[] = [];
  if (opts.lineSeparator) extra.push(EditorState.lineSeparator.of(opts.lineSeparator));
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
const rows = (v: EditorView): [string, string][] =>
  [...v.contentDOM.querySelectorAll('.lno-props-row')].map((r) => [
    r.querySelector('.lno-props-key')?.textContent ?? '',
    r.querySelector('.lno-props-value')?.textContent ?? '',
  ]);
const click = (el: Element) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
function press(v: EditorView, init: KeyboardEventInit) {
  v.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
}

describe('라이브 미리보기: 속성(front matter) 격자', () => {
  it('renders one row per key, in file order', () => {
    const v = view('---\ntitle: a\nstatus: Planned\nlast_updated_date: 2026-11-01\n---\nx', 64);
    expect(rows(v).map(([k]) => k)).toEqual(['title', 'status', 'last_updated_date']);
    expect(rows(v)[1][1]).toBe('Planned');
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
      ['tags', 'a, b'],
      ['author', '이서연'],
      ['last_updated_date', '2026-11-01'],
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
