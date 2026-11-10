// @vitest-environment jsdom
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../App';
import { linkIndex } from '../links/linkIndex';
import { currentToasts, notify } from '../labnote/host/toastStore';
import { installFakeVault } from './fakeVault';
import { baseInvoke } from './fixtures';

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  /** `vault://changed` subscriptions: none by default; a test can route them to a fake vault. */
  listen: vi.fn(async () => () => {}),
  dialog: { open: vi.fn(), save: vi.fn() },
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: (...a: unknown[]) => tauri.listen(...(a as [])) }));
vi.mock('@tauri-apps/plugin-dialog', () => tauri.dialog);
vi.mock('@tauri-apps/plugin-updater', () => ({ check: async () => null }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: async () => {} }));

const vaults = {
  first: { root: 'D:/wrong', name: 'wrong', hasObsidianConfig: false },
  second: { root: 'D:/right', name: 'right', hasObsidianConfig: false },
};

beforeEach(() => {
  tauri.invoke.mockReset();
  tauri.dialog.open.mockReset();
  tauri.listen.mockReset();
  tauri.listen.mockImplementation(async () => () => {});
  tauri.invoke.mockImplementation(async (cmd: string, args?: { path?: string }) => {
    if (cmd === 'vault_current') return vaults.first;
    if (cmd === 'vault_open') return args?.path === 'D:/right' ? vaults.second : vaults.first;
    if (cmd === 'vault_tree') return [];
    if (cmd === 'index_rebuild') return { indexed: 0, skipped: 0 };
    if (cmd === 'app_version') return '0.0.0';
    if (baseInvoke(cmd, args) !== undefined) return baseInvoke(cmd, args);
    throw new Error(`unexpected ${cmd}`);
  });
});

/** 보관함 줄의 ⇅ 메뉴에서 보관함 바꾸기를 고른다(명령 맥락이 생긴 뒤: 그 전에는 단추가 바로 바꾼다). */
async function switchVault(user: ReturnType<typeof userEvent.setup>) {
  await waitFor(() => expect((screen.getByRole('button', { name: '설정' }) as HTMLButtonElement).disabled).toBe(false));
  await user.click(screen.getByRole('button', { name: '보관함 메뉴' }));
  await user.click(await screen.findByRole('menuitem', { name: '보관함 바꾸기' }));
}

describe('앱', () => {
  it('보관함을 고른 뒤에도 바꿀 수 있다: 잘못 고른 폴더에 갇히지 않는다', async () => {
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByText('wrong', { selector: '.vault-bar-name' })).toBeTruthy();

    await switchVault(user);
    expect(await screen.findByText('노트를 둘 곳을 정하세요')).toBeTruthy();
    expect(screen.queryByText('wrong', { selector: '.vault-bar-name' })).toBeNull();

    tauri.dialog.open.mockResolvedValue('D:/right');
    await user.click(screen.getByRole('button', { name: '기존 폴더 열기' }));
    await waitFor(() => expect(screen.getByText('right', { selector: '.vault-bar-name' })).toBeTruthy());
    expect(tauri.invoke).toHaveBeenCalledWith('vault_open', { path: 'D:/right' });
  });
  it('보관함을 바꾸면 이전 보관함의 알림(스캔 결과의 Details 등)이 사라진다', async () => {
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByText('wrong', { selector: '.vault-bar-name' })).toBeTruthy();
    const run = vi.fn();
    act(() => notify('info', 'Scans: 1 page(s): 1 filed', { ms: 15000, action: { label: 'Details', run } }));
    const mine = () => currentToasts().filter((x) => x.action?.run === run);
    expect(mine()).toHaveLength(1);
    await switchVault(user);
    expect(await screen.findByText('노트를 둘 곳을 정하세요')).toBeTruthy();
    expect(mine()).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });
  it('새 노트를 만들면 편집기가 그 노트를 연다', async () => {
    const user = userEvent.setup();
    tauri.invoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === 'vault_current') return vaults.first;
      if (cmd === 'vault_tree') return [];
      if (cmd === 'index_rebuild') return { indexed: 0, skipped: 0 };
      if (cmd === 'app_version') return '0.0.0';
      if (cmd === 'vault_exists') return false;
      if (cmd === 'vault_modify') return { kind: 'ok' };
      if (cmd === 'vault_read') return '';
      if (baseInvoke(cmd, args) !== undefined) return baseInvoke(cmd, args);
      throw new Error(`unexpected ${cmd}`);
    });
    render(<App />);
    await screen.findByText('wrong', { selector: '.vault-bar-name' });
    expect(screen.getByText("왼쪽에서 노트를 고르거나, 실험 탭의 '새 실험' 또는 Ctrl+P 로 시작하세요.")).toBeTruthy();

    await user.click(within(screen.getByRole('toolbar', { name: '리본' })).getByRole('button', { name: '새 노트' }));
    await user.type(within(await screen.findByRole('dialog', { name: '새 노트' })).getByRole('textbox', { name: '노트 이름' }), 'Day 1{Enter}');

    await waitFor(() => expect(tauri.invoke).toHaveBeenCalledWith('vault_read', { path: 'Day 1.labnote.md' }));
    expect(screen.queryByText("왼쪽에서 노트를 고르거나, 실험 탭의 '새 실험' 또는 Ctrl+P 로 시작하세요.")).toBeNull();
    expect(screen.queryByRole('textbox', { name: '노트 이름' })).toBeNull();
  });
  it('레이아웃 영역이 역할로 드러난다: 리본, 사이드바(보관함 줄), 본문, 상태줄. 상단 바는 없다', async () => {
    render(<App />);
    await screen.findByText('wrong', { selector: '.vault-bar-name' });
    expect(screen.queryByRole('banner')).toBeNull();
    const ribbon = screen.getByRole('toolbar', { name: '리본' });
    expect(within(ribbon).getByRole('button', { name: '새 노트' })).toBeTruthy();
    // 새 노트 단추는 일반 노트를 만든다(단축키는 툴팁에). 실험은 리본의 '새 실험'
    expect(within(ribbon).getByRole('button', { name: '새 노트' }).getAttribute('title')).toBe('새 노트 (Ctrl+N)');
    expect(within(ribbon).getByRole('button', { name: '새 실험' })).toBeTruthy();
    const side = screen.getByRole('complementary', { name: '사이드바' });
    expect(within(side).getByRole('searchbox', { name: '노트 검색' })).toBeTruthy();
    expect(within(side).getByText('노트가 없습니다')).toBeTruthy();
    expect(within(within(side).getByRole('group', { name: '보관함' })).getByRole('button', { name: '보관함 메뉴' })).toBeTruthy();
    expect(screen.getAllByRole('main')).toHaveLength(1); // main 안에 main 을 중첩하지 않는다
    expect(within(screen.getByRole('main')).getByText("왼쪽에서 노트를 고르거나, 실험 탭의 '새 실험' 또는 Ctrl+P 로 시작하세요.")).toBeTruthy();
    // the empty state mentions Ctrl+P
    expect(within(screen.getByRole('main')).getByText(/Ctrl\+P/)).toBeTruthy();
    expect(within(screen.getByRole('contentinfo')).getByText(/0\.0\.0/)).toBeTruthy();
  });
  it('보관함을 고르는 화면에도 main 이 하나 있다', async () => {
    tauri.invoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === 'vault_current') return null;
      if (cmd === 'app_version') return '0.0.0';
      if (baseInvoke(cmd, args) !== undefined) return baseInvoke(cmd, args);
      throw new Error(`unexpected ${cmd}`);
    });
    render(<App />);
    await screen.findByText('노트를 둘 곳을 정하세요');
    expect(screen.getAllByRole('main')).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1, name: 'labnoteO' })).toBeTruthy();
  });
  it('색인하는 동안 상태줄이 알리고, 끝난 뒤 건너뛴 노트 수를 role=status 로 알린다', async () => {
    let finish!: (v: { indexed: number; skipped: number }) => void;
    const pending = new Promise<{ indexed: number; skipped: number }>((r) => (finish = r));
    tauri.invoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === 'vault_current') return vaults.first;
      if (cmd === 'vault_tree') return [];
      if (cmd === 'index_rebuild') return pending;
      if (cmd === 'app_version') return '0.0.0';
      if (baseInvoke(cmd, args) !== undefined) return baseInvoke(cmd, args);
      throw new Error(`unexpected ${cmd}`);
    });
    render(<App />);
    await screen.findByText('wrong', { selector: '.vault-bar-name' });
    const bar = screen.getByRole('contentinfo');
    expect(within(bar).getByText('색인을 만드는 중입니다')).toBeTruthy();
    expect(within(bar).queryByRole('status')).toBeNull();

    finish({ indexed: 3, skipped: 2 });
    await waitFor(() => expect(within(bar).queryByText('색인을 만드는 중입니다')).toBeNull());
    expect(within(bar).getByRole('status').textContent).toContain('2개');
  });
  it('색인에서 건너뛴 노트가 없으면 상태줄에 status 가 없다', async () => {
    render(<App />); // 기본 모의: skipped 0
    await screen.findByText('wrong', { selector: '.vault-bar-name' });
    await waitFor(() => expect(screen.queryByText('색인을 만드는 중입니다')).toBeNull());
    expect(within(screen.getByRole('contentinfo')).queryByRole('status')).toBeNull();
  });
  it('App shows the imported notice once: Obsidian 플러그인 설정을 처음 가져올 때만 알린다', async () => {
    let stored: string | null = null;
    tauri.invoke.mockImplementation(async (cmd: string, args?: { content?: string }) => {
      if (cmd === 'vault_current') return vaults.first;
      if (cmd === 'vault_tree') return [];
      if (cmd === 'index_rebuild') return { indexed: 0, skipped: 0 };
      if (cmd === 'app_version') return '0.0.0';
      if (cmd === 'settings_vault_read') return stored;
      if (cmd === 'settings_import_plugin') return JSON.stringify({ autoSyncUnitOpToc: false, llmApiKey: 'sk-secret' });
      if (cmd === 'vault_exists') return false; // 카탈로그 알림: 아직 카탈로그 파일이 없다
      if (cmd === 'settings_vault_write') {
        stored = args?.content ?? null;
        return null;
      }
      throw new Error(`unexpected ${cmd}`);
    });
    const first = render(<App />);
    await screen.findByText('wrong', { selector: '.vault-bar-name' });
    const notice = await screen.findByText('labnoteO(Obsidian) 설정을 이 보관함으로 가져왔습니다.');
    expect(notice.closest('.notices')).toBeTruthy();
    expect(notice.getAttribute('role')).toBe('status');
    expect(stored).not.toBeNull();
    expect(stored).not.toContain('sk-secret');
    first.unmount();

    render(<App />);
    await screen.findByText('wrong', { selector: '.vault-bar-name' });
    await waitFor(() => expect(tauri.invoke.mock.calls.filter(([c]) => c === 'settings_vault_read')).toHaveLength(2));
    expect(screen.queryByText('labnoteO(Obsidian) 설정을 이 보관함으로 가져왔습니다.')).toBeNull();
    expect(tauri.invoke.mock.calls.filter(([c]) => c === 'settings_import_plugin')).toHaveLength(1);
  });
  it('Ctrl+P 는 명령 팔레트를 연다: 인쇄를 막고, 팔레트가 열린 동안 .shell 은 inert 다', async () => {
    const user = userEvent.setup();
    const { container } = render(<App />);
    await screen.findByText('wrong', { selector: '.vault-bar-name' });
    const button = within(screen.getByRole('toolbar', { name: '리본' })).getByRole('button', { name: '명령 팔레트' }) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false)); // 설정을 읽은 뒤 켜진다
    const e = new KeyboardEvent('keydown', { key: 'p', code: 'KeyP', ctrlKey: true, bubbles: true, composed: true, cancelable: true });
    act(() => {
      button.dispatchEvent(e);
    });
    expect(e.defaultPrevented).toBe(true);
    expect(await screen.findByRole('dialog', { name: '명령' })).toBeTruthy();
    expect(container.querySelector('.shell')!.hasAttribute('inert')).toBe(true);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(container.querySelector('.shell')!.hasAttribute('inert')).toBe(false);
  });
  it('보관함을 고르는 첫 화면에서도 테마를 바꿀 수 있다', async () => {
    tauri.invoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === 'vault_current') return null;
      if (cmd === 'app_version') return '0.0.0';
      if (baseInvoke(cmd, args) !== undefined) return baseInvoke(cmd, args);
      throw new Error(`unexpected ${cmd}`);
    });
    render(<App />);
    await screen.findByText('노트를 둘 곳을 정하세요');
    const user = userEvent.setup();
    const theme = within(screen.getByRole('main')).getByRole('radiogroup', { name: '테마' });
    await user.click(within(theme).getByRole('radio', { name: '어둡게' }));
    expect(within(theme).getByRole('radio', { name: '어둡게' }).getAttribute('aria-checked')).toBe('true');
    expect(within(screen.getByRole('main')).queryByRole('combobox')).toBeNull();
  });
  it('the app follows watcher events into the link index', async () => {
    const vault = installFakeVault({ 'n.md': '[[New]]' });
    tauri.invoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => vault.invoke(cmd, args));
    tauri.listen.mockImplementation(((event: string, handler: Parameters<typeof vault.listen>[1]) => vault.listen(event, handler)) as never);
    render(<App />);
    await screen.findByText('fake-vault', { selector: '.vault-bar-name' });
    await waitFor(() => expect(linkIndex.ready()).toBe(true));
    await vault.mem.write('New.md', '');
    await vault.emitChange('New.md', 'created');
    await waitFor(() => expect(linkIndex.files()).toContain('New.md'));
  });
});
