// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PickItem, WorkflowItem } from '@labnoteo/core';
import type { EditorView } from '@codemirror/view';
import { setLang } from '../../i18n/lang';
import type { TreeEntry } from '../../tree/useTree';
import { createFakeVault } from '../../__tests__/fakeVault';
import { runCommand } from '../commands/runCommand';
import { coreT } from '../i18n';
import { editorMenu, noteTreeMenu } from '../menus';
import { ContextMenu } from '../ui/ContextMenu';
import { closeMenu, openMenu, type MenuItem } from '../ui/menuStore';
import { mountEditor } from './editorHarness';
import { createTestHost, type TestHost } from './testHost';

const DIR = 'labnote/001_단백질_발현';
const README_PATH = `${DIR}/README.labnote.md`;
const WF_PATH = `${DIR}/001_WD010_General_Design_of_Experiment.labnote.md`;

function readme(): string {
  return [
    '---',
    'title: 단백질 발현',
    "author: '김연구'",
    'status: in-progress',
    'created_date: 2026-01-01',
    'last_updated_date: 2026-01-01',
    '---',
    '',
    '## 🗂️ Related Workflows',
    '',
    '',
    '## Summary and Discussion',
    '',
  ].join('\n');
}

const entry = (path: string, isDir: boolean): TreeEntry => ({
  path,
  name: path.slice(path.lastIndexOf('/') + 1),
  isDir,
  depth: path.split('/').length - 1,
});

const ENTRIES: TreeEntry[] = [
  entry('labnote', true),
  entry(DIR, true),
  entry(`${DIR}/data`, true),
  entry(README_PATH, false),
  entry(WF_PATH, false),
  entry('notes', true),
  entry('notes/a.labnote.md', false),
];

const labels = (items: MenuItem[]) => items.map((i) => (i.label !== undefined ? i.label : i.labelKey));
const byLabel = (items: MenuItem[], label: string) => items.find((i) => i.label === label)!;

let h: TestHost;

beforeEach(() => setLang('ko'));

afterEach(() => {
  act(() => closeMenu());
  cleanup();
  h?.cleanup();
});

describe('noteTreeMenu', () => {
  it('files get Open, Rename, Delete; folders get New note here, New folder, Rename, Delete', () => {
    h = createTestHost();
    expect(labels(noteTreeMenu(h.ctx, entry('notes/a.labnote.md', false), ENTRIES))).toEqual(['menu.open', 'menu.rename', 'menu.delete']);
    expect(labels(noteTreeMenu(h.ctx, entry('notes', true), ENTRIES))).toEqual([
      'menu.newNoteHere',
      'menu.newFolder',
      'menu.rename',
      'menu.delete',
    ]);
  });

  it('the tree menu on a README offers status/flag', () => {
    h = createTestHost();
    const items = labels(noteTreeMenu(h.ctx, entry(README_PATH, false), ENTRIES));
    expect(items).toContain(coreT('Change experiment status'));
    expect(items).toContain(coreT('Toggle discussion flag'));
    expect(items).toContain('menu.open');
    // 워크플로 노트에는 상태 항목이 없다
    const wf = labels(noteTreeMenu(h.ctx, entry(WF_PATH, false), ENTRIES));
    expect(wf).not.toContain(coreT('Change experiment status'));
  });

  it('the tree menu on a folder inside an experiment offers Create workflow', async () => {
    h = createTestHost({ [README_PATH]: readme() });
    for (const dir of [DIR, `${DIR}/data`]) {
      expect(labels(noteTreeMenu(h.ctx, entry(dir, true), ENTRIES))).toContain(coreT('Create workflow'));
    }
    expect(labels(noteTreeMenu(h.ctx, entry('notes', true), ENTRIES))).not.toContain(coreT('Create workflow'));
    expect(labels(noteTreeMenu(h.ctx, entry('labnote', true), ENTRIES))).not.toContain(coreT('Create workflow'));
    // 열린 노트가 없어도 그 실험에 만든다
    h.answer.pick((items: PickItem<unknown>[]) => items.find((i) => (i.value as WorkflowItem).id === 'WD010')!.value);
    h.answer.alias('');
    await runCommand(h.ctx, byLabel(noteTreeMenu(h.ctx, entry(`${DIR}/data`, true), ENTRIES), coreT('Create workflow')).run);
    expect(h.vault.files()[WF_PATH]).toBeDefined();
    expect(h.opened).toEqual([WF_PATH]);
  });

  it('New note here creates the note in that folder and opens it', async () => {
    h = createTestHost({ 'notes/a.labnote.md': '' });
    h.answer.prompt('b');
    await runCommand(h.ctx, noteTreeMenu(h.ctx, entry('notes', true), ENTRIES)[0].run);
    expect(h.vault.files()['notes/b.labnote.md']).toBe('');
    expect(h.opened).toEqual(['notes/b.labnote.md']);
    expect(h.refreshes()).toBe(1);
    // 있는 이름은 거절한다
    h.answer.prompt('a');
    await runCommand(h.ctx, noteTreeMenu(h.ctx, entry('notes', true), ENTRIES)[0].run);
    expect(h.notes.at(-1)?.kind).toBe('warn');
    expect(h.opened).toEqual(['notes/b.labnote.md']);
  });
});

describe('editorMenu', () => {
  it('the editor menu on a workflow note offers Insert unit operation', () => {
    h = createTestHost();
    expect(labels(editorMenu(h.ctx, WF_PATH))).toEqual([
      coreT('Insert unit operation'),
      coreT('Insert date'),
      coreT('Insert date and time'),
      coreT('Insert issue marker'),
    ]);
    expect(coreT('Insert unit operation')).toBe('유닛 오퍼레이션 삽입');
    expect(labels(editorMenu(h.ctx, 'notes/a.labnote.md'))).toEqual([
      coreT('Insert date'),
      coreT('Insert date and time'),
      coreT('Insert issue marker'),
    ]);
    expect(editorMenu(h.ctx, 'notes/plain.md')).toEqual([]);
  });

  it('the editor menu on a README offers Insert workflow, and running it inserts no link', async () => {
    h = createTestHost({ [README_PATH]: readme() });
    expect(labels(editorMenu(h.ctx, README_PATH))).toEqual([
      coreT('Insert workflow'),
      coreT('Sync workflow checklist with folder'),
      coreT('Change experiment status'),
      coreT('Toggle discussion flag'),
      coreT('Insert date'),
      coreT('Insert date and time'),
      coreT('Insert issue marker'),
    ]);
    const m = await h.mount(README_PATH);
    const before = m.view().state.doc.toString();
    act(() => m.view().dispatch({ selection: { anchor: before.indexOf('## Summary') } }));
    h.answer.pick((items: PickItem<unknown>[]) => items.find((i) => (i.value as WorkflowItem).id === 'WD010')!.value);
    h.answer.alias('');
    await act(() => runCommand(h.ctx, byLabel(editorMenu(h.ctx, README_PATH), coreT('Insert workflow')).run));
    const link = '[WD010 General Design of Experiment](./001_WD010_General_Design_of_Experiment.labnote.md)';
    const buffer = m.view().state.doc.toString();
    expect(buffer.split(link)).toHaveLength(2); // 체크리스트 항목 하나뿐, 커서에는 없다
    expect(buffer).toContain(`- [ ] ${link}`);
    expect(buffer.slice(buffer.indexOf('## Summary'))).toBe(before.slice(before.indexOf('## Summary')));
    expect(h.opened).toEqual([]);
  });

  it('menus have no style attribute', () => {
    h = createTestHost();
    render(<ContextMenu />);
    act(() => openMenu(h.ctx, { x: 10, y: 10 }, noteTreeMenu(h.ctx, entry(README_PATH, false), ENTRIES)));
    expect(screen.getAllByRole('menuitem').length).toBeGreaterThan(3);
    for (const el of document.querySelectorAll('[role="menuitem"]')) expect(el.hasAttribute('style')).toBe(false);
    // 소스에 React style 속성이 없다(메뉴 위치는 ContextMenu 가 CSSOM 으로 둔다)
    for (const f of ['../menus.ts', '../ui/EditorActions.tsx', '../../tree/NoteTree.tsx']) {
      expect(readFileSync(resolve(__dirname, f), 'utf8')).not.toMatch(/style=/);
    }
  });
});

describe('Editor right-click', () => {
  const T3 = '| a | b |\n| --- | --- |\n| 1 | 2 |';

  it('right-clicking a table cell shows only the table menu', async () => {
    const vault = createFakeVault({ 'n.labnote.md': `앞\n\n${T3}\n\n뒤\n` });
    const onContextMenu = vi.fn();
    const m = mountEditor(vault, 'n.labnote.md', { onContextMenu });
    await m.loaded();
    const wrap = m.view().dom.querySelector<HTMLElement>('.lno-table-wrap')!;
    const cell = wrap.querySelector('td')!;
    act(() => void cell.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })));
    expect(wrap.querySelector('.lno-table-menu')).not.toBeNull();
    expect(onContextMenu).not.toHaveBeenCalled();
    // 표 밖의 본문은 앱 메뉴를 부른다
    const line = m.view().contentDOM.querySelector('.cm-line')!;
    act(() => void line.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })));
    expect(onContextMenu).toHaveBeenCalledTimes(1);
    m.unmount();
  });

  it('right-click inside the selection keeps the selection; outside it moves the caret first', async () => {
    const vault = createFakeVault({ 'n.labnote.md': '첫째 줄입니다\n둘째 줄입니다\n' });
    let seen: { anchor: number; head: number } | undefined;
    const onContextMenu = vi.fn((_e: MouseEvent, view: EditorView) => {
      const { anchor, head } = view.state.selection.main;
      seen = { anchor, head };
    });
    const m = mountEditor(vault, 'n.labnote.md', { onContextMenu });
    await m.loaded();
    const view = m.view();
    act(() => view.dispatch({ selection: { anchor: 1, head: 5 } }));
    const at = vi.spyOn(view, 'posAtCoords').mockReturnValue(3);
    const line = view.contentDOM.querySelector('.cm-line')!;
    act(() => void line.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 5 })));
    expect(seen).toEqual({ anchor: 1, head: 5 });
    expect(view.state.selection.main.from).toBe(1);
    expect(view.state.selection.main.to).toBe(5);
    at.mockReturnValue(10);
    act(() => void line.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 90, clientY: 20 })));
    expect(seen).toEqual({ anchor: 10, head: 10 });
    m.unmount();
  });
});

describe('NoteTree context menu', () => {
  it('right-click and Shift+F10 / the ContextMenu key on a row ask for the menu', async () => {
    const { NoteTree } = await import('../../tree/NoteTree');
    const onContextMenu = vi.fn();
    render(<NoteTree entries={ENTRIES} onSelect={() => undefined} onContextMenu={onContextMenu} />);
    const row = screen.getByRole('button', { name: 'a.labnote.md' });
    fireEvent.contextMenu(row, { clientX: 12, clientY: 34 });
    expect(onContextMenu).toHaveBeenLastCalledWith(ENTRIES[6], { x: 12, y: 34 });
    fireEvent.keyDown(row, { key: 'F10', shiftKey: true });
    expect(onContextMenu).toHaveBeenLastCalledWith(ENTRIES[6], { element: row });
    fireEvent.keyDown(screen.getByRole('button', { name: 'notes' }), { key: 'ContextMenu' });
    expect(onContextMenu).toHaveBeenLastCalledWith(ENTRIES[5], { element: screen.getByRole('button', { name: 'notes' }) });
    expect(onContextMenu).toHaveBeenCalledTimes(3);
  });
});
