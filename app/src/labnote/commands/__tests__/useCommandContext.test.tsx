// @vitest-environment jsdom
import { act, render, waitFor } from '@testing-library/react';
import { useMemo, useRef } from 'react';
import { Editor, type EditorHandle } from '../../../editor/Editor';
import { installFakeVault, type FakeVault } from '../../../__tests__/fakeVault';
import { TauriLabnoteFs } from '../../../fs/tauriLabnoteFs';
import { fromPluginData } from '../../settings';
import { createAppHost } from '../../host/createAppHost';
import { editorAwareFs } from '../../editorAwareFs';
import { activeEditTarget, openNote } from '../../openNotes';
import '../../__tests__/editorHarness'; // jsdom 의 CodeMirror 측정 보충
import { vaultRefresh, type CommandContext } from '../context';
import { useCommandContext, useNoteSwitcher } from '../useCommandContext';

vi.mock('@tauri-apps/api/core', async () => (await import('../../../__tests__/fakeVault')).mockTauri().core);
vi.mock('@tauri-apps/api/event', async () => (await import('../../../__tests__/fakeVault')).mockTauri().event);
vi.mock('@tauri-apps/api/window', async () => (await import('../../../__tests__/fakeVault')).mockTauri().window);

const SETTINGS = fromPluginData(undefined);

interface HarnessProps {
  onCtx: (ctx: CommandContext | undefined) => void;
  reloadTree?: () => void;
  settingsLoaded?: boolean;
}

/** VaultView 와 같은 배선: 노트 바꾸기, 앱 호스트, 명령 맥락, 편집기. */
function Harness(props: HarnessProps) {
  const editor = useRef<EditorHandle>(null);
  const notes = useNoteSwitcher(editor);
  const host = useMemo(
    () =>
      createAppHost({
        fs: editorAwareFs(new TauriLabnoteFs()),
        editTarget: () => activeEditTarget(notes.activePath()),
        openFile: notes.openFile,
      }),
    // notes 의 함수들은 마운트 동안 같은 객체다
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const ctx = useCommandContext({
    host,
    vaultRoot: 'C:/fake-vault',
    settings: props.settingsLoaded === false ? undefined : SETTINGS,
    updateSettings: () => undefined,
    selected: notes.selected,
    activePath: notes.activePath,
    editor,
    reloadTree: props.reloadTree ?? (() => undefined),
    openFile: notes.openFile,
    closeActive: notes.closeActive,
  });
  props.onCtx(ctx);
  return notes.selected ? (
    <Editor key={notes.selected} ref={editor} path={notes.selected} initialReveal={notes.reveal} autosaveMs={60_000} maxAutosaveMs={600_000} />
  ) : (
    <p>empty</p>
  );
}

let vault: FakeVault;
let ctx: CommandContext | undefined;
const C = () => ctx!;
const modifies = () => vault.log.filter((c) => c.cmd === 'vault_modify');
const reads = () => vault.log.filter((c) => c.cmd === 'vault_read').length;

function mount(extra: Partial<HarnessProps> = {}) {
  return render(<Harness onCtx={(c) => (ctx = c)} {...extra} />);
}

async function openAndLoad(path: string, at?: { line: number; ch?: number }) {
  await act(() => C().openFile(path, at));
  await waitFor(() => expect(openNote(path)?.busy()).toBe(false));
}

/** closeActive 는 편집기가 내려갈 때까지 기다린다: act 안에서 기다리면 그 렌더가 act 끝까지 미뤄져 서로 기다린다. */
async function closing(): Promise<boolean> {
  const p = C().closeActive();
  let result: boolean | undefined;
  void p.then((v) => (result = v));
  await waitFor(() => expect(result).toBeDefined());
  return result!;
}

function typeAtEnd(text: string) {
  const view = C().activeView()!;
  act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: text }, userEvent: 'input.type' }));
}

beforeEach(() => {
  vault = installFakeVault({ 'a.md': 'alpha\n', 'b.md': 'line0\nline1\nline2 here\n' });
  ctx = undefined;
});

describe('useCommandContext', () => {
  it('is undefined until the settings load', () => {
    mount({ settingsLoaded: false });
    expect(ctx).toBeUndefined();
  });

  it('activeView() is undefined while the editor is busy; defined once the note is ready', async () => {
    mount();
    expect(C().activePath()).toBeUndefined();
    expect(C().activeView()).toBeUndefined();
    await openAndLoad('a.md');
    expect(C().activePath()).toBe('a.md');
    expect(C().activeView()?.state.doc.toString()).toBe('alpha\n');
    expect(C().host.editTarget()).toBeDefined();

    // 읽기에 실패한 노트는 바쁘다: 명령은 뷰도 편집 대상도 받지 않는다
    vault.failNext('vault_read', 'io');
    await act(() => C().openFile('b.md'));
    await waitFor(() => expect(openNote('b.md')).toBeDefined());
    await waitFor(() => expect(vault.log.some((c) => c.cmd === 'vault_read' && c.args.path === 'b.md')).toBe(true));
    expect(C().activePath()).toBe('b.md');
    expect(openNote('b.md')!.busy()).toBe(true);
    expect(C().activeView()).toBeUndefined();
    expect(C().host.editTarget()).toBeUndefined();
  });

  it('closeActive() unmounts the editor without a vault_modify', async () => {
    const { getByText } = mount();
    await openAndLoad('a.md');
    const closed = await closing();
    expect(closed).toBe(true);
    expect(openNote('a.md')).toBeUndefined(); // 이미 내려갔다
    expect(getByText('empty')).toBeTruthy();
    expect(C().activePath()).toBeUndefined();
    expect(modifies()).toHaveLength(0);
    // 열린 것이 없으면 그대로 true
    await expect(C().closeActive()).resolves.toBe(true);
  });

  it('closeActive() saves unsaved typing once (the flush) and the unmount saves nothing more', async () => {
    mount();
    await openAndLoad('a.md');
    typeAtEnd('typed\n');
    const closed = await closing();
    expect(closed).toBe(true);
    expect(modifies()).toHaveLength(1);
    expect(vault.files()['a.md']).toBe('alpha\ntyped\n');
  });

  it('closeActive() returns false and keeps the note open when it cannot be saved', async () => {
    mount();
    await openAndLoad('a.md');
    typeAtEnd('typed\n');
    vault.failNext('vault_modify', 'io');
    const closed = await closing();
    expect(closed).toBe(false);
    expect(openNote('a.md')).toBeDefined();
    expect(C().activePath()).toBe('a.md');
  });

  it('openFile at a line on a different note flushes the current one first, and the cursor lands on that line', async () => {
    mount();
    await openAndLoad('a.md');
    typeAtEnd('typed\n');
    await openAndLoad('b.md', { line: 2, ch: 3 });
    expect(vault.files()['a.md']).toBe('alpha\ntyped\n');
    expect(openNote('a.md')).toBeUndefined();
    const view = C().activeView()!;
    const head = view.state.selection.main.head;
    expect(view.state.doc.lineAt(head).number).toBe(3);
    expect(head - view.state.doc.line(3).from).toBe(3);

    // 같은 노트(대소문자만 달라도): 다시 열지 않고 커서만 옮긴다
    const before = reads();
    await act(() => C().openFile('B.md', { line: 0 }));
    expect(C().activeView()!.state.selection.main.head).toBe(0);
    expect(reads()).toBe(before);
    expect(C().activePath()).toBe('b.md');
  });

  it('openFile while the current note cannot flush does not switch', async () => {
    mount();
    await openAndLoad('a.md');
    typeAtEnd('typed\n');
    vault.failNext('vault_modify', 'io');
    await act(() => C().openFile('b.md'));
    expect(C().activePath()).toBe('a.md');
    expect(openNote('b.md')).toBeUndefined();
    expect(openNote('a.md')).toBeDefined();
  });

  it('refresh() reloads the tree and tells vaultRefresh subscribers', () => {
    const reloadTree = vi.fn();
    mount({ reloadTree });
    const heard = vi.fn();
    const off = vaultRefresh.subscribe(heard);
    C().refresh();
    off();
    C().refresh();
    expect(reloadTree).toHaveBeenCalledTimes(2);
    expect(heard).toHaveBeenCalledTimes(1);
  });
});
