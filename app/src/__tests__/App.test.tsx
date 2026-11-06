// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
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
});
