// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setLang } from '../../i18n/lang';
import { t } from '../../i18n/t';
import type { CommandContext } from '../../labnote/commands/context';
import { fromPluginData } from '../../labnote/settings';
import { styleAttributes } from '../../labnote/host/__tests__/harness';
import {
  IntegrationSettingsPage,
  integrationDepsFor,
  type IntegrationDeps,
  type IntegrationSettingsValue,
} from '../IntegrationSettingsDialog';
import { onSecretsChange } from '../probes';
import type { DeleteOutcome, ImportOutcome } from '../importFile';
import type { SecretStatus, Slot } from '../netIpc';
import { fakeInvoke, secretStatusOf } from './fakeNet';

beforeEach(() => setLang('en'));
afterEach(() => cleanup());

const BASE = (() => {
  const s = fromPluginData(undefined);
  return {
    partbankDesktopUrl: s.partbankDesktopUrl,
    partbankWebUrl: s.partbankWebUrl,
    partbankDefaultConnection: s.partbankDefaultConnection,
    partbankSendUsages: s.partbankSendUsages,
    llmProvider: s.llmProvider,
    llmEndpointOllama: s.llmEndpointOllama,
    llmEndpointOpenai: s.llmEndpointOpenai,
    llmModel: s.llmModel,
    bfwUrl: s.bfwUrl,
    bfwConnection: s.bfwConnection,
    allowHttpOrigins: s.allowHttpOrigins,
    worksheetPaperSize: s.worksheetPaperSize,
    scanMaxImageEdge: s.scanMaxImageEdge,
    scanJpegQuality: s.scanJpegQuality,
    scanEmbedWidth: s.scanEmbedWidth,
    mcpEnabled: s.mcpEnabled,
    mcpPort: s.mcpPort,
  } satisfies IntegrationSettingsValue;
})();

const DONE: ImportOutcome = {
  status: 'done',
  imported: [
    { part: 'llm', keySaved: true },
    { part: 'bfworkflow', keySaved: false },
  ],
  invalid: [{ part: 'partbank', field: 'url', reason: 'badUrl' }],
  settings: { llmProvider: 'openai', llmEndpointOpenai: 'https://gw.lab.example/v1', llmModel: 'gpt-x', bfwUrl: 'https://wf.lab.example' },
};

function importDeps(opts: { outcome?: ImportOutcome; path?: string | null; removes?: DeleteOutcome[] } = {}) {
  let current: IntegrationSettingsValue = { ...BASE };
  const keys: Partial<Record<Slot, boolean>> = {};
  const removes = [...(opts.removes ?? ['trashed'])];
  const status = vi.fn(async () => secretStatusOf(keys));
  const io = {
    pick: vi.fn(async () => (opts.path === undefined ? 'C:\\Users\\me\\Downloads\\conn.json' : opts.path)),
    run: vi.fn(async (_path: string) => {
      keys.llmOpenai = true; // Rust 가 키를 저장했다(값은 오지 않는다)
      return opts.outcome ?? DONE;
    }),
    remove: vi.fn(async (_permanent: boolean) => removes.shift() ?? 'gone'),
  };
  const deps: IntegrationDeps = {
    value: () => current,
    commit: vi.fn(async (patch: Partial<IntegrationSettingsValue>) => {
      current = { ...current, ...patch };
    }),
    status,
    setSecret: vi.fn(async () => undefined),
    clearSecret: vi.fn(async () => undefined),
    importFile: io,
  };
  return { deps, io, status, commit: deps.commit as ReturnType<typeof vi.fn> };
}

function show(deps: IntegrationDeps) {
  return render(<IntegrationSettingsPage deps={deps} onLeave={async () => {}} autoFocus />);
}

const importButton = () => screen.findByRole('button', { name: t('integrations.import.button') });

describe('Integration settings: Import from file…', () => {
  it('imports through Rust, saves the settings, shows the summary, refreshes statuses and offers to delete', async () => {
    const seen: SecretStatus[] = [];
    const off = onSecretsChange((s) => seen.push(s));
    const f = importDeps();
    show(f.deps);
    await waitFor(() => expect(f.status).toHaveBeenCalledTimes(1));
    await userEvent.click(await importButton());
    await waitFor(() => expect(f.io.run).toHaveBeenCalledWith('C:\\Users\\me\\Downloads\\conn.json'));
    // 설정은 대화상자의 저장 흐름으로 한 번에 저장된다.
    await waitFor(() => expect(f.commit).toHaveBeenCalledWith(DONE.status === 'done' ? DONE.settings : {}));
    // 요약: 가져온 부분, 건너뛴 부분과 까닭.
    expect(await screen.findByText(t('integrations.import.importedKey', t('integrations.import.part.llm')))).toBeTruthy();
    expect(screen.getByText(t('integrations.import.imported', t('integrations.import.part.bfworkflow')))).toBeTruthy();
    expect(
      screen.getByText(
        t('integrations.import.invalid', t('integrations.import.part.partbank'), 'url', t('integrations.import.reason.badUrl')),
      ),
    ).toBeTruthy();
    // 키 상태를 다시 읽고 구독자에게 알린다. 새 주소가 칸에 보인다.
    await waitFor(() => expect(seen.some((s) => s.set.llmOpenai)).toBe(true));
    expect((screen.getByLabelText('OpenAI endpoint') as HTMLInputElement).value).toBe('https://gw.lab.example/v1');
    expect((screen.getByLabelText('Model') as HTMLInputElement).value).toBe('gpt-x');
    // 지우기 제안 → 휴지통.
    expect(screen.getByText(t('integrations.import.deleteAsk'))).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: t('integrations.import.deleteYes') }));
    expect(f.io.remove).toHaveBeenCalledWith(false);
    expect(await screen.findByText(t('integrations.import.trashed'))).toBeTruthy();
    expect(screen.queryByText(t('integrations.import.deleteAsk'))).toBeNull();
    expect(styleAttributes()).toEqual([]);
    off();
  });

  it('asks again before deleting for good when the Recycle Bin is not available', async () => {
    const f = importDeps({ removes: ['trashUnavailable', 'deleted'] });
    show(f.deps);
    await userEvent.click(await importButton());
    await userEvent.click(await screen.findByRole('button', { name: t('integrations.import.deleteYes') }));
    expect(await screen.findByText(t('integrations.import.permanentAsk'))).toBeTruthy();
    expect(f.io.remove).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: t('integrations.import.permanentYes') }));
    expect(f.io.remove).toHaveBeenLastCalledWith(true);
    expect(await screen.findByText(t('integrations.import.deleted'))).toBeTruthy();
  });

  it('Keep leaves the file and says so', async () => {
    const f = importDeps({ removes: ['trashUnavailable'] });
    show(f.deps);
    await userEvent.click(await importButton());
    await userEvent.click(await screen.findByRole('button', { name: t('integrations.import.deleteYes') }));
    await userEvent.click(await screen.findByRole('button', { name: t('integrations.import.keep') }));
    expect(await screen.findByText(t('integrations.import.kept'))).toBeTruthy();
    expect(f.io.remove).toHaveBeenCalledTimes(1);
  });

  it('a file inside the vault is refused with a clear message: nothing saved, no delete offer', async () => {
    const f = importDeps({ outcome: { status: 'refused', reason: 'insideVault' } });
    show(f.deps);
    await userEvent.click(await importButton());
    expect(await screen.findByText(t('integrations.import.refused.insideVault'))).toBeTruthy();
    expect(f.commit).not.toHaveBeenCalled();
    expect(screen.queryByText(t('integrations.import.deleteAsk'))).toBeNull();
  });

  it('nothing imported: says so and offers no delete', async () => {
    const f = importDeps({
      outcome: { status: 'done', imported: [], invalid: [{ part: 'llm', field: 'apiKey', reason: 'badKey' }], settings: {} },
    });
    show(f.deps);
    await userEvent.click(await importButton());
    expect(await screen.findByText(t('integrations.import.nothing'))).toBeTruthy();
    expect(f.commit).not.toHaveBeenCalled();
    expect(screen.queryByText(t('integrations.import.deleteAsk'))).toBeNull();
  });

  it('a cancelled picker does nothing; a failed import shows an app sentence, not the raw error', async () => {
    const f = importDeps({ path: null });
    show(f.deps);
    await userEvent.click(await importButton());
    await waitFor(() => expect(f.io.pick).toHaveBeenCalled());
    expect(f.io.run).not.toHaveBeenCalled();
    f.io.pick.mockResolvedValue('D:\\conn.env');
    f.io.run.mockRejectedValue({ kind: 'keychain', message: 'raw-rust-text' });
    await userEvent.click(await importButton());
    expect(await screen.findByText(t('integrations.import.failed'))).toBeTruthy();
    expect(document.body.textContent).not.toContain('raw-rust-text');
  });

  it('integrationDepsFor sends only the path and the permanent flag, and keeps only connection settings', async () => {
    const f = fakeInvoke({
      integration_import_file: () => ({
        status: 'done',
        imported: [{ part: 'llm', keySaved: true }],
        invalid: [],
        settings: { llmModel: 'm', mcpEnabled: true, apiKey: 'x' },
      }),
      integration_import_delete: () => 'trashed',
    });
    const ctx = { settings: fromPluginData(undefined), updateSettings: () => {}, host: { notify: () => {} } } as unknown as CommandContext;
    const deps = integrationDepsFor(ctx, f.invoke);
    const out = await deps.importFile!.run('D:\\conn.json');
    expect(out.status === 'done' && out.settings).toEqual({ llmModel: 'm' });
    expect(await deps.importFile!.remove(false)).toBe('trashed');
    expect(f.calls).toEqual([
      ['integration_import_file', { path: 'D:\\conn.json' }],
      ['integration_import_delete', { permanent: false }],
    ]);
  });
});
