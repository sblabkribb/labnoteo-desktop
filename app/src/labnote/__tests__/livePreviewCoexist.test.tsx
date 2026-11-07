// @vitest-environment jsdom
/**
 * 라이브 미리보기와 SP1 표, SP2 노트 명령이 한 노트에서 함께 사는가. 진짜 Editor 를 가짜 보관함 위에 띄운다
 * (editorHarness.mountEditor 를 쓰는 testHost). 문서는 30 줄 밑이라 jsdom 의 보이는 범위 안에 다 든다.
 */
import { act, waitFor } from '@testing-library/react';
import { undo } from '@codemirror/commands';
import type { EditorView } from '@codemirror/view';
import type { UnitOperationItem } from '@labnoteo/core';
import { getMode, setMode } from '../../editor/live/mode';
import { activeCellView, focusCell } from '../../editor/table/cellEditor';
import { setLang } from '../../i18n/lang';
import { runCommand } from '../commands/runCommand';
import { syncWorkflowChecklist } from '../commands/syncChecklist';
import { insertUnitOp } from '../commands/unitOp';
import { createTestHost, type TestHost } from './testHost';
import { completionStatus } from '@codemirror/autocomplete';
import { toggleMode } from '../../editor/live/mode';
import type { OpenTarget } from '../../editor/live/links';
import { setComposing } from '../../editor/__tests__/composing';
import { linkIndex } from '../../links/linkIndex';
import { createFakeVault } from '../../__tests__/fakeVault';
import { mountEditor } from './editorHarness';

// Node 의 자체 localStorage 가 jsdom 의 것을 가리므로 메모리 저장소를 꽂는다(mode.test.tsx 와 같다).
function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  };
}

const DIR = 'labnote/001_클로닝';
const WF_PATH = `${DIR}/002_WB030_Cloning.labnote.md`;
const README_PATH = `${DIR}/README.labnote.md`;
const WF =
  '---\ntitle: wf\nstatus: Planned\n---\n## [WB030 Cloning]\n\n### [UHW010 PCR] alias\n\n- [ ] [UO](./u.labnote.md)\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n---\n\nend\n';
/** 체크리스트 한 줄(이미 있는 워크플로), 표와 구분선이 든 README. 같은 폴더의 003 워크플로는 아직 목록에 없다. */
const README =
  '---\ntitle: 클로닝\nstatus: in-progress\nlast_updated_date: 2026-01-01\n---\n\n## 🗂️ Related Workflows\n\n- [ ] [WB030 Cloning](./002_WB030_Cloning.labnote.md)\n\n## Summary and Discussion\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n---\n\nend\n';
const MOVED = '003_WB040_Assembly.labnote.md';

const hosts: TestHost[] = [];

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  localStorage.clear();
  setMode('live');
  setLang('ko');
});
afterEach(() => {
  for (const h of hosts.splice(0)) h.cleanup();
  vi.unstubAllGlobals();
});

/** 노트를 앱의 편집기에 연다. cursor 를 주지 않으면 마지막 줄('end')에 둔다(렌더된 요소 밖). */
async function mountNote(path: string, files: Record<string, string>, opts: { cursor?: number } = {}) {
  const h = createTestHost(files);
  hosts.push(h);
  const m = await h.mount(path);
  const shadow = (m.container.querySelector('.editor-frame') as HTMLElement).shadowRoot!;
  const text = files[path];
  const at = opts.cursor ?? text.lastIndexOf('end');
  act(() => {
    m.view().dispatch({ selection: { anchor: at } });
    m.view().focus();
  });
  /** 같은 노트를 바깥에서 조용히 다시 읽게 한다(뒤에 한 줄을 더해 상태가 실제로 갈아 끼워지게). */
  const reload = async (next: string) => {
    const before = m.view().state;
    await h.vault.mem.write(path, next);
    await act(() => h.vault.emitChange(path, 'modified'));
    await waitFor(() => expect(m.view().state.doc.toString()).toBe(next));
    expect(m.view().state).not.toBe(before);
  };
  /** 첫 표의 r 행 c 칸에 셀 편집기를 띄운다(r=0 은 머리 행, 1 은 첫 본문 행). */
  const openCell = async (r: number, c: number) => {
    const v = m.view();
    const from = v.state.doc.toString().indexOf('| a | b |');
    await act(async () => void focusCell(v, from, r, c, 'all'));
    const cell = activeCellView(v)!;
    expect(cell).not.toBeNull();
    return cell;
  };
  return { h, m, view: m.view, shadow, reload, openCell };
}

function mouse(el: Element, type: string): MouseEvent {
  const ev = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 });
  act(() => void el.dispatchEvent(ev));
  return ev;
}

/** Ctrl 과 함께 키를 누른다(그 뷰의 contentDOM 에 실제 keydown). keyCode 는 jsdom 이 받지 않을 수 있어 직접 붙인다. */
function press(v: EditorView, init: { key: string; code: string; keyCode: number }): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { key: init.key, code: init.code, ctrlKey: true, bubbles: true, cancelable: true, composed: true });
  Object.defineProperty(ev, 'keyCode', { value: init.keyCode });
  Object.defineProperty(ev, 'which', { value: init.keyCode });
  act(() => void v.contentDOM.dispatchEvent(ev));
  return ev;
}

describe('라이브 미리보기와 표, 노트 명령의 공존', () => {
  it('a workflow note renders the grid, UO chips, hr, checklist and a table together', async () => {
    const { shadow } = await mountNote(WF_PATH, { [WF_PATH]: WF });
    for (const s of ['.lno-props', '.lno-uo-code', '.lno-task', '.lno-table-wrap']) expect(shadow.querySelector(s)).not.toBeNull();
    expect(shadow.querySelectorAll('.lno-hr')).toHaveLength(1);
  });

  it('insert-unit-operation (SP2 batch) with the cursor inside a rendered heading: one undo restores the text', async () => {
    const { h, view } = await mountNote(WF_PATH, { [WF_PATH]: WF }, { cursor: WF.indexOf('PCR') });
    h.answer.alias('');
    const op = { id: 'UHW020', name: 'Gel', description: 'Gel step' } as UnitOperationItem;
    await act(() => runCommand(h.ctx, () => insertUnitOp(h.ctx, { op, kind: 'hw' })));
    expect(view().state.doc.toString()).toContain('### [UHW020 Gel]');
    act(() => void undo(view()));
    expect(view().state.doc.toString()).toBe(WF);
  });

  it('sync-workflow-checklist after a checkbox click gives the same text as without live preview', async () => {
    const files = {
      [README_PATH]: README,
      [WF_PATH]: '---\ntitle: WB030 Cloning\n---\n',
      [`${DIR}/${MOVED}`]: '---\ntitle: WB040 Assembly\n---\n\n## [WB040 Assembly] x\n',
    };
    const live = await mountNote(README_PATH, files);
    mouse(live.shadow.querySelector('.lno-task')!, 'mousedown');
    expect(live.view().state.doc.toString()).toContain('- [x] [WB030 Cloning]');
    await act(() => runCommand(live.h.ctx, () => syncWorkflowChecklist(live.h.ctx)));

    act(() => setMode('source'));
    const src = await mountNote(README_PATH, files);
    expect(src.shadow.querySelector('.lno-task')).toBeNull();
    const box = README.indexOf('[ ]');
    act(() => src.view().dispatch({ changes: { from: box + 1, to: box + 2, insert: 'x' }, userEvent: 'input.toggle' }));
    await act(() => runCommand(src.h.ctx, () => syncWorkflowChecklist(src.h.ctx)));

    const out = live.view().state.doc.toString();
    expect(out).toContain(`./${MOVED}`);
    expect(out).toBe(src.view().state.doc.toString());
  });

  it('a silent reload keeps live mode and the cursor; table cell edits still reach the outer doc', async () => {
    const m = await mountNote(WF_PATH, { [WF_PATH]: WF }, { cursor: 70 });
    await m.reload(`${WF}\n본문\n`);
    expect(getMode()).toBe('live');
    expect(m.view().state.selection.main.head).toBe(70);
    expect(m.shadow.querySelector('.lno-props')).not.toBeNull();
    const cell = await m.openCell(1, 0);
    act(() => cell.dispatch(cell.state.replaceSelection('9')));
    expect(m.view().state.doc.toString()).toContain('| 9 | 2 |');
  });

  it('Ctrl+B in a cell, then Ctrl+Z, undoes only the bold', async () => {
    const m = await mountNote(WF_PATH, { [WF_PATH]: WF });
    const cell = await m.openCell(1, 0);
    act(() => cell.dispatch({ selection: { anchor: 0, head: 1 } }));
    press(cell, { key: 'b', code: 'KeyB', keyCode: 66 });
    expect(m.view().state.doc.toString()).toContain('| **1** |');
    press(activeCellView(m.view()) ?? m.view(), { key: 'z', code: 'KeyZ', keyCode: 90 });
    expect(m.view().state.doc.toString()).toBe(WF);
  });

  it('Ctrl+E in a cell keeps focus in the outer editor', async () => {
    const m = await mountNote(WF_PATH, { [WF_PATH]: WF });
    const cell = await m.openCell(1, 0);
    press(cell, { key: 'e', code: 'KeyE', keyCode: 69 });
    await act(() => Promise.resolve());
    expect(getMode()).toBe('source');
    expect(m.shadow.activeElement).toBe(m.view().contentDOM);
  });
});

describe('links coexist with IME, the Properties grid and source mode (SP4 Task 27)', () => {
  afterEach(() => linkIndex.clear());

  it('composition over a wikilink survives an index refresh', async () => {
    linkIndex.clear(); linkIndex.setFiles(['n.md']); linkIndex.markReady();
    const m = mountEditor(createFakeVault({ 'n.md': '[[Ho\nx' }), 'n.md');
    await m.loaded();
    const v = m.view();
    v.dispatch({ selection: { anchor: 4 } });
    const spy = vi.spyOn(v, 'dispatch');
    setComposing(v, true);
    v.dispatch({ changes: { from: 4, insert: 'm' }, selection: { anchor: 5 }, userEvent: 'input.type.compose' });
    linkIndex.addFiles(['Hom.md']); // a refresh lands mid-composition
    await Promise.resolve();
    expect(spy.mock.calls.filter(([s]) => s && 'effects' in (s as object)).length).toBe(0); // no reconfigure while composing
    setComposing(v, false);
    v.dispatch({ changes: { from: 5, insert: ']]' }, selection: { anchor: 7 } });
    await Promise.resolve();
    expect(v.state.doc.toString()).toBe('[[Hom]]\nx');
    expect(spy.mock.calls.filter(([s]) => s && 'effects' in (s as object)).length).toBe(1); // reconfigured exactly once, after compositionend
    expect(v.contentDOM.querySelector('.lno-unresolved')).toBeNull();
    m.unmount();
  });

  it('Properties grid Escape still reverts with autocompletion installed', async () => {
    linkIndex.clear(); linkIndex.markReady();
    const doc = '---\ntitle: a\nstatus: Planned\n---\nx';
    const m = mountEditor(createFakeVault({ 'n.md': doc }), 'n.md');
    await m.loaded();
    const v = m.view();
    const row = [...v.contentDOM.querySelectorAll<HTMLElement>('.lno-props-row')].find((r) => r.dataset.key === 'title')!;
    const input = row.querySelector<HTMLInputElement>('input.lno-props-value')!;
    input.value = '[[zz';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(input.value).toBe('a');
    expect(completionStatus(v.state)).toBeNull();
    expect(v.state.doc.toString()).toBe(doc);
    m.unmount();
  });

  it('source mode: a plain click places the caret, Ctrl+click opens', async () => {
    linkIndex.clear(); linkIndex.setFiles(['n.md', 'Home.md']); linkIndex.markReady();
    const opened: OpenTarget[] = [];
    const m = mountEditor(createFakeVault({ 'n.md': 'ab [[Home]]\nx', 'Home.md': '' }), 'n.md', { onOpenLink: (t) => opened.push(t) });
    await m.loaded();
    toggleMode(); // Ctrl+E
    const v = m.view();
    // jsdom has no layout, so posAtCoords cannot map clientX 30 into the line. Stand in for the browser: the
    // pointer is over "[[Home]]" (document position 5).
    vi.spyOn(v, 'posAtCoords').mockReturnValue(5);
    const line = v.contentDOM.querySelector('.cm-line')!;
    line.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX: 30 }));
    expect(opened).toEqual([]);
    // the link handler did not consume the plain mousedown: CodeMirror started its own caret placement
    expect(!!(v as unknown as { inputState: { mouseSelection: unknown } }).inputState.mouseSelection).toBe(true);
    line.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, ctrlKey: true, clientX: 30 }));
    expect(opened).toEqual([{ kind: 'note', path: 'Home.md' }]);
    toggleMode();
    m.unmount();
  });
});
