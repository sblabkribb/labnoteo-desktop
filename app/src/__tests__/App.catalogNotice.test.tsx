// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import { ensureWorkflowResources } from '@labnoteo/core/lib/workflowDataLoader';
import { App } from '../App';
import { TauriLabnoteFs } from '../fs/tauriLabnoteFs';
import { clearToasts } from '../labnote/host/toastStore';
import { bundledCatalogHash } from '../labnote/port/catalogUpdate';
import { installFakeVault, type FakeVault } from './fakeVault';

vi.mock('@tauri-apps/api/core', async () => (await import('./fakeVault')).mockTauri().core);
vi.mock('@tauri-apps/api/event', async () => (await import('./fakeVault')).mockTauri().event);
vi.mock('@tauri-apps/api/window', async () => (await import('./fakeVault')).mockTauri().window);
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock('@tauri-apps/plugin-updater', () => ({ check: async () => null }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: async () => {} }));

const WORKFLOWS = 'resources/workflows/workflows_en.json';
const NOTICE = /카탈로그에 새 항목 1개, 바뀐 항목 0개가 있습니다/;

/** 카탈로그를 채운 뒤 번들에 나중에 더해진 WB155 를 뺀 보관함. */
async function outdatedVault(): Promise<FakeVault> {
  const vault = installFakeVault();
  await ensureWorkflowResources(new TauriLabnoteFs(vault.invoke), '.');
  const json = JSON.parse(vault.files()[WORKFLOWS]) as { workflows: Array<{ id: string }> };
  json.workflows = json.workflows.filter((w) => w.id !== 'WB155');
  await vault.mem.write(WORKFLOWS, JSON.stringify(json, null, 2));
  return vault;
}

afterEach(() => clearToasts());

describe('보관함을 열 때의 카탈로그 알림', () => {
  it('catalogNoticeOnOpen runs once after settings load: the toast shows and the bundled hash is stored', async () => {
    const vault = await outdatedVault();
    render(<App />);
    expect(await screen.findByText(NOTICE)).toBeTruthy();
    await waitFor(() => expect(JSON.parse(vault.settings ?? '{}').catalogNoticeHash).toBe(bundledCatalogHash()));
    expect(vault.files()[WORKFLOWS]).not.toContain('"WB155"'); // 알리기만 한다: 쓰지 않는다
  });

  it('with the hash stored, the next open says nothing', async () => {
    const vault = await outdatedVault();
    vault.settings = JSON.stringify({ catalogNoticeHash: bundledCatalogHash() });
    render(<App />);
    await screen.findByText('fake-vault', { selector: '.vault-bar-name' });
    await waitFor(() => expect(vault.log.some((c) => c.cmd === 'settings_vault_read')).toBe(true));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText(NOTICE)).toBeNull();
  });
});
