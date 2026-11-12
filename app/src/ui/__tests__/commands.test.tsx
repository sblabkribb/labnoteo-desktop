// @vitest-environment jsdom
/**
 * UI 재설계 Task 12: 모든 동작은 등록된 명령이다(명세 §5.5). 리본·머리 단추의 명령 id, 새 명령의 이름, 팔레트의 kbd 칩과
 * 최근 명령, Ctrl+O 빠른 이동(UO 로 가기, 첨부 열기).
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { useRef } from 'react';
import { catalogs } from '../../i18n/t';
import { setLang } from '../../i18n/lang';
import type { AppFs } from '../../fs/tauriLabnoteFs';
import type { CommandContext } from '../../labnote/commands/context';
import { clearCommandsForTest, commandById } from '../../labnote/commands/registry';
import { registerAllCommands } from '../../labnote/commands/registerAll';
import { createAppHost } from '../../labnote/host/createAppHost';
import { DialogLayer } from '../../labnote/host/DialogLayer';
import { closeAllDialogs, currentDialog, openDialog, pickDialog } from '../../labnote/host/dialogStore';
import { publishExperimentTree } from '../../labnote/panel/experimentTreeSnapshot';
import { clearToasts } from '../../labnote/host/toastStore';
import { EditorActions, NoteQrButton } from '../../labnote/ui/EditorActions';
import { openPalette } from '../../labnote/ui/CommandPalette';
import type { ExpNode } from '../../labnote/panel/experimentTree';
import { appCommandById, appCommands, clearAppCommandsForTest, findCommand, registerAllAppCommands } from '../../editor/commands/appCommands';
import { StatusChip } from '../Breadcrumb';
import { Ribbon } from '../Ribbon';
import { NavButtons } from '../ViewHeader';
import { runQuickSwitcher } from '../quickSwitcher';
import { shellShortcut } from '../shellKeys';

const EXP = 'labnote/001_Plasmid_build';
const README_PATH = `${EXP}/README.labnote.md`;
const WF = `${EXP}/001_WB030_pUC19_assembly.labnote.md`;
const CSV = `${EXP}/resources/plate.csv`;

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

function makeCtx(over: Partial<CommandContext> = {}): CommandContext {
  const host = createAppHost({ fs: {} as AppFs, editTarget: () => undefined, openFile: async () => undefined });
  return {
    host,
    vaultRoot: 'C:/vault',
    settings: {} as CommandContext['settings'],
    updateSettings: () => undefined,
    activePath: () => undefined,
    activeView: () => undefined,
    openFile: vi.fn(async () => undefined),
    closeActive: async () => true,
    refresh: () => undefined,
    showPanel: () => undefined,
    treeFiles: () => [README_PATH, WF, CSV, 'Inbox.md'],
    ...over,
  };
}

function Layer() {
  const shell = useRef<HTMLDivElement>(null);
  return (
    <>
      <div className="shell" ref={shell} />
      <DialogLayer blockRef={shell} />
    </>
  );
}

const TREE = [
  {
    kind: 'experiment',
    id: `exp:${EXP}`,
    dir: EXP,
    readme: README_PATH,
    num: '001',
    title: 'Plasmid build',
    status: 'in-progress',
    workflows: [
      {
        kind: 'workflow',
        id: `wf:${WF}`,
        path: WF,
        code: 'WB030',
        alias: 'pUC19 조립',
        name: 'DNA Assembly',
        ticked: false,
        uos: [
          { kind: 'uo', id: `uo:${WF}#8`, code: 'UHW100', alias: '벡터 증폭', name: 'PCR', line: 8, done: false },
          { kind: 'uo', id: `uo:${WF}#20`, code: 'UHW250', alias: 'Transformation', name: 'Transformation', line: 20, done: false },
        ],
      },
    ],
    entry: {},
  },
] as unknown as ExpNode[];

const options = () => screen.queryAllByRole('option');
const labelOf = (o: HTMLElement) => o.querySelector('.picker-label')?.textContent;

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  registerAllCommands();
  registerAllAppCommands();
});
afterEach(() => {
  act(() => closeAllDialogs());
  publishExperimentTree(undefined);
  cleanup();
  clearCommandsForTest();
  clearAppCommandsForTest();
  clearToasts();
  vi.unstubAllGlobals();
  act(() => setLang('ko'));
});

/** src 아래의 .tsx(테스트 빼고)에 적힌 data-command-id="…" 글자들. */
function sourceCommandIds(): string[] {
  const ids: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name !== '__tests__') walk(full);
      } else if (name.endsWith('.tsx')) {
        for (const m of readFileSync(full, 'utf8').matchAll(/data-command-id="([^"]+)"/g)) ids.push(m[1]);
      }
    }
  };
  walk('src');
  return ids;
}

describe('everything is a command (Task 12)', () => {
  it('every ribbon and header button names a registered command', () => {
    const ctx = makeCtx();
    render(
      <>
        <Ribbon onCommand={() => undefined} leftHidden={false} rightOpen={false} ready />
        <NavButtons canBack canForward onBack={() => undefined} onForward={() => undefined} />
        <StatusChip status="in-progress" onClick={() => undefined} />
        <EditorActions ctx={ctx} path={WF} disabled={false} />
        <EditorActions ctx={ctx} path={README_PATH} disabled={false} />
        <NoteQrButton ctx={ctx} path={WF} disabled={false} />
      </>,
    );
    // 단추마다 명령 id 가 있다: 속성 없이 새로 단 단추도 여기서 걸린다
    const bare = [...document.querySelectorAll('button')].filter((b) => !b.hasAttribute('data-command-id'));
    expect(bare.map((b) => b.getAttribute('aria-label') ?? b.textContent)).toEqual([]);
    const rendered = [...document.querySelectorAll('[data-command-id]')].map((el) => el.getAttribute('data-command-id')!);
    expect(rendered.length).toBeGreaterThanOrEqual(13);
    const ids = [...new Set([...rendered, ...sourceCommandIds()])];
    expect(ids).toEqual(expect.arrayContaining(['app.toggleLeft', 'app.back', 'editor-toggle-source', 'app.showSystemFiles']));
    expect(ids.filter((id) => !findCommand(id))).toEqual([]);
  });

  it('the new commands are registered with ko and en names', () => {
    const ids = [
      'app.toggleLeft',
      'app.toggleRight',
      'app.quickSwitcher',
      'app.palette',
      'app.settings',
      'app.appearance',
      'app.theme.system',
      'app.theme.light',
      'app.theme.dark',
      'app.lang.ko',
      'app.lang.en',
      'app.switchVault',
      'app.newNote',
      'app.back',
      'app.forward',
      'app.showSystemFiles',
      'app.revealInTree',
      'editor.insert.table',
      'editor.insert.callout',
      'editor.insert.codeBlock',
      'editor.insert.hr',
      'editor.insert.mathBlock',
      'github.uploadExperiment',
      'github.openOnGithub',
      'github.finishUpload',
      'github.disconnect',
    ];
    for (const id of ids) {
      const c = appCommandById(id);
      expect(c, id).toBeTruthy();
      expect(catalogs.ko[c!.nameKey], id).toBeTruthy();
      expect(catalogs.en[c!.nameKey], id).toBeTruthy();
    }
    // 넣기 묶음의 날짜와 이슈 표시는 플러그인 명령이다
    expect(commandById('insert-date')).toBeTruthy();
    expect(commandById('insert-issue-marker')).toBeTruthy();
    // 팔레트 자신을 여는 명령은 팔레트에 두지 않는다
    expect(appCommands().filter((c) => c.inPalette === false).map((c) => c.id)).toEqual(['app.palette']);
  });

  it('the palette shows a kbd chip for Ctrl+\\ and an icon on each command row; names carry no shortcut text', async () => {
    render(<Layer />);
    const ctx = makeCtx();
    act(() => void openPalette(ctx));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.classList.contains('palette')).toBe(true);
    const row = options().find((o) => labelOf(o) === catalogs.ko['cmd.toggleLeft'])!;
    expect(row).toBeTruthy();
    expect(row.querySelector('kbd')?.textContent).toBe('Ctrl+\\');
    expect(row.querySelector('.picker-icon svg')).toBeTruthy();
    expect(options().some((o) => labelOf(o) === catalogs.ko['palette.open'])).toBe(false);
    expect(within(dialog).getByText('↑↓ 이동 · Enter 실행 · Esc 닫기')).toBeTruthy();
  });

  it('typed characters are marked in the matching names', async () => {
    const user = userEvent.setup();
    render(<Layer />);
    act(() => void openPalette(makeCtx()));
    await user.type(await screen.findByRole('combobox'), '사이드바');
    const marks = options()[0].querySelectorAll('.picker-label mark');
    expect([...marks].map((m) => m.textContent)).toEqual(['사이드바']);
  });

  it('recent commands come first, remembered by id', async () => {
    const user = userEvent.setup();
    render(<Layer />);
    const ctx = makeCtx();
    act(() => void openPalette(ctx));
    await user.type(await screen.findByRole('combobox'), 'app.showSystemFiles');
    expect(labelOf(options()[0])).toBe(catalogs.ko['palette.cmd.app.showSystemFiles']);
    await user.keyboard('{Enter}');
    await waitFor(() => expect(currentDialog()).toBeNull());
    act(() => void openPalette(ctx));
    await screen.findByRole('dialog');
    expect(labelOf(options()[0])).toBe(catalogs.ko['palette.cmd.app.showSystemFiles']);
    expect(screen.getByText('최근 사용')).toBeTruthy();
    // 최근 다음은 목적별 묶음이 머리와 함께 차례대로 온다
    const groups = screen.getAllByRole('group');
    expect(groups.map((g) => g.querySelector('.picker-group')?.textContent)).toEqual(['최근 사용', '노트·편집', '실험·Workflow·Unit Operation', '샘플', 'AI·어시스턴트', '연결 서비스', '보기·창', '설정·도움말']);
    expect(within(groups[1]).getAllByRole('option').length).toBeGreaterThan(5);
    // 언어를 바꿔도 같은 명령이 맨 위다(이름이 아니라 id 로 기억한다)
    act(() => closeAllDialogs());
    act(() => setLang('en'));
    act(() => void openPalette(ctx));
    await screen.findByRole('dialog');
    expect(labelOf(options()[0])).toBe(catalogs.en['palette.cmd.app.showSystemFiles']);
  });
});

describe('pickers close on an outside click', () => {
  it('a mousedown on the backdrop cancels the palette and the quick switcher, not a click inside', async () => {
    render(<Layer />);
    const ctx = makeCtx();
    let done: Promise<void> = Promise.resolve();
    act(() => void (done = openPalette(ctx)));
    const dialog = await screen.findByRole('dialog');
    fireEvent.mouseDown(screen.getByRole('combobox'));
    fireEvent.mouseDown(dialog);
    expect(currentDialog()).not.toBeNull();
    fireEvent.mouseDown(document.querySelector('.dialog-backdrop')!);
    await waitFor(() => expect(currentDialog()).toBeNull());
    await done;

    done = runQuickSwitcher(ctx, { tree: async () => TREE });
    await screen.findByRole('dialog', { name: '빠른 이동' });
    fireEvent.mouseDown(document.querySelector('.dialog-backdrop')!, { button: 2 });
    expect(currentDialog()).not.toBeNull();
    fireEvent.mouseDown(document.querySelector('.dialog-backdrop')!);
    await done;
    expect(currentDialog()).toBeNull();
    expect(ctx.openFile).not.toHaveBeenCalled();
  });

  it('any single picker resolves undefined on an outside click; a confirm dialog stays open', async () => {
    render(<Layer />);
    let picked: Promise<string | undefined> = Promise.resolve('x');
    act(() => void (picked = pickDialog([{ label: 'A', value: 'a' }])));
    await screen.findByRole('dialog');
    fireEvent.mouseDown(document.querySelector('.dialog-backdrop')!);
    expect(await picked).toBeUndefined();

    act(() => void openDialog({ kind: 'confirm', message: '지울까요?' }, false));
    await screen.findByRole('alertdialog');
    fireEvent.mouseDown(document.querySelector('.dialog-backdrop')!);
    expect(currentDialog()?.spec.kind).toBe('confirm');
  });
});

describe('quick switcher (Ctrl+O)', () => {
  it('opens at once with notes and attachments, says it is reading UOs, then adds the UO rows', async () => {
    const user = userEvent.setup();
    render(<Layer />);
    const ctx = makeCtx();
    let finish: (tree: readonly ExpNode[]) => void = () => undefined;
    const done = runQuickSwitcher(ctx, { tree: () => new Promise((resolve) => (finish = resolve)) });
    const dialog = await screen.findByRole('dialog', { name: '빠른 이동' });
    expect(options().map(labelOf)).toEqual(expect.arrayContaining(['Inbox', 'plate.csv']));
    expect(within(dialog).getByRole('status').textContent).toBe('UO 목록을 읽는 중…');
    await user.type(screen.getByRole('combobox'), 'UHW100');
    expect(options().map(labelOf)).not.toContain('WB030 pUC19 조립 › UHW100 벡터 증폭');
    act(() => finish(TREE));
    await waitFor(() => expect(labelOf(options()[0])).toBe('WB030 pUC19 조립 › UHW100 벡터 증폭'));
    expect(within(dialog).queryByRole('status')).toBeNull();
    // 받은 검색어는 그대로다
    expect((screen.getByRole('combobox') as HTMLInputElement).value).toBe('UHW100');
    act(() => closeAllDialogs());
    await done;
  });

  it("uses the experiment tab's tree when it is open: UO rows are there at once, nothing is read", async () => {
    render(<Layer />);
    const read = vi.fn(async () => '');
    const ctx = makeCtx({ host: createAppHost({ fs: { read, list: read } as unknown as AppFs, editTarget: () => undefined, openFile: async () => undefined }) });
    publishExperimentTree(TREE);
    const done = runQuickSwitcher(ctx);
    const dialog = await screen.findByRole('dialog', { name: '빠른 이동' });
    expect(options().map(labelOf)).toContain('WB030 pUC19 조립 › UHW100 벡터 증폭');
    expect(within(dialog).queryByRole('status')).toBeNull();
    expect(read).not.toHaveBeenCalled();
    act(() => closeAllDialogs());
    await done;
  });

  it('Ctrl+O (also on a Korean layout) is the quick switcher command; it opens the switcher', async () => {
    const e = new KeyboardEvent('keydown', { key: 'ㅐ', code: 'KeyO', ctrlKey: true });
    expect(shellShortcut(e)).toBe('app.quickSwitcher');
    expect(shellShortcut(new KeyboardEvent('keydown', { key: 'o', code: 'KeyO', ctrlKey: true, altKey: true }))).toBeUndefined();
    expect(shellShortcut(new KeyboardEvent('keydown', { key: '₩', code: 'Backslash', ctrlKey: true }))).toBe('app.toggleLeft');
    expect(shellShortcut(new KeyboardEvent('keydown', { key: '|', code: 'Backslash', ctrlKey: true, shiftKey: true }))).toBe('app.toggleRight');
    render(<Layer />);
    const ctx = makeCtx();
    act(() => void findCommand(shellShortcut(e)!)!.run(ctx));
    const dialog = await screen.findByRole('dialog', { name: '빠른 이동' });
    expect(dialog.classList.contains('palette')).toBe(true);
    expect(options().map(labelOf)).toEqual(expect.arrayContaining(['Inbox', 'README', '001_WB030_pUC19_assembly', 'plate.csv']));
  });

  it("'UHW100' lists the UO as `WB030 … › UHW100 …`; Enter opens the workflow note at its heading", async () => {
    const user = userEvent.setup();
    render(<Layer />);
    const ctx = makeCtx();
    const done = runQuickSwitcher(ctx, { tree: async () => TREE });
    await user.type(await screen.findByRole('combobox'), 'UHW100');
    expect(labelOf(options()[0])).toBe('WB030 pUC19 조립 › UHW100 벡터 증폭');
    expect(options()[0].querySelector('.picker-label mark')?.textContent).toBe('UHW100');
    await user.keyboard('{Enter}');
    await done;
    expect(ctx.openFile).toHaveBeenCalledWith(WF, { line: 8 });
  });

  it('the workflow code finds its note, and an attachment result opens in a viewer', async () => {
    const user = userEvent.setup();
    render(<Layer />);
    const ctx = makeCtx();
    let done = runQuickSwitcher(ctx, { tree: async () => TREE });
    await user.type(await screen.findByRole('combobox'), 'WB030');
    expect(labelOf(options()[0])).toBe('001_WB030_pUC19_assembly');
    act(() => closeAllDialogs());
    await done;

    done = runQuickSwitcher(ctx, { tree: async () => TREE });
    await user.type(await screen.findByRole('combobox'), 'plate');
    const row = options()[0];
    expect(labelOf(row)).toBe('plate.csv');
    expect(row.querySelector('.picker-icon svg')).toBeTruthy();
    await user.keyboard('{Enter}');
    await done;
    // 노트가 아닌 경로는 App 의 openFile(navigate)이 편집기 대신 보기(그림, 표, 파일 카드)로 연다
    expect(ctx.openFile).toHaveBeenLastCalledWith(CSV, undefined);
  });
});
