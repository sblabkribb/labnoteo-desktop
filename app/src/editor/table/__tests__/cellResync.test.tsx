// @vitest-environment jsdom
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { history } from '@codemirror/commands';
import { labnoteMarkdown } from '../../markdownSyntax';
import { tableExtension } from '../field';
import { activeCellView, focusCell, liveCellEditors, setActiveCell } from '../cellEditor';
import * as model from '../model';

// setCell 이 칸 하나의 변경이 아닌 것을 돌려주는 경우(방어 경로)를 만들려고 model 을 감싼다
vi.mock('../model', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../model')>();
  return { ...mod, setCell: vi.fn(mod.setCell) };
});

// jsdom 에는 레이아웃이 없다. CodeMirror 가 측정에 쓰는 API 만 빈 값으로 채운다.
const emptyRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
Range.prototype.getClientRects ??= emptyRects;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();
document.execCommand ??= () => false;

const views: EditorView[] = [];
function mount(doc: string): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({ doc, extensions: [history(), labnoteMarkdown(), tableExtension({ save: () => {}, root: document })] }),
  });
  views.push(view);
  return view;
}
afterEach(() => {
  while (views.length) views.pop()!.destroy();
  document.body.innerHTML = '';
  vi.mocked(model.setCell).mockReset();
});
beforeEach(async () => {
  const real = await vi.importActual<typeof import('../model')>('../model');
  vi.mocked(model.setCell).mockImplementation(real.setCell);
});

const T = '| a | b |\n| --- | --- |\n| 1 | 2 |';
const typeIn = (nv: EditorView, s: string) => {
  const head = nv.state.selection.main.head;
  nv.dispatch({ changes: { from: head, insert: s }, selection: { anchor: head + s.length }, userEvent: 'input.type' });
};
const cellEl = (v: EditorView, r: number, c: number) =>
  v.dom.querySelector<HTMLTableElement>('.lno-table-wrap table')!.rows[r].cells[c] as HTMLElement;

describe('셀 편집기: 바깥에 쓰지 못한 입력', () => {
  it('setCell 이 칸 하나의 변경을 주지 않으면 셀 편집기를 문서의 칸 글자로 되돌린다', () => {
    const v = mount(`${T}\n`);
    focusCell(v, 0, 1, 0, 'end');
    const nv = activeCellView(v)!;
    vi.mocked(model.setCell).mockImplementationOnce(() => []);
    typeIn(nv, 'x');
    expect(v.state.doc.toString()).toBe(`${T}\n`);
    expect(nv.state.doc.toString()).toBe('1'); // 문서에 없는 글자를 보이지 않는다
    // 다음 입력은 다시 제대로 간다
    typeIn(nv, 'y');
    expect(v.state.doc.toString()).toBe('| a | b |\n| --- | --- |\n| 1y | 2 |\n');
  });

  it('표를 찾지 못하면 셀 편집기를 걷고, 칸에는 문서에 있던 글자를 그리며, 포커스는 바깥 편집기로 돌아온다', async () => {
    const v = mount(`${T}\n`);
    focusCell(v, 0, 1, 0, 'end');
    const nv = activeCellView(v)!;
    expect(nv.hasFocus).toBe(true);
    const td = cellEl(v, 1, 0);
    v.dispatch({ effects: setActiveCell.of({ tableFrom: 5, r: 1, c: 0 }) }); // 그 자리에는 표가 없다
    typeIn(nv, 'x');
    expect(v.state.doc.toString()).toBe(`${T}\n`);
    expect(liveCellEditors()).toBe(0);
    expect(td.textContent).toBe('1');
    // 포커스는 마이크로태스크에서 돌려준다(close 의 refocus)
    await Promise.resolve();
    expect(v.hasFocus).toBe(true);
  });
});
