// @vitest-environment jsdom
import { createRef } from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
import { undoDepth } from '@codemirror/commands';
import { Editor, type EditorHandle } from '../Editor';
import { ERROR_KINDS_FIXTURE } from '../../__tests__/fixtures';
import { editorStatus } from '../editorStatus';
import { setLang } from '../../i18n/lang';
import { setMode } from '../live/mode';

// jsdom 에는 레이아웃이 없다. CodeMirror 가 측정에 쓰는 API 만 빈 값으로 채운다.
const emptyRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
Range.prototype.getClientRects ??= emptyRects;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();
document.execCommand ??= () => false;

const P = 'labnote/001_x/README.labnote.md';

const README = [
  '---',
  'title: Demo',
  'author: Kim',
  'status: Planned',
  '---',
  '# Demo',
  '',
  'body text',
  '',
  '- [ ] task one',
  '',
  '| A | B |',
  '| --- | --- |',
  '| 1 | 2 |',
  '',
].join('\n');

function mount(text: string, autosaveMs = 60_000) {
  const files: Record<string, string> = { [P]: text };
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
  const listen = (async () => () => undefined) as never;
  const ref = createRef<EditorHandle>();
  const utils = render(<Editor ref={ref} path={P} invoke={invoke} listen={listen} autosaveMs={autosaveMs} />);
  const root = () => (utils.container.querySelector('.editor-frame') as HTMLElement).shadowRoot!;
  const view = () => EditorView.findFromDOM(root().querySelector('.cm-editor') as HTMLElement)!;
  return { files, calls, ref, root, view, writes: () => calls.filter((c) => c === 'vault_modify').length };
}

const switchTo = (lang: 'ko' | 'en') => act(async () => setLang(lang));
const editYaml = (root: ShadowRoot) => root.querySelector('.lno-props-head button')?.textContent;
const authorLabel = (root: ShadowRoot) => root.querySelector('.lno-props-row[data-key="author"] .lno-props-key')?.textContent;

beforeEach(() => {
  setLang('ko');
  setMode('live');
});
afterAll(() => setLang('ko'));

describe('editor widgets follow a language switch with the note open', () => {
  it('the README properties grid relabels ko → en → ko', async () => {
    const m = mount(README);
    await waitFor(() => expect(m.root().querySelector('.lno-props')).not.toBeNull());
    const root = m.root();
    expect(editYaml(root)).toBe('YAML로 편집');
    expect(root.textContent).toContain('속성 추가');
    expect(authorLabel(root)).toBe('실험자');

    await switchTo('en');
    expect(editYaml(root)).toBe('Edit as YAML');
    expect(root.textContent).toContain('Add property');
    expect(root.textContent).not.toContain('속성 추가');
    expect(authorLabel(root)).toBe('Experimenter');
    expect(root.querySelector('.lno-props')?.getAttribute('aria-label')).toBe('Properties');

    await switchTo('ko');
    expect(editYaml(root)).toBe('YAML로 편집');
    expect(root.textContent).toContain('속성 추가');
    expect(root.textContent).not.toContain('Add property');
    expect(authorLabel(root)).toBe('실험자');
  });

  it('the table toolbar relabels without hovering the table', async () => {
    const m = mount(README);
    await waitFor(() => expect(m.root().querySelector('.lno-table-toolbar')).not.toBeNull());
    const bar = () => m.root().querySelector('.lno-table-toolbar')!;
    expect(bar().getAttribute('aria-label')).toBe('표 도구');
    expect(bar().querySelector('button[data-action="insertRowBelow"]')?.getAttribute('aria-label')).toBe('아래에 행 추가');
    const table = m.root().querySelector('table.lno-table');

    await switchTo('en');
    expect(bar().getAttribute('aria-label')).toBe('Table tools');
    expect(bar().querySelector('button[data-action="insertRowBelow"]')?.getAttribute('aria-label')).toBe('Add row below');
    // 표는 제자리에서 고쳐 쓴다(셀 편집기가 떠 있어도 잃지 않게)
    expect(m.root().querySelector('table.lno-table')).toBe(table);
  });

  it('task checkboxes relabel', async () => {
    const m = mount(README);
    await waitFor(() => expect(m.root().querySelector('input.lno-task')).not.toBeNull());
    expect(m.root().querySelector('input.lno-task')?.getAttribute('aria-label')).toBe('할 일 완료 전환');
    await switchTo('en');
    expect(m.root().querySelector('input.lno-task')?.getAttribute('aria-label')).toBe('Toggle task');
  });

  it('a switch leaves the document, the unsaved mark, autosave, undo history, selection and focus alone', async () => {
    const m = mount(README, 40);
    await waitFor(() => expect(m.root().querySelector('.lno-props')).not.toBeNull());
    const v = m.view();
    // 본문 끝에 친 것: 저장 안 됨, 되돌리기 한 단계
    await act(async () => v.dispatch({ changes: { from: v.state.doc.length, insert: 'x' }, userEvent: 'input.type' }));
    await act(async () => void (await m.ref.current!.flush()));
    expect(m.files[P]).toBe(`${README}x`);
    const writes = m.writes();
    const at = v.state.doc.length - 1;
    await act(async () => v.dispatch({ selection: { anchor: at } }));
    v.focus();
    const focused = m.root().activeElement;
    const before = { doc: v.state.doc.toString(), undo: undoDepth(v.state), save: editorStatus()?.save, dirty: m.ref.current!.isDirty() };

    await switchTo('en');
    await act(async () => new Promise((r) => setTimeout(r, 120))); // 자동 저장 시간이 지나도

    expect(m.view()).toBe(v); // 뷰를 새로 만들지 않았다
    expect(v.state.doc.toString()).toBe(before.doc);
    expect(undoDepth(v.state)).toBe(before.undo);
    expect(editorStatus()?.save).toBe(before.save);
    expect(m.ref.current!.isDirty()).toBe(before.dirty);
    expect(m.writes()).toBe(writes);
    expect(v.state.selection.main.anchor).toBe(at);
    expect(m.root().activeElement).toBe(focused);
    expect(editYaml(m.root())).toBe('Edit as YAML'); // 그러면서도 격자는 바뀌었다
  });
});

