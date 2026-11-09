// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../App';
import { t } from '../i18n/t';
import { closeAllDialogs } from '../labnote/host/dialogStore';
import { clearToasts } from '../labnote/host/toastStore';
import { installFakeVault, type FakeVault } from './fakeVault';

vi.mock('@tauri-apps/api/core', async () => (await import('./fakeVault')).mockTauri().core);
vi.mock('@tauri-apps/api/event', async () => (await import('./fakeVault')).mockTauri().event);
vi.mock('@tauri-apps/api/window', async () => (await import('./fakeVault')).mockTauri().window);
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock('@tauri-apps/plugin-updater', () => ({ check: async () => null }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: async () => {} }));

function legacyVault(): FakeVault {
  return installFakeVault({
    'labnote/002_PCR/README.md': '# PCR\n\n- [ ] [002_WB010_x](002_WB010_x.md)\n',
    'labnote/002_PCR/002_WB010_x.md': '# x\n',
    'notes/other.md': 'wiki [[002_WB010_x]]\n',
  });
}

const offer = () => screen.findByRole('alertdialog', { name: t('legacy.offer.title') });
const settingsOf = (vault: FakeVault) => JSON.parse(vault.settings ?? '{}') as Record<string, unknown>;

afterEach(() => {
  closeAllDialogs();
  clearToasts();
});

describe('보관함을 열 때의 예전 형식 노트 제안', () => {
  it('appears once per open with the note count; Not now renames nothing and does not ask again in this open', async () => {
    const vault = legacyVault();
    render(<App />);
    const dialog = await offer();
    expect(dialog.textContent).toContain(t('legacy.offer.body', 2).split('\n')[0]);
    await userEvent.click(screen.getByRole('button', { name: t('legacy.offer.later') }));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole('alertdialog', { name: t('legacy.offer.title') })).toBeNull();
    expect(Object.keys(vault.files())).toContain('labnote/002_PCR/README.md');
    expect(settingsOf(vault).legacyNotesOfferDismissed).toBe(false);
  });

  it('Convert renames the notes through the rename path and links follow', async () => {
    const vault = legacyVault();
    render(<App />);
    await offer();
    await userEvent.click(screen.getByRole('button', { name: t('legacy.offer.convert') }));
    await waitFor(() => expect(Object.keys(vault.files())).toContain('labnote/002_PCR/README.labnote.md'));
    await waitFor(() => expect(Object.keys(vault.files())).toContain('labnote/002_PCR/002_WB010_x.labnote.md'));
    await waitFor(() => expect(vault.files()['notes/other.md']).toBe('wiki [[002_WB010_x.labnote]]\n'));
    expect(vault.files()['labnote/002_PCR/README.labnote.md']).toContain('[002_WB010_x](002_WB010_x.labnote.md)');
    expect(await screen.findByText(t('legacy.done', 2))).toBeTruthy();
  });

  it("Don't ask again is stored in the vault settings and the next open asks nothing", async () => {
    const vault = legacyVault();
    const first = render(<App />);
    await offer();
    await userEvent.click(screen.getByRole('button', { name: t('legacy.offer.never') }));
    await waitFor(() => expect(settingsOf(vault).legacyNotesOfferDismissed).toBe(true));
    first.unmount();

    render(<App />);
    await screen.findByText('fake-vault', { selector: '.vault-bar-name' });
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.queryByRole('alertdialog', { name: t('legacy.offer.title') })).toBeNull();
    expect(Object.keys(vault.files())).toContain('labnote/002_PCR/README.md');
  });
});
