// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PickItem, WorkflowItem } from '@labnoteo/core';
import type { EditorView } from '@codemirror/view';
import { setLang } from '../../i18n/lang';
import { t } from '../../i18n/t';
import type { TreeEntry } from '../../tree/useTree';
import { createFakeVault } from '../../__tests__/fakeVault';
import { runCommand } from '../commands/runCommand';
import { coreT } from '../i18n';
import { linkIndex } from '../../links/linkIndex';
import { copyText, markdownLinkFor } from '../../links/clipboard';
import { editorMenu, noteTreeMenu } from '../menus';
import { ContextMenu } from '../ui/ContextMenu';
import { closeMenu, openMenu, type MenuAction, type MenuItem } from '../ui/menuStore';
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
const byLabel = (items: MenuItem[], label: string) => items.find((i): i is MenuAction => i.label === label)!;
/** 서식 항목(구분선 뒤) 앞의 항목들. */
const head = (items: MenuItem[]) => items.slice(0, items.findIndex((i) => i.separator));

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
    expect(labels(noteTreeMenu(h.ctx, entry('notes/a.labnote.md', false), ENTRIES))).toEqual([
      'menu.open',
      'menu.copyLink',
      coreT('Export tables to CSV'),
      'menu.rename',
      'menu.delete',
    ]);
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

describe('noteTreeMenu CSV export', () => {
  const EXP = 'exp/labnote/001_A';
  const ONE = coreT('Export tables to CSV');
  const ALL = coreT('Export all tables of this experiment to CSV');
  const csvNote = '# X\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n';

  it('an experiment folder offers the experiment export; other folders do not', () => {
    h = createTestHost();
    expect(labels(noteTreeMenu(h.ctx, entry(EXP, true), []))).toContain(ALL);
    expect(labels(noteTreeMenu(h.ctx, entry(EXP, true), []))).not.toContain(ONE);
    for (const dir of ['notes', 'exp/labnote', `${EXP}/data`]) {
      expect(labels(noteTreeMenu(h.ctx, entry(dir, true), []))).not.toContain(ALL);
    }
  });

  it('an experiment README offers both; other notes only the one-note export; a .csv neither', () => {
    h = createTestHost();
    const readmeItems = labels(noteTreeMenu(h.ctx, entry(`${EXP}/README.labnote.md`, false), []));
    expect(readmeItems).toContain(ONE);
    expect(readmeItems).toContain(ALL);
    const wf = labels(noteTreeMenu(h.ctx, entry(`${EXP}/001_X.labnote.md`, false), []));
    expect(wf).toContain(ONE);
    expect(wf).not.toContain(ALL);
    expect(labels(noteTreeMenu(h.ctx, entry('notes/plain.md', false), []))).toContain(ONE);
    const csv = labels(noteTreeMenu(h.ctx, entry(`${EXP}/001_X.labnote_table1.csv`, false), []));
    expect(csv).not.toContain(ONE);
    expect(csv).not.toContain(ALL);
  });

  it('the items export the clicked note or experiment folder', async () => {
    const x = `${EXP}/001_X.labnote.md`;
    const y = `${EXP}/002_Y.labnote.md`;
    h = createTestHost({ [`${EXP}/README.labnote.md`]: '# R\n', [x]: csvNote, [y]: csvNote, 'notes/b.md': csvNote });
    await runCommand(h.ctx, byLabel(noteTreeMenu(h.ctx, entry(x, false), []), ONE).run);
    expect(h.vault.files()[`${EXP}/001_X.labnote_table1.csv`]).toBe('\uFEFFa,b\n1,2\n');
    expect(h.vault.files()[`${EXP}/002_Y.labnote_table1.csv`]).toBeUndefined();
    await runCommand(h.ctx, byLabel(noteTreeMenu(h.ctx, entry(EXP, true), []), ALL).run);
    expect(h.vault.files()[`${EXP}/002_Y.labnote_table1.csv`]).toBe('\uFEFFa,b\n1,2\n');
    expect(h.vault.files()['notes/b_table1.csv']).toBeUndefined();
  });
});

describe('Open link and Copy link', () => {
  let clip: string[];
  let failClipboard: boolean;
  const open = vi.fn();
  beforeEach(() => {
    clip = [];
    failClipboard = false;
    open.mockReset();
    linkIndex.clear();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          if (failClipboard) throw new Error('denied');
          clip.push(text);
        },
      },
    });
  });
  afterEach(() => linkIndex.clear());
  const action = (items: MenuItem[], i: number) => items[i] as MenuAction;
  const byKey = (items: MenuItem[], key: string) => items.find((i): i is MenuAction => !i.separator && i.labelKey === key)!;

  it('editor menu offers Open link and Copy link first on a link', async () => {
    h = createTestHost();
    const items = editorMenu(h.ctx, 'n.md', {
      hit: { kind: 'wiki', from: 0, to: 12, linkpath: 'Home', subpath: 'A', embed: false },
      text: '[[Home#A|h]]',
      open,
    });
    expect(labels(items.slice(0, 2))).toEqual(['menu.link.open', 'menu.link.copy']);
    expect(t('menu.link.open')).toBe('링크 열기');
    await action(items, 1).run();
    expect(clip).toEqual(['[[Home#A|h]]']);
    expect(h.notes).toEqual([{ kind: 'info', message: t('links.copied') }]);
    await action(items, 0).run();
    expect(open).toHaveBeenCalledTimes(1);
    // 링크가 없으면 링크 항목도 없다
    expect(labels(editorMenu(h.ctx, 'n.md'))).not.toContain('menu.link.open');
  });

  it('Copy link on a Markdown link copies its href without angle brackets', async () => {
    h = createTestHost();
    const md = (href: string) =>
      editorMenu(h.ctx, 'n.md', { hit: { kind: 'md', from: 0, to: 10, href }, text: `[x](${href})`, open });
    await action(md('https://doi.org/10.1/x'), 1).run();
    await action(md('<notes/My Home.md>'), 1).run();
    expect(clip).toEqual(['https://doi.org/10.1/x', 'notes/My Home.md']);
  });

  it('tree menu copies a wikilink for a note', async () => {
    h = createTestHost();
    linkIndex.setFiles(['notes/PCR 조건.md', 'notes/sub/PCR 조건.md']);
    const item = byKey(noteTreeMenu(h.ctx, { path: 'notes/sub/PCR 조건.md', name: 'PCR 조건.md', isDir: false, depth: 2 }, []), 'menu.copyLink');
    await item.run();
    expect(clip).toEqual(['[[notes/sub/PCR 조건]]']);
    // 폴더에는 없다
    expect(labels(noteTreeMenu(h.ctx, entry('notes', true), ENTRIES))).not.toContain('menu.copyLink');
  });

  it('a name a wikilink cannot express copies a rooted, percent-encoded Markdown link', async () => {
    h = createTestHost();
    linkIndex.setFiles(['notes/C# (v2) 50%.md']);
    const item = byKey(noteTreeMenu(h.ctx, entry('notes/C# (v2) 50%.md', false), ENTRIES), 'menu.copyLink');
    await item.run();
    expect(clip).toEqual(['[C# (v2) 50%](/notes/C%23%20%28v2%29%2050%25.md)']);
    expect(linkIndex.resolver().resolveMd('/notes/C%23%20%28v2%29%2050%25.md', 'x.md')).toBe('notes/C# (v2) 50%.md');
    expect(markdownLinkFor('a/[b].md')).toBe('[\\[b\\]](/a/[b].md)');
  });

  it('a clipboard failure is not reported as copied', async () => {
    const notes: Array<[string, string]> = [];
    failClipboard = true;
    await expect(copyText('x', (k, m) => notes.push([k, m]))).rejects.toThrow('denied');
    expect(notes).toEqual([]);
  });
});

describe('editorMenu', () => {
  it('the editor menu on a workflow note offers Insert unit operation', () => {
    h = createTestHost();
    // 샘플 추적이 켜져 있으면(기본) 어느 노트든 샘플 추가가 노트 항목 앞에 온다(플러그인 editor-menu 의 순서, SP5 Task 24)
    expect(labels(head(editorMenu(h.ctx, WF_PATH)))).toEqual([
      'samples.menu.addSample',
      coreT('Insert unit operation'),
      coreT('Insert date'),
      coreT('Insert date and time'),
      coreT('Insert issue marker'),
    ]);
    expect(coreT('Insert unit operation')).toBe('유닛 오퍼레이션 삽입');
    expect(labels(head(editorMenu(h.ctx, 'notes/a.labnote.md')))).toEqual([
      'samples.menu.addSample',
      coreT('Insert date'),
      coreT('Insert date and time'),
      coreT('Insert issue marker'),
    ]);
  });

  it('the editor menu on a README offers Insert workflow, and running it inserts no link', async () => {
    h = createTestHost({ [README_PATH]: readme() });
    expect(labels(head(editorMenu(h.ctx, README_PATH)))).toEqual([
      'samples.menu.addSample',
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

  it('editorMenu for a plain note now has the Format items', () => {
    h = createTestHost();
    const items = editorMenu(h.ctx, 'notes/plain.md');
    expect(labels(head(items))).toEqual(['samples.menu.addSample']);
    // 샘플 추적을 끄면 서식 항목만 남는다
    expect(editorMenu(createTestHost({}, { sampleTracking: false }).ctx, 'notes/plain.md')[0].separator).toBe(true);
    // 서식 항목은 labelKey(그릴 때 번역)다: 메뉴를 연 채 언어를 바꿔도 따라간다
    const keys = items.filter((i) => !i.separator).map((i) => i.labelKey);
    expect(keys).toEqual(expect.arrayContaining(['cmd.format.bold', 'cmd.format.codeBlock']));
    expect(t('cmd.format.bold')).toBe('굵게');
  });

  it('every note ends with one separator and the flat Format items', () => {
    h = createTestHost();
    for (const p of [WF_PATH, README_PATH, 'notes/a.labnote.md', 'notes/plain.md']) {
      const items = editorMenu(h.ctx, p);
      expect(items.filter((i) => i.separator)).toHaveLength(1);
      const tail = items.slice(items.findIndex((i) => i.separator) + 1).map((i) => i.labelKey);
      expect(tail).toEqual([
        'cmd.format.bold',
        'cmd.format.italic',
        'cmd.format.strike',
        'cmd.format.code',
        'cmd.format.highlight',
        'cmd.format.link',
        'cmd.format.heading1',
        'cmd.format.heading2',
        'cmd.format.heading3',
        'cmd.format.heading4',
        'cmd.format.heading5',
        'cmd.format.heading6',
        'cmd.format.paragraph',
        'cmd.format.bullet',
        'cmd.format.numbered',
        'cmd.format.task',
        'cmd.format.quote',
        'cmd.format.codeBlock',
      ]);
    }
  });

  it('the Format menu item bolds the selection in the open note', async () => {
    h = createTestHost({ 'notes/a.labnote.md': 'a b c' });
    const m = await h.mount('notes/a.labnote.md');
    act(() => m.view().dispatch({ selection: { anchor: 2, head: 3 } }));
    await act(() => runCommand(h.ctx, editorMenu(h.ctx, 'notes/a.labnote.md').find((i) => i.labelKey === 'cmd.format.bold')!.run!));
    expect(m.view().state.doc.toString()).toBe('a **b** c');
  });

  it('the context menu draws the separator as role=separator, not a menuitem', () => {
    h = createTestHost();
    render(<ContextMenu />);
    act(() => openMenu(h.ctx, { x: 10, y: 10 }, editorMenu(h.ctx, 'notes/a.labnote.md')));
    expect(screen.getAllByRole('separator')).toHaveLength(1);
    expect(screen.getAllByRole('menuitem')).toHaveLength(1 + 3 + 18); // 샘플 추가, 넣기 명령, 서식
    for (const el of document.querySelectorAll('[role="separator"]')) expect(el.hasAttribute('style')).toBe(false);
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
    const row = screen.getByRole('treeitem', { name: 'a.labnote.md' });
    fireEvent.contextMenu(row, { clientX: 12, clientY: 34 });
    expect(onContextMenu).toHaveBeenLastCalledWith(ENTRIES[6], { x: 12, y: 34 });
    fireEvent.keyDown(row, { key: 'F10', shiftKey: true });
    expect(onContextMenu).toHaveBeenLastCalledWith(ENTRIES[6], { element: row });
    fireEvent.keyDown(screen.getByRole('treeitem', { name: 'notes' }), { key: 'ContextMenu' });
    expect(onContextMenu).toHaveBeenLastCalledWith(ENTRIES[5], { element: screen.getByRole('treeitem', { name: 'notes' }) });
    expect(onContextMenu).toHaveBeenCalledTimes(3);
  });
});
