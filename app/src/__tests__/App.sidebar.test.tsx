// @vitest-environment jsdom
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../App';
import { clearToasts } from '../labnote/host/toastStore';
import { installFakeVault } from './fakeVault';

vi.mock('@tauri-apps/api/core', async () => (await import('./fakeVault')).mockTauri().core);
vi.mock('@tauri-apps/api/event', async () => (await import('./fakeVault')).mockTauri().event);
vi.mock('@tauri-apps/api/window', async () => (await import('./fakeVault')).mockTauri().window);
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock('@tauri-apps/plugin-updater', () => ({ check: async () => null }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: async () => {} }));

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

const README = [
  '---',
  'title: 형광 단백질',
  'status: in-progress',
  '---',
  '',
  '## 🗂️ Related Workflows',
  '',
  '## Summary and Discussion',
  '',
].join('\n');

beforeEach(() => vi.stubGlobal('localStorage', memoryStorage()));
afterEach(() => {
  clearToasts();
  vi.unstubAllGlobals();
});

const tabs = () => within(screen.getByRole('tablist', { name: '사이드바 보기' }));

describe('사이드바 탭', () => {
  it('the Workflows tab is the default for a vault with labnote/ and no stored choice', async () => {
    installFakeVault({ 'labnote/001_GFP/README.labnote.md': README });
    render(<App />);
    await screen.findByText('보관함: fake-vault');
    await waitFor(() => expect(tabs().getByRole('tab', { name: '워크플로' }).getAttribute('aria-selected')).toBe('true'));
    expect(tabs().getByRole('tab', { name: '파일' }).getAttribute('aria-selected')).toBe('false');
    expect(await screen.findByRole('treeitem', { name: /형광 단백질/ })).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: '노트' })).toBeNull();
  });

  it('a vault without labnote/ opens on Files; the chosen tab is kept per vault', async () => {
    const user = userEvent.setup();
    installFakeVault({ 'Day 1.labnote.md': 'x' });
    const first = render(<App />);
    await screen.findByText('보관함: fake-vault');
    expect(await screen.findByRole('navigation', { name: '노트' })).toBeTruthy();
    expect(tabs().getByRole('tab', { name: '파일' }).getAttribute('aria-selected')).toBe('true');

    await user.click(tabs().getByRole('tab', { name: '워크플로' }));
    expect(await screen.findByRole('tree', { name: '실험 목록' })).toBeTruthy();
    first.unmount();

    render(<App />);
    await screen.findByText('보관함: fake-vault');
    await waitFor(() => expect(tabs().getByRole('tab', { name: '워크플로' }).getAttribute('aria-selected')).toBe('true'));
  });

  it("the palette's 'Open workflow view' switches to the Workflows tab", async () => {
    const user = userEvent.setup();
    installFakeVault({ 'Day 1.labnote.md': 'x' });
    render(<App />);
    await screen.findByText('보관함: fake-vault');
    const button = within(screen.getByRole('banner')).getByRole('button', { name: '명령 팔레트 (Ctrl+P)' }) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    await user.click(button);
    await user.type(within(await screen.findByRole('dialog', { name: '명령' })).getByRole('combobox'), '워크플로 뷰 열기');
    await act(async () => {
      await user.keyboard('{Enter}');
    });
    await waitFor(() => expect(tabs().getByRole('tab', { name: '워크플로' }).getAttribute('aria-selected')).toBe('true'));
  });
});
