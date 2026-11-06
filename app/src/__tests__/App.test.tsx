// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../App';

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  dialog: { open: vi.fn(), save: vi.fn() },
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
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
  tauri.invoke.mockImplementation(async (cmd: string, args?: { path?: string }) => {
    if (cmd === 'vault_current') return vaults.first;
    if (cmd === 'vault_open') return args?.path === 'D:/right' ? vaults.second : vaults.first;
    if (cmd === 'vault_tree') return [];
    if (cmd === 'index_rebuild') return { indexed: 0, skipped: 0 };
    if (cmd === 'app_version') return '0.0.0';
    throw new Error(`unexpected ${cmd}`);
  });
});

describe('앱', () => {
  it('보관함을 고른 뒤에도 바꿀 수 있다: 잘못 고른 폴더에 갇히지 않는다', async () => {
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByText('보관함: wrong')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '보관함 바꾸기' }));
    expect(await screen.findByText('노트를 둘 곳을 정하세요')).toBeTruthy();
    expect(screen.queryByText('보관함: wrong')).toBeNull();

    tauri.dialog.open.mockResolvedValue('D:/right');
    await user.click(screen.getByRole('button', { name: '기존 폴더 열기' }));
    await waitFor(() => expect(screen.getByText('보관함: right')).toBeTruthy());
    expect(tauri.invoke).toHaveBeenCalledWith('vault_open', { path: 'D:/right' });
  });
  it('새 노트를 만들면 편집기가 그 노트를 연다', async () => {
    const user = userEvent.setup();
    tauri.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'vault_current') return vaults.first;
      if (cmd === 'vault_tree') return [];
      if (cmd === 'index_rebuild') return { indexed: 0, skipped: 0 };
      if (cmd === 'app_version') return '0.0.0';
      if (cmd === 'vault_exists') return false;
      if (cmd === 'vault_modify') return { kind: 'ok' };
      if (cmd === 'vault_read') return '';
      throw new Error(`unexpected ${cmd}`);
    });
    render(<App />);
    await screen.findByText('보관함: wrong');
    expect(screen.getByText('왼쪽에서 노트를 고르면 여기서 편집합니다.')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '새 노트' }));
    await user.type(screen.getByRole('textbox', { name: '노트 이름' }), 'Day 1{Enter}');

    await waitFor(() => expect(tauri.invoke).toHaveBeenCalledWith('vault_read', { path: 'Day 1.labnote.md' }));
    expect(screen.queryByText('왼쪽에서 노트를 고르면 여기서 편집합니다.')).toBeNull();
    expect(screen.queryByRole('textbox', { name: '노트 이름' })).toBeNull();
  });
  it('레이아웃 영역이 역할로 드러난다: 상단 바, 사이드바, 본문, 상태줄', async () => {
    render(<App />);
    await screen.findByText('보관함: wrong');
    const banner = screen.getByRole('banner');
    expect(within(banner).getByRole('heading', { level: 1, name: 'labnoteO' })).toBeTruthy();
    expect(within(banner).getByRole('button', { name: '보관함 바꾸기' })).toBeTruthy();
    expect(within(banner).getByRole('button', { name: '새 노트' })).toBeTruthy();
    expect(within(banner).getByRole('combobox', { name: '테마' })).toBeTruthy();
    const side = screen.getByRole('complementary', { name: '사이드바' });
    expect(within(side).getByRole('searchbox', { name: '노트 검색' })).toBeTruthy();
    expect(within(side).getByText('노트가 없습니다')).toBeTruthy();
    expect(screen.getAllByRole('main')).toHaveLength(1); // main 안에 main 을 중첩하지 않는다
    expect(within(screen.getByRole('main')).getByText('왼쪽에서 노트를 고르면 여기서 편집합니다.')).toBeTruthy();
    expect(within(screen.getByRole('contentinfo')).getByText(/0\.0\.0/)).toBeTruthy();
  });
  it('보관함을 고르는 화면에도 main 이 하나 있다', async () => {
    tauri.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'vault_current') return null;
      if (cmd === 'app_version') return '0.0.0';
      throw new Error(`unexpected ${cmd}`);
    });
    render(<App />);
    await screen.findByText('노트를 둘 곳을 정하세요');
    expect(screen.getAllByRole('main')).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1, name: 'labnoteO' })).toBeTruthy();
  });
});
