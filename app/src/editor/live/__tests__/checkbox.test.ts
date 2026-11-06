// @vitest-environment jsdom
import { EditorState, type Extension, type Transaction } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, undo } from '@codemirror/commands';
import { labnoteMarkdown } from '../../markdownSyntax';
import { livePreview } from '../index';
import { CheckboxWidget, toggleTaskAt } from '../widgets';

// jsdom 에는 레이아웃이 없다. CodeMirror 가 측정에 쓰는 API 만 빈 값으로 채운다.
const emptyRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
Range.prototype.getClientRects ??= emptyRects;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();

const views: EditorView[] = [];
let seen: Transaction[] = [];

interface Opts {
  lineSeparator?: string;
  readOnly?: boolean;
  onTr?: (tr: Transaction) => void;
}

function view(doc: string, pos: number, opts: Opts = {}): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const extra: Extension[] = [];
  if (opts.lineSeparator) extra.push(EditorState.lineSeparator.of(opts.lineSeparator));
  if (opts.readOnly) extra.push(EditorState.readOnly.of(true));
  if (opts.onTr) {
    const onTr = opts.onTr;
    extra.push(EditorView.updateListener.of((u) => u.transactions.forEach(onTr)));
  }
  const v = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor: Math.min(pos, doc.length) },
      extensions: [history(), keymap.of([...defaultKeymap, ...historyKeymap]), labnoteMarkdown(), livePreview(), ...extra],
    }),
  });
  views.push(v);
  return v;
}

beforeEach(() => {
  seen = [];
});

afterEach(() => {
  while (views.length) views.pop()!.destroy();
  document.body.innerHTML = '';
});

function mouse(el: Element, type: string): MouseEvent {
  const ev = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 });
  el.dispatchEvent(ev);
  return ev;
}

describe('라이브 미리보기: 할 일 체크박스', () => {
  it('off the cursor line the marker is a checkbox; done items get lno-task-done; the cursor line stays raw', () => {
    const v = view('- [ ] a\n- [x] b\nz', 16);
    const boxes = v.contentDOM.querySelectorAll<HTMLInputElement>('input.lno-task');
    expect(boxes).toHaveLength(2);
    expect(boxes[0].type).toBe('checkbox');
    expect(boxes[0].checked).toBe(false);
    expect(boxes[1].checked).toBe(true);
    expect(boxes[0].getAttribute('aria-label')).toBeTruthy();
    const lines = v.contentDOM.querySelectorAll<HTMLElement>('.cm-line');
    expect(lines[0].textContent).toBe(' a'); // `- ` 은 숨고 `[ ]` 은 체크박스가 대신한다
    expect(lines[0].querySelector('.lno-bullet')).toBeNull();
    expect(lines[1].classList.contains('lno-task-done')).toBe(true);
    expect(lines[0].classList.contains('lno-task-done')).toBe(false);
    v.dispatch({ selection: { anchor: 3 } });
    expect(v.contentDOM.querySelectorAll('.cm-line')[0].textContent).toBe('- [ ] a');
    expect(v.contentDOM.querySelectorAll('input.lno-task')).toHaveLength(1);
  });

  it('CheckboxWidget.eq compares the checked state', () => {
    expect(new CheckboxWidget(true).eq(new CheckboxWidget(true))).toBe(true);
    expect(new CheckboxWidget(true).eq(new CheckboxWidget(false))).toBe(false);
    expect(new CheckboxWidget(false).ignoreEvent()).toBe(false);
  });

  it('checkbox mousedown toggles once and keeps the selection', () => {
    const v = view('- [ ] [UO](./x.labnote.md)\nz', 28);
    const box = v.contentDOM.querySelector('.lno-task') as HTMLInputElement;
    expect(mouse(box, 'mousedown').defaultPrevented).toBe(true);
    expect(v.state.doc.toString()).toBe('- [x] [UO](./x.labnote.md)\nz');
    expect(v.state.selection.main.head).toBe(28);
    expect(v.state.selection.ranges.length).toBe(1);
    const box2 = v.contentDOM.querySelector('.lno-task') as HTMLInputElement;
    expect(mouse(box2, 'click').defaultPrevented).toBe(true);
    expect(v.state.doc.toString()).toBe('- [x] [UO](./x.labnote.md)\nz');
    undo(v);
    expect(v.state.doc.toString()).toBe('- [ ] [UO](./x.labnote.md)\nz');
  });

  it('toggle in a mixed-EOL note changes exactly one byte', () => {
    const v = view('- [ ] a\r\nb\nc', 11, { lineSeparator: '\n' });
    const before = v.state.sliceDoc();
    mouse(v.contentDOM.querySelector('.lno-task')!, 'mousedown');
    const after = v.state.sliceDoc();
    expect(after.length).toBe(before.length);
    expect([...after].filter((c, i) => c !== before[i]).length).toBe(1);
    expect(after[3]).toBe('x');
  });

  it('a locked editor ignores mousedown', () => {
    const v = view('- [ ] a\nz', 9, { readOnly: true });
    const box = v.contentDOM.querySelector('.lno-task') as HTMLInputElement;
    mouse(box, 'mousedown');
    mouse(box, 'click');
    expect(v.state.doc.toString()).toBe('- [ ] a\nz');
    expect(box.checked).toBe(false);
    expect(toggleTaskAt(v, 2)).toBe(false);
  });

  it('the transaction carries userEvent input.toggle', () => {
    const v = view('- [ ] a\nz', 9, { onTr: (tr) => seen.push(tr) });
    mouse(v.contentDOM.querySelector('.lno-task')!, 'mousedown');
    expect(seen.filter((tr) => tr.docChanged)).toHaveLength(1);
    expect(seen.find((tr) => tr.docChanged)!.isUserEvent('input.toggle')).toBe(true);
  });

  it('toggleTaskAt turns X back to a space and refuses a non-marker', () => {
    const v = view('- [X] a\nz', 9);
    expect(toggleTaskAt(v, 2)).toBe(true);
    expect(v.state.doc.toString()).toBe('- [ ] a\nz');
    expect(toggleTaskAt(v, 0)).toBe(false);
    expect(v.state.doc.toString()).toBe('- [ ] a\nz');
  });
});
