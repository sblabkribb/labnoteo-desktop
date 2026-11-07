// @vitest-environment jsdom
import type { NotifyKind, PromptOpts } from '@labnoteo/core';
import { WINDOWS_PATH_MAX } from '@labnoteo/core/lib/regexUtils';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useMemo, useRef } from 'react';
import { Editor, type EditorHandle } from '../../../editor/Editor';
import { installFakeVault, type FakeVault } from '../../../__tests__/fakeVault';
import { TauriLabnoteFs } from '../../../fs/tauriLabnoteFs';
import { setLang } from '../../../i18n/lang';
import { t } from '../../../i18n/t';
import type { TreeEntry } from '../../../tree/useTree';
import { fromPluginData } from '../../settings';
import { createAppHost, type AppHost } from '../../host/createAppHost';
import { DialogLayer } from '../../host/DialogLayer';
import { closeAllDialogs } from '../../host/dialogStore';
import { editorAwareFs } from '../../editorAwareFs';
import { activeEditTarget, openNote } from '../../openNotes';
import { parseRaw } from '../../../editor/documentIo';
import { linkIndex } from '../../../links/linkIndex';
import '../../__tests__/editorHarness'; // jsdom 의 CodeMirror 측정 보충
import type { CommandContext } from '../context';
import { useCommandContext, useNoteSwitcher } from '../useCommandContext';
import { deleteEntry, deleteEvents, newFolder, renameEntry, renameGuard } from '../fileOps';

vi.mock('@tauri-apps/api/core', async () => (await import('../../../__tests__/fakeVault')).mockTauri().core);
vi.mock('@tauri-apps/api/event', async () => (await import('../../../__tests__/fakeVault')).mockTauri().event);
vi.mock('@tauri-apps/api/window', async () => (await import('../../../__tests__/fakeVault')).mockTauri().window);

const SETTINGS = fromPluginData(undefined);
/** 이 답이 차례가 되면 진짜 대화상자(DialogLayer)를 띄운다. */
const REAL = Symbol('real dialog');

let vault: FakeVault;
let ctx: CommandContext | undefined;
const C = () => ctx!;
let notes: Array<{ kind: NotifyKind; message: string }>;
let prompts: PromptOpts[];
let confirms: Array<{ message: string; opts?: { confirmLabel?: string; destructive?: boolean } }>;
let promptAnswers: Array<string | undefined>;
let confirmAnswers: Array<boolean | typeof REAL>;

/** VaultView 와 같은 배선: 노트 바꾸기, 앱 호스트, 명령 맥락, 편집기, 대화상자 층. 대화상자 답은 미리 적어 둔다. */
function Harness() {
  const editor = useRef<EditorHandle>(null);
  const shell = useRef<HTMLDivElement>(null);
  const switcher = useNoteSwitcher(editor);
  const host = useMemo<AppHost>(() => {
    const real = createAppHost({
      fs: editorAwareFs(new TauriLabnoteFs()),
      editTarget: () => activeEditTarget(switcher.activePath()),
      openFile: switcher.openFile,
    });
    return {
      ...real,
      prompt: async (opts) => {
        prompts.push(opts);
        return promptAnswers.shift();
      },
      confirm: async (message, opts) => {
        confirms.push({ message, opts });
        const a = confirmAnswers.shift() ?? false;
        return a === REAL ? real.confirm(message, opts) : a;
      },
      notify: (kind, message) => void notes.push({ kind, message }),
    };
    // switcher 의 함수들은 마운트 동안 같은 객체다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  ctx = useCommandContext({
    host,
    vaultRoot: 'C:/fake-vault',
    settings: SETTINGS,
    updateSettings: () => undefined,
    selected: switcher.selected,
    activePath: switcher.activePath,
    editor,
    reloadTree: () => undefined,
    openFile: switcher.openFile,
    closeActive: switcher.closeActive,
  });
  return (
    <>
      <div className="shell" ref={shell}>
        {switcher.selected ? (
          <Editor key={switcher.selected} ref={editor} path={switcher.selected} autosaveMs={60_000} maxAutosaveMs={600_000} />
        ) : (
          <p>empty</p>
        )}
      </div>
      <DialogLayer blockRef={shell} />
    </>
  );
}

async function openAndLoad(path: string) {
  await act(() => C().openFile(path));
  await waitFor(() => expect(openNote(path)?.busy()).toBe(false));
}

/** 명령은 closeActive 로 편집기가 내려가기를 기다릴 수 있다: act 밖에서 돌리고 끝나기를 기다린다. */
async function settle<R>(p: Promise<R>): Promise<R> {
  const state: { done: boolean; value?: R; error?: unknown } = { done: false };
  p.then(
    (value) => Object.assign(state, { done: true, value }),
    (e) => Object.assign(state, { done: true, error: e ?? new Error('rejected') }),
  );
  await waitFor(() => expect(state.done).toBe(true));
  if (state.error !== undefined) throw state.error;
  return state.value as R;
}

function typeAtEnd(text: string) {
  const view = C().activeView()!;
  act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: text }, userEvent: 'input.type' }));
}

const cmds = (name: string) => vault.log.filter((c) => c.cmd === name);
/** 앱이 보관함을 열고 링크 색인을 다 읽은 상태: 이름 바꾸기는 준비된 색인에서 계획한다. */
function primeLinks(): void {
  linkIndex.clear();
  const files = vault.files();
  linkIndex.setFiles(Object.keys(files));
  for (const [p, text] of Object.entries(files)) if (p.endsWith('.md')) linkIndex.setNote(p, parseRaw(p, text).text);
  linkIndex.markReady();
}
const goneDialog = () => screen.queryByText(t('editor.gone.title'));

function entriesOf(paths: Array<[string, boolean]>): TreeEntry[] {
  return paths.map(([path, isDir]) => ({ path, isDir, name: path.slice(path.lastIndexOf('/') + 1), depth: path.split('/').length - 1 }));
}

const DIR = 'labnote/001_A';
const README_PATH = `${DIR}/README.labnote.md`;
const WF = '002_WB010_X.labnote.md';
const WF_PATH = `${DIR}/${WF}`;
const OTHER_WF = '001_WD010_Y.labnote.md';

function readme(extra = ''): string {
  return [
    '---',
    'title: A',
    'status: in-progress',
    '---',
    '',
    '## 🗂️ Related Workflows',
    '',
    `- [ ] [[${OTHER_WF.slice(0, -3)}|WD010 Y]]`,
    `- [ ] [[${WF.slice(0, -3)}|WB010 X]]`,
    '',
    '## Summary and Discussion',
    extra,
  ].join('\n');
}

beforeEach(() => {
  setLang('ko');
  ctx = undefined;
  notes = [];
  prompts = [];
  confirms = [];
  promptAnswers = [];
  confirmAnswers = [];
});

afterEach(() => {
  act(() => closeAllDialogs());
  linkIndex.clear();
});

describe('renameGuard', () => {
  const entries = entriesOf([
    ['labnote', true],
    ['labnote/001_A', true],
    ['labnote/001_A/README.labnote.md', false],
    ['labnote/001_A/002_WB010_X.labnote.md', false],
    ['projects', true],
    ['projects/labnote', true],
    ['projects/labnote/001_A', true],
    ['notes', true],
    ['notes/a.labnote.md', false],
    ['empty', true],
  ]);
  it.each([
    ['labnote', true, 'labnoteRoot'],
    ['labnote/001_A', true, 'experimentFolder'],
    ['projects', true, 'experimentParent'],
    ['labnote/001_A/002_WB010_X.labnote.md', false, 'workflowNote'],
    ['labnote/001_A/README.labnote.md', false, 'readme'],
    ['notes/a.labnote.md', false, undefined],
    ['notes', true, undefined],
    ['empty', true, undefined],
  ] as const)('%s -> %s', (path, isDir, guard) => {
    expect(renameGuard(path, isDir, entries)).toBe(guard);
  });

  it('a guarded rename is refused with its message and renames nothing', async () => {
    vault = installFakeVault({ [README_PATH]: readme() });
    render(<Harness />);
    const out = await settle(renameEntry(C(), DIR, true, entriesOf([[DIR, true]])));
    expect(out).toBeUndefined();
    expect(prompts).toHaveLength(0);
    expect(cmds('vault_rename')).toHaveLength(0);
    expect(notes).toEqual([{ kind: 'warn', message: t('fileOps.renameGuarded.experimentFolder') }]);
  });

  it('a folder holding an experiment with no notes (absent from the tree entries) is refused as experimentParent', async () => {
    vault = installFakeVault({ 'projects/sub/labnote/001_A/images/gel.png': 'x', 'projects/a.labnote.md': 'a\n' });
    render(<Harness />);
    // 트리 항목은 .md 노트로 이어지는 폴더만 싣는다: 실험 폴더는 보이지 않는다
    const out = await settle(renameEntry(C(), 'projects', true, entriesOf([['projects', true], ['projects/a.labnote.md', false]])));
    expect(out).toBeUndefined();
    expect(prompts).toHaveLength(0);
    expect(cmds('vault_rename')).toHaveLength(0);
    expect(notes).toEqual([{ kind: 'warn', message: t('fileOps.renameGuarded.experimentParent') }]);
  });

  it('a folder whose labnote folder has no ###_ experiment is not guarded', async () => {
    vault = installFakeVault({ 'projects/labnote/notes.png': 'x', 'projects/a.labnote.md': 'a\n' });
    render(<Harness />);
    promptAnswers = [undefined];
    await settle(renameEntry(C(), 'projects', true, entriesOf([['projects', true]])));
    expect(prompts).toHaveLength(1);
    expect(notes).toEqual([]);
  });
});

describe('newFolder', () => {
  it('makes the folder under the parent and refreshes', async () => {
    vault = installFakeVault({ 'notes/a.labnote.md': 'a\n' });
    render(<Harness />);
    promptAnswers.push('실험 메모');
    const out = await settle(newFolder(C(), 'notes'));
    expect(out).toBe('notes/실험 메모');
    expect(cmds('vault_mkdir').map((c) => c.args.path)).toEqual(['notes/실험 메모']);
    expect(prompts[0].prompt).toBe(t('fileOps.newFolder.prompt'));
  });

  it('the name rules match NewNote: empty, separators and a leading dot are refused in the prompt', async () => {
    vault = installFakeVault({});
    render(<Harness />);
    promptAnswers.push(undefined);
    await settle(newFolder(C(), ''));
    const validate = prompts[0].validate!;
    expect(validate('  ')).toBe(t('fileOps.name.empty'));
    expect(validate('a/b')).toBe(t('fileOps.name.separator'));
    expect(validate('a\\b')).toBe(t('fileOps.name.separator'));
    expect(validate('.hidden')).toBe(t('fileOps.name.invalid'));
    expect(validate('ok')).toBeNull();
    expect(cmds('vault_mkdir')).toHaveLength(0);
  });

  it('new folder on an existing name shows the exists message and makes no vault_mkdir call', async () => {
    vault = installFakeVault({ 'notes/Data/a.labnote.md': 'a\n' });
    render(<Harness />);
    promptAnswers.push('data'); // NTFS: 대소문자만 다른 이름도 같은 폴더다
    const out = await settle(newFolder(C(), 'notes'));
    expect(out).toBeUndefined();
    expect(cmds('vault_mkdir')).toHaveLength(0);
    expect(notes).toEqual([{ kind: 'warn', message: t('fileOps.exists') }]);
  });
});

describe('renameEntry', () => {
  it('rename of the open note closes it first, keeps unsaved text (flushed), reopens it at the new path, and shows no gone dialog', async () => {
    vault = installFakeVault({ 'notes/a.labnote.md': 'alpha\n' });
    render(<Harness />);
    primeLinks();
    await openAndLoad('notes/a.labnote.md');
    typeAtEnd('typed\n');
    promptAnswers.push('b');
    const out = await settle(renameEntry(C(), 'notes/a.labnote.md', false, []));
    expect(prompts[0].value).toBe('a'); // 확장자는 보이지 않고 그대로 남는다
    expect(out).toBe('notes/b.labnote.md');
    expect(vault.files()).toEqual({ 'notes/b.labnote.md': 'alpha\ntyped\n' });
    expect(C().activePath()).toBe('notes/b.labnote.md');
    await waitFor(() => expect(openNote('notes/b.labnote.md')?.busy()).toBe(false));
    expect(C().activeView()!.state.doc.toString()).toBe('alpha\ntyped\n');
    // 감시자가 옛 경로의 사라짐을 알려도 열린 편집기는 새 경로다
    await act(() => vault.emitChange('notes/a.labnote.md', 'removed'));
    await act(() => vault.emitChange('notes/b.labnote.md', 'created'));
    expect(goneDialog()).toBeNull();
    // 준비된 색인에서 고칠 링크를 찾지 못했다: 묻지 않고 바꾸고 그대로 알린다
    expect(notes).toContainEqual({ kind: 'info', message: t('fileOps.renamed') });
  });

  it('renaming a folder that holds the open note reopens the note under the new folder', async () => {
    vault = installFakeVault({ 'notes/sub/a.labnote.md': 'alpha\n' });
    render(<Harness />);
    primeLinks();
    await openAndLoad('notes/sub/a.labnote.md');
    promptAnswers.push('moved');
    const out = await settle(renameEntry(C(), 'notes/sub', true, entriesOf([['notes/sub', true]])));
    expect(prompts[0].value).toBe('sub');
    expect(out).toBe('notes/moved');
    expect(vault.files()).toEqual({ 'notes/moved/a.labnote.md': 'alpha\n' });
    expect(C().activePath()).toBe('notes/moved/a.labnote.md');
  });

  it('rename when the open note cannot be saved (kept conflict) renames nothing', async () => {
    const user = userEvent.setup();
    vault = installFakeVault({ 'notes/a.labnote.md': 'mine\n' });
    render(<Harness />);
    primeLinks();
    await openAndLoad('notes/a.labnote.md');
    typeAtEnd('!');
    await vault.mem.write('notes/a.labnote.md', 'theirs\n');
    await act(() => vault.emitChange('notes/a.labnote.md', 'modified'));
    await user.click(await screen.findByRole('button', { name: '그대로 두기' }));
    promptAnswers.push('b');
    const out = await settle(renameEntry(C(), 'notes/a.labnote.md', false, []));
    expect(out).toBeUndefined();
    expect(cmds('vault_rename')).toHaveLength(0);
    expect(vault.files()).toEqual({ 'notes/a.labnote.md': 'theirs\n' });
    expect(C().activePath()).toBe('notes/a.labnote.md');
    expect(notes).toEqual([{ kind: 'warn', message: t('fileOps.unsaved') }]);
  });

  it('rename onto an existing name shows the exists message', async () => {
    vault = installFakeVault({ 'notes/a.labnote.md': 'a\n', 'notes/b.labnote.md': 'b\n' });
    render(<Harness />);
    primeLinks();
    promptAnswers.push('B');
    const out = await settle(renameEntry(C(), 'notes/a.labnote.md', false, []));
    expect(out).toBeUndefined();
    expect(vault.files()).toEqual({ 'notes/a.labnote.md': 'a\n', 'notes/b.labnote.md': 'b\n' });
    expect(notes).toEqual([{ kind: 'warn', message: t('fileOps.exists') }]);
  });

  it('a case-only rename is allowed (the same file on NTFS)', async () => {
    vault = installFakeVault({ 'notes/a.labnote.md': 'a\n' });
    render(<Harness />);
    primeLinks();
    promptAnswers.push('A');
    expect(await settle(renameEntry(C(), 'notes/a.labnote.md', false, []))).toBe('notes/A.labnote.md');
    expect(vault.files()).toEqual({ 'notes/A.labnote.md': 'a\n' });
  });

  it('a long path warns with WINDOWS_PATH_MAX-1 after rename', async () => {
    const deep = `deep/${'x'.repeat(100)}/${'y'.repeat(100)}`;
    vault = installFakeVault({ [`${deep}/a.labnote.md`]: 'a\n' });
    render(<Harness />);
    primeLinks();
    promptAnswers.push('z'.repeat(60));
    const out = await settle(renameEntry(C(), `${deep}/a.labnote.md`, false, []));
    expect(out).toBe(`${deep}/${'z'.repeat(60)}.labnote.md`);
    const warn = notes.find((n) => n.kind === 'warn');
    expect(warn?.message).toContain(String(WINDOWS_PATH_MAX - 1));
  });
});

describe('deleteEntry', () => {
  it('delete uses vault_trash, never vault_remove', async () => {
    vault = installFakeVault({ 'notes/a.labnote.md': 'a\n', 'notes/b.labnote.md': 'b\n' });
    render(<Harness />);
    confirmAnswers.push(true);
    const deleted: string[] = [];
    const off = deleteEvents.subscribe((p) => deleted.push(p));
    expect(await settle(deleteEntry(C(), 'notes/a.labnote.md', false))).toBe(true);
    off();
    expect(deleted).toEqual(['notes/a.labnote.md']);
    expect(confirms[0]).toEqual({
      message: t('fileOps.delete.confirm', 'a.labnote.md'),
      opts: { confirmLabel: t('fileOps.delete.confirmLabel'), destructive: true },
    });
    expect(confirms[0].message).toContain('휴지통');
    expect(cmds('vault_trash').map((c) => c.args.path)).toEqual(['notes/a.labnote.md']);
    expect(cmds('vault_remove')).toHaveLength(0);
    expect(vault.recycleBin).toEqual([{ path: 'notes/a.labnote.md', files: { 'notes/a.labnote.md': 'a\n' } }]);
    expect(notes).toContainEqual({ kind: 'info', message: t('fileOps.deleted', 'a.labnote.md') });
  });

  it('cancelling the destructive confirm with Enter deletes nothing', async () => {
    const user = userEvent.setup();
    vault = installFakeVault({ 'notes/a.labnote.md': 'a\n' });
    render(<Harness />);
    confirmAnswers.push(REAL);
    const deleted: string[] = [];
    const off = deleteEvents.subscribe((path) => deleted.push(path));
    let p!: Promise<boolean>;
    act(() => {
      p = deleteEntry(C(), 'notes/a.labnote.md', false);
    });
    await screen.findByRole('alertdialog');
    expect(screen.getByRole('alertdialog').textContent).toContain('휴지통');
    await user.keyboard('{Enter}');
    expect(await settle(p)).toBe(false);
    off();
    expect(deleted).toEqual([]);
    expect(cmds('vault_trash')).toHaveLength(0);
    expect(vault.files()).toEqual({ 'notes/a.labnote.md': 'a\n' });
  });

  it('deleting a workflow note offers README cleanup; accepting removes exactly that checklist line, also from an open dirty README buffer', async () => {
    vault = installFakeVault({ [README_PATH]: readme(), [WF_PATH]: '---\ntitle: X\n---\n', [`${DIR}/${OTHER_WF}`]: 'y\n' });
    render(<Harness />);
    await openAndLoad(README_PATH);
    typeAtEnd('저장 안 한 줄\n');
    confirmAnswers.push(true, true);
    expect(await settle(deleteEntry(C(), WF_PATH, false))).toBe(true);
    expect(confirms).toHaveLength(2);
    expect(confirms[1].message).toBe(t('fileOps.readmeCleanup.confirm', WF));
    const expected = `${readme().replace(`- [ ] [[${WF.slice(0, -3)}|WB010 X]]\n`, '')}저장 안 한 줄\n`;
    expect(C().activeView()!.state.doc.toString()).toBe(expected);
    expect(vault.files()[README_PATH]).toBe(expected);
    expect(vault.files()[WF_PATH]).toBeUndefined();
    expect(vault.recycleBin.map((e) => e.path)).toEqual([WF_PATH]);
  });

  it('declining the README cleanup keeps the README; a note with no entry asks nothing more', async () => {
    vault = installFakeVault({ [README_PATH]: readme(), [WF_PATH]: 'x\n', [`${DIR}/003_WB020_Z.labnote.md`]: 'z\n' });
    render(<Harness />);
    confirmAnswers.push(true, false);
    expect(await settle(deleteEntry(C(), WF_PATH, false))).toBe(true);
    expect(vault.files()[README_PATH]).toBe(readme());
    confirms = [];
    confirmAnswers.push(true);
    expect(await settle(deleteEntry(C(), `${DIR}/003_WB020_Z.labnote.md`, false))).toBe(true);
    expect(confirms).toHaveLength(1);
  });

  it("deleting the open note closes the editor first: no 'gone' dialog, and the unmount save does not recreate the file", async () => {
    vault = installFakeVault({ 'notes/a.labnote.md': 'alpha\n' });
    render(<Harness />);
    await openAndLoad('notes/a.labnote.md');
    typeAtEnd('typed\n');
    confirmAnswers.push(true);
    expect(await settle(deleteEntry(C(), 'notes/a.labnote.md', false))).toBe(true);
    expect(C().activePath()).toBeUndefined();
    expect(openNote('notes/a.labnote.md')).toBeUndefined();
    await act(() => vault.emitChange('notes/a.labnote.md', 'removed'));
    expect(goneDialog()).toBeNull();
    expect(vault.files()).toEqual({});
    // 닫기 전에 저장한 글이 휴지통으로 갔다
    expect(vault.recycleBin[0].files).toEqual({ 'notes/a.labnote.md': 'alpha\ntyped\n' });
  });

  it('deleting a folder holding the open note that cannot be saved deletes nothing', async () => {
    const user = userEvent.setup();
    vault = installFakeVault({ 'notes/a.labnote.md': 'mine\n' });
    render(<Harness />);
    await openAndLoad('notes/a.labnote.md');
    typeAtEnd('!');
    await vault.mem.write('notes/a.labnote.md', 'theirs\n');
    await act(() => vault.emitChange('notes/a.labnote.md', 'modified'));
    await user.click(await screen.findByRole('button', { name: '그대로 두기' }));
    confirmAnswers.push(true);
    expect(await settle(deleteEntry(C(), 'notes', true))).toBe(false);
    expect(cmds('vault_trash')).toHaveLength(0);
    expect(notes).toEqual([{ kind: 'warn', message: t('fileOps.unsaved') }]);
  });
});
