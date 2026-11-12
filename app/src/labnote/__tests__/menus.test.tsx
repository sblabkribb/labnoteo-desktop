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
import { editorMenu, noteTreeMenu, viewMoreMenu } from '../menus';
import { githubActions } from '../../github/commands';
import { resetGithubStatusesForTest, setGithubStatuses } from '../../github/statusStore';
import type { FolderStatus } from '../../integrations/githubIpc';
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

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn(async () => undefined) }));
vi.mock('@tauri-apps/api/core', async (orig) => ({ ...(await orig<object>()), invoke: invokeMock }));

const labels = (items: readonly MenuItem[]) => items.map((i) => (i.label !== undefined ? i.label : i.labelKey));
/** 하위 메뉴까지 펼친 모든 항목. */
const flat = (items: readonly MenuItem[]): MenuItem[] => items.flatMap((i) => [i, ...(i.submenu ? flat(i.submenu) : [])]);
const byLabel = (items: MenuItem[], label: string) => flat(items).find((i): i is MenuAction => i.label === label)!;
/** "실험 노트" 구역(section 이 붙은 첫 항목부터 끝까지). 없으면 []. */
const head = (items: MenuItem[]) => {
  const at = items.findIndex((i) => i.section !== undefined);
  return at < 0 ? [] : items.slice(at);
};
const submenuOf = (items: MenuItem[], key: string) => (items.find((i) => i.labelKey === key) as MenuAction).submenu!;

beforeEach(() => invokeMock.mockClear());

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
      'menu.newNoteHere',
      'menu.newFolderHere',
      'menu.copyLink',
      'header.copyPath',
      coreT('Export tables to CSV'),
      undefined,
      'menu.rename',
      'menu.delete',
    ]);
    expect(labels(noteTreeMenu(h.ctx, entry('notes', true), ENTRIES))).toEqual([
      'menu.newNoteHere',
      'menu.newFolder',
      'header.copyPath',
      undefined,
      'menu.rename',
      'menu.delete',
    ]);
    // every item has an icon, so the rows line up (CSV export included)
    for (const item of noteTreeMenu(h.ctx, entry('notes/a.labnote.md', false), ENTRIES)) {
      if ('run' in item) expect((item as MenuAction).icon, String((item as MenuAction).labelKey ?? (item as MenuAction).label)).toBeTruthy();
    }
    // 삭제는 위험 항목이고 맨 끝이다
    const del = noteTreeMenu(h.ctx, entry('notes', true), ENTRIES).at(-1) as MenuAction;
    expect(del.labelKey).toBe('menu.delete');
    expect(del.danger).toBe(true);
  });

  it('the tree menu on a png offers Open with default app, Show in folder and Copy embed link', async () => {
    h = createTestHost();
    linkIndex.setFiles(['notes/gel.png']);
    const items = noteTreeMenu(h.ctx, entry('notes/gel.png', false), ENTRIES);
    expect(labels(items)).toEqual([
      'menu.open',
      'menu.newNoteHere',
      'menu.newFolderHere',
      'menu.openDefault',
      'menu.reveal',
      'menu.copyEmbed',
      'header.copyPath',
      undefined,
      'menu.rename',
      'menu.delete',
    ]);
    expect(t('menu.openDefault')).toBe('기본 앱으로 열기');
    expect(t('menu.reveal')).toBe('폴더에서 보기');
    const run = (key: string) => (items.find((i) => i.labelKey === key) as MenuAction).run();
    await run('menu.openDefault');
    await run('menu.reveal');
    expect(invokeMock.mock.calls).toEqual([
      ['vault_open_default', { path: 'notes/gel.png' }],
      ['vault_reveal', { path: 'notes/gel.png' }],
    ]);
    const clip: string[] = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (s: string) => void clip.push(s) } });
    await run('menu.copyEmbed');
    await run('header.copyPath');
    expect(clip).toEqual(['![[gel.png]]', 'notes/gel.png']);
    linkIndex.clear();
    // 노트에는 기본 앱·폴더 항목이 없다
    expect(labels(noteTreeMenu(h.ctx, entry('notes/a.labnote.md', false), ENTRIES))).not.toContain('menu.openDefault');
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
    await runCommand(h.ctx, (noteTreeMenu(h.ctx, entry('notes', true), ENTRIES)[0] as MenuAction).run);
    expect(h.vault.files()['notes/b.labnote.md']).toBe('');
    expect(h.opened).toEqual(['notes/b.labnote.md']);
    expect(h.refreshes()).toBe(1);
    // 있는 이름은 거절한다
    h.answer.prompt('a');
    await runCommand(h.ctx, (noteTreeMenu(h.ctx, entry('notes', true), ENTRIES)[0] as MenuAction).run);
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

describe('GitHub items', () => {
  const EXP = 'labnote/001_x';
  const LEGACY = 'labnote/002_y';
  const linked = (over: Partial<FolderStatus> = {}): FolderStatus => ({
    linked: true,
    state: 'pushed',
    changedCount: 0,
    folderMissing: false,
    fullName: 'me/x',
    htmlUrl: 'https://github.com/me/x',
    ...over,
  });
  const gh = (items: MenuItem[]) => {
    const at = items.findIndex((i) => i.section === 'github.menu.section');
    if (at < 0) return [];
    const out: MenuItem[] = [];
    for (const i of items.slice(at)) {
      if (i.separator || !(i as MenuAction).labelKey?.startsWith('github.')) break;
      out.push(i);
    }
    return out;
  };
  const keys = (items: MenuItem[]) => gh(items).map((i) => (i as MenuAction).labelKey);

  afterEach(() => {
    resetGithubStatusesForTest();
    vi.restoreAllMocks();
  });

  it('an unlinked experiment folder offers Upload to GitHub, in its own section after a separator; other folders none', () => {
    h = createTestHost();
    const items = noteTreeMenu(h.ctx, entry(EXP, true), []);
    expect(keys(items)).toEqual(['github.menu.upload']);
    const at = items.findIndex((i) => i.section === 'github.menu.section');
    expect(items[at - 1].separator).toBe(true);
    expect((items[at] as MenuAction).icon).toBe('upload');
    for (const dir of ['notes', 'labnote', `${EXP}/data`]) expect(keys(noteTreeMenu(h.ctx, entry(dir, true), []))).toEqual([]);
    // 파일 줄에는 없다
    expect(keys(noteTreeMenu(h.ctx, entry(`${EXP}/README.labnote.md`, false), []))).toEqual([]);
  });

  it('a legacy experiment folder (README.md) qualifies too', () => {
    h = createTestHost({ [`${LEGACY}/README.md`]: '# old\n' });
    expect(keys(noteTreeMenu(h.ctx, entry(LEGACY, true), []))).toEqual(['github.menu.upload']);
  });

  it('a linked experiment shows Upload changes, Open on GitHub, then Disconnect (danger, last)', () => {
    h = createTestHost();
    setGithubStatuses({ [EXP]: linked({ changedCount: 2 }) });
    const items = noteTreeMenu(h.ctx, entry(EXP, true), []);
    expect(keys(items)).toEqual(['github.menu.uploadChanges', 'github.menu.open', 'github.menu.unlink']);
    const list = gh(items) as MenuAction[];
    expect(list.map((i) => i.icon)).toEqual(['cloud-upload', 'external-link', 'trash-2']);
    expect(list[2].danger).toBe(true);
    expect(list.slice(0, 2).every((i) => !i.danger)).toBe(true);
  });

  it('an unfinished upload shows Finish (plus Open when there is a repo)', () => {
    h = createTestHost();
    setGithubStatuses({ [EXP]: linked({ state: 'committed' }) });
    expect(keys(noteTreeMenu(h.ctx, entry(EXP, true), []))).toEqual(['github.menu.finish', 'github.menu.open']);
    setGithubStatuses({ [EXP]: linked({ state: 'repoCreating', htmlUrl: undefined }) });
    expect(keys(noteTreeMenu(h.ctx, entry(EXP, true), []))).toEqual(['github.menu.finish']);
  });

  it('each item runs the same action as the matching command, on the menu folder', async () => {
    h = createTestHost();
    const upload = vi.spyOn(githubActions, 'upload').mockResolvedValue(undefined);
    const open = vi.spyOn(githubActions, 'open').mockResolvedValue(undefined);
    const disconnect = vi.spyOn(githubActions, 'disconnect').mockResolvedValue(undefined);
    const finish = vi.spyOn(githubActions, 'finish').mockResolvedValue(undefined);
    await runCommand(h.ctx, (gh(noteTreeMenu(h.ctx, entry(EXP, true), []))[0] as MenuAction).run);
    expect(upload).toHaveBeenCalledWith(h.ctx, EXP);
    setGithubStatuses({ [EXP]: linked() });
    const [changes, openItem, unlink] = gh(noteTreeMenu(h.ctx, entry(EXP, true), [])) as MenuAction[];
    await runCommand(h.ctx, changes.run);
    await runCommand(h.ctx, openItem.run);
    await runCommand(h.ctx, unlink.run);
    expect(upload).toHaveBeenLastCalledWith(h.ctx, EXP);
    expect(open).toHaveBeenCalledWith(h.ctx, EXP);
    expect(disconnect).toHaveBeenCalledWith(h.ctx, EXP);
    setGithubStatuses({ [EXP]: linked({ state: 'committed' }) });
    await runCommand(h.ctx, (gh(noteTreeMenu(h.ctx, entry(EXP, true), []))[0] as MenuAction).run);
    expect(finish).toHaveBeenCalledWith(h.ctx, EXP);
  });

  it('the note header menu of an experiment README has the same items; other notes none', () => {
    h = createTestHost();
    expect(keys(viewMoreMenu(h.ctx, `${EXP}/README.labnote.md`))).toEqual(['github.menu.upload']);
    setGithubStatuses({ [EXP]: linked() });
    expect(keys(viewMoreMenu(h.ctx, `${EXP}/README.labnote.md`))).toEqual(['github.menu.uploadChanges', 'github.menu.open', 'github.menu.unlink']);
    expect(keys(viewMoreMenu(h.ctx, `${EXP}/001_X.labnote.md`))).toEqual([]);
    expect(keys(viewMoreMenu(h.ctx, 'notes/a.labnote.md'))).toEqual([]);
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
    const items = head(
      editorMenu(h.ctx, 'n.md', {
        hit: { kind: 'wiki', from: 0, to: 12, linkpath: 'Home', subpath: 'A', embed: false },
        text: '[[Home#A|h]]',
        open,
      }),
    );
    // 링크 항목은 "실험 노트" 구역의 맨 앞이다
    expect(labels(items.slice(0, 2))).toEqual(['menu.link.open', 'menu.link.copy']);
    expect(items[0].section).toBe('menu.labnote');
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
      head(editorMenu(h.ctx, 'n.md', { hit: { kind: 'md', from: 0, to: 10, href }, text: `[x](${href})`, open }));
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
  /** Task 16 이전의 편집기 메뉴 항목(이름) → 지금 그것을 찾을 이름. 하나도 빠지지 않아야 한다. */
  const BEFORE: Record<string, string> = {
    'samples.menu.addSample': 'samples.menu.addSample',
    [coreT('Insert unit operation')]: coreT('Insert unit operation'),
    [coreT('Insert workflow')]: coreT('Insert workflow'),
    [coreT('Sync workflow checklist with folder')]: coreT('Sync workflow checklist with folder'),
    [coreT('Change experiment status')]: coreT('Change experiment status'),
    [coreT('Toggle discussion flag')]: coreT('Toggle discussion flag'),
    [coreT('Insert date')]: 'menu.date',
    [coreT('Insert date and time')]: 'menu.dateTime',
    [coreT('Insert issue marker')]: 'menu.issueMarker',
  };
  const FORMAT = [
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
  ];

  it('the order is Cut/Copy/Paste/Select all, Insert ▸, Format ▸, then the Lab note section', () => {
    h = createTestHost();
    const items = editorMenu(h.ctx, WF_PATH);
    expect(labels(items)).toEqual([
      'menu.cut',
      'menu.copy',
      'menu.paste',
      'menu.selectAll',
      undefined,
      'menu.insert',
      'menu.format',
      'samples.menu.addSample',
      coreT('Insert unit operation'),
    ]);
    expect(items[7].section).toBe('menu.labnote');
    expect(t('menu.labnote')).toBe('실험 노트');
    expect(items.slice(0, 4).map((i) => i.shortcut)).toEqual(['Ctrl+X', 'Ctrl+C', 'Ctrl+V', 'Ctrl+A']);
    expect(['menu.cut', 'menu.copy', 'menu.paste', 'menu.selectAll'].map((k) => t(k))).toEqual(['잘라내기', '복사', '붙여넣기', '모두 선택']);
  });

  it('Cut and Copy are disabled without a selection, with a reason', async () => {
    h = createTestHost({ 'notes/a.labnote.md': 'abc' });
    const off = editorMenu(h.ctx, 'notes/a.labnote.md');
    expect(off.slice(0, 4).map((i) => !!i.disabled)).toEqual([true, true, false, false]);
    expect(off[0].disabledReason).toBe('menu.needSelection');
    const m = await h.mount('notes/a.labnote.md');
    act(() => m.view().dispatch({ selection: { anchor: 0, head: 2 } }));
    expect(editorMenu(h.ctx, 'notes/a.labnote.md').slice(0, 2).map((i) => !!i.disabled)).toEqual([false, false]);
  });

  it('the Insert submenu has table, callout, code block, rule, math block, then date, date-time and issue marker', () => {
    h = createTestHost();
    const insert = submenuOf(editorMenu(h.ctx, WF_PATH), 'menu.insert');
    expect(labels(insert)).toEqual([
      'menu.table',
      'menu.callout',
      'menu.codeBlock',
      'menu.hr',
      'menu.mathBlock',
      undefined,
      'menu.date',
      'menu.dateTime',
      'menu.issueMarker',
    ]);
    expect(labels(insert).map((k) => (k ? t(k) : '-'))).toEqual(['표', '콜아웃', '코드 블록', '가로줄', '수식 블록', '-', '날짜', '날짜·시간', '이슈 마커']);
    expect(insert[0].shortcut).toBe('Ctrl+Alt+T');
    // 일반 노트에서 이슈 마커는 이유와 함께 꺼져 있다(실험 노트에서만 이슈가 된다)
    const plain = submenuOf(editorMenu(h.ctx, 'notes/plain.md'), 'menu.insert');
    const marker = plain.find((i) => i.labelKey === 'menu.issueMarker')!;
    expect(marker.disabled).toBe(true);
    expect(marker.disabledReason).toBe('menu.issueMarker.onlyLabnote');
    expect(submenuOf(editorMenu(h.ctx, WF_PATH), 'menu.insert').find((i) => i.labelKey === 'menu.issueMarker')!.disabled).toBeFalsy();
  });

  it('the issue marker is on only where markers open issues: README and workflow notes directly in an experiment folder', () => {
    h = createTestHost();
    const marker = (p: string) => submenuOf(editorMenu(h.ctx, p), 'menu.insert').find((i) => i.labelKey === 'menu.issueMarker')!;
    expect(marker(WF_PATH).disabled).toBeFalsy();
    expect(marker(README_PATH).disabled).toBeFalsy();
    // .labnote.md 이지만 실험 폴더 밖이거나 실험 폴더의 하위 폴더: 이슈가 되지 않으므로 까닭과 함께 꺼 둔다
    for (const p of ['notes/a.labnote.md', `${DIR}/sub/x.labnote.md`]) {
      expect(marker(p).disabled, p).toBe(true);
      expect(marker(p).disabledReason).toBe('menu.issueMarker.onlyLabnote');
    }
    expect(t('menu.issueMarker.onlyLabnote')).toContain('실험 폴더 바로 안');
  });

  it('the Format submenu holds every formatting item with its shortcut', () => {
    h = createTestHost();
    const format = submenuOf(editorMenu(h.ctx, 'notes/plain.md'), 'menu.format');
    expect(labels(format)).toEqual(FORMAT);
    expect(format[0].shortcut).toBe('Ctrl+B');
    // 삽입 ▸ 처럼 모든 항목에 아이콘이 있다(왼쪽 아이콘 칸이 비지 않는다)
    expect(format.filter((i) => !i.separator && !i.icon).map((i) => (i.separator ? '' : i.labelKey))).toEqual([]);
    expect(t('cmd.format.bold')).toBe('굵게');
  });

  it('the header has no Insert table button: tables come from the Insert menu, the palette and Ctrl+Alt+T', () => {
    // 키의 동작은 editor/table/__tests__/commands.test.tsx 의 "편집기의 표 넣기"가 본다.
    const source = readFileSync('src/editor/Editor.tsx', 'utf-8');
    expect(source).not.toContain('data-command-id="editor.insert.table"');
    expect(source).toContain('INSERT_TABLE_KEY');
  });

  it('every item the editor menu had before is still reachable', () => {
    h = createTestHost();
    const link = { hit: { kind: 'wiki' as const, from: 0, to: 6, linkpath: 'x', subpath: '', embed: false }, text: '[[x]]', open: () => undefined };
    const reach = (p: string) => labels(flat(editorMenu(h.ctx, p, link)));
    const all = new Set([...reach(WF_PATH), ...reach(README_PATH), ...reach('notes/a.labnote.md')]);
    for (const [old, now] of Object.entries(BEFORE)) expect(all, old).toContain(now);
    for (const k of [...FORMAT, 'menu.link.open', 'menu.link.copy']) expect(all, k).toContain(k);
  });

  it('the Lab note section of a workflow note, a labnote note and a README', () => {
    h = createTestHost();
    expect(labels(head(editorMenu(h.ctx, WF_PATH)))).toEqual(['samples.menu.addSample', coreT('Insert unit operation')]);
    expect(coreT('Insert unit operation')).toBe('Unit Operation 삽입');
    expect(labels(head(editorMenu(h.ctx, 'notes/a.labnote.md')))).toEqual(['samples.menu.addSample']);
    expect(labels(head(editorMenu(h.ctx, README_PATH)))).toEqual([
      'samples.menu.addSample',
      coreT('Insert workflow'),
      coreT('Sync workflow checklist with folder'),
      coreT('Change experiment status'),
      coreT('Toggle discussion flag'),
    ]);
    // 샘플 추적을 끈 일반 노트에는 구역이 없다
    expect(head(editorMenu(createTestHost({}, { sampleTracking: false }).ctx, 'notes/plain.md'))).toEqual([]);
  });

  it('the editor menu on a README offers Insert workflow, and running it inserts no link', async () => {
    h = createTestHost({ [README_PATH]: readme() });
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

  it('Format ▸ Bold bolds the selection; Insert ▸ Horizontal rule inserts a rule', async () => {
    h = createTestHost({ 'notes/a.labnote.md': 'a b c' });
    const m = await h.mount('notes/a.labnote.md');
    act(() => m.view().dispatch({ selection: { anchor: 2, head: 3 } }));
    const items = () => editorMenu(h.ctx, 'notes/a.labnote.md');
    await act(() => runCommand(h.ctx, submenuOf(items(), 'menu.format').find((i) => i.labelKey === 'cmd.format.bold')!.run!));
    expect(m.view().state.doc.toString()).toBe('a **b** c');
    act(() => m.view().dispatch({ selection: { anchor: m.view().state.doc.length } }));
    await act(() => runCommand(h.ctx, submenuOf(items(), 'menu.insert').find((i) => i.labelKey === 'menu.hr')!.run!));
    expect(m.view().state.doc.toString()).toBe('a **b** c\n\n---\n');
  });

  it('the context menu draws a separator, a section label and submenu parents', () => {
    h = createTestHost();
    render(<ContextMenu />);
    act(() => openMenu(h.ctx, { x: 10, y: 10 }, editorMenu(h.ctx, 'notes/a.labnote.md')));
    expect(screen.getAllByRole('separator')).toHaveLength(1);
    // 잘라내기·복사·붙여넣기·모두 선택, 삽입·서식, 샘플 추가
    expect(screen.getAllByRole('menuitem')).toHaveLength(4 + 2 + 1);
    expect(screen.getByRole('menuitem', { name: /삽입/ }).getAttribute('aria-haspopup')).toBe('menu');
    expect(document.querySelector('.context-menu-section')?.textContent).toBe('실험 노트');
    for (const el of document.querySelectorAll('[role="separator"], [role="menuitem"]')) expect(el.hasAttribute('style')).toBe(false);
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
    const row = screen.getByRole('treeitem', { name: 'a' });
    fireEvent.contextMenu(row, { clientX: 12, clientY: 34 });
    expect(onContextMenu).toHaveBeenLastCalledWith(ENTRIES[6], { x: 12, y: 34 });
    fireEvent.keyDown(row, { key: 'F10', shiftKey: true });
    expect(onContextMenu).toHaveBeenLastCalledWith(ENTRIES[6], { element: row });
    fireEvent.keyDown(screen.getByRole('treeitem', { name: 'notes' }), { key: 'ContextMenu' });
    expect(onContextMenu).toHaveBeenLastCalledWith(ENTRIES[5], { element: screen.getByRole('treeitem', { name: 'notes' }) });
    expect(onContextMenu).toHaveBeenCalledTimes(3);
  });
});
