// @vitest-environment jsdom
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setLang } from '../../i18n/lang';
import { t } from '../../i18n/t';
import type { CommandContext } from '../../labnote/commands/context';
import { fromPluginData, useVaultSettings } from '../../labnote/settings';
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

function importDeps(
  opts: { outcome?: ImportOutcome | null; removes?: DeleteOutcome[]; commitFails?: boolean } = {},
) {
  let current: IntegrationSettingsValue = { ...BASE };
  const keys: Partial<Record<Slot, boolean>> = {};
  const removes = [...(opts.removes ?? ['trashed'])];
  const status = vi.fn(async () => secretStatusOf(keys));
  const io = {
    run: vi.fn(async (): Promise<ImportOutcome | null> => {
      if (opts.outcome === null) return null; // 고르기 취소
      keys.llmOpenai = true; // Rust 가 키를 저장했다(값은 오지 않는다)
      return opts.outcome ?? DONE;
    }),
    runBytes: vi.fn(async (_name: string, _bytes: Uint8Array): Promise<ImportOutcome> => {
      keys.llmOpenai = true;
      return opts.outcome ?? DONE;
    }),
    remove: vi.fn(async (_permanent: boolean) => removes.shift() ?? 'gone'),
  };
  const deps: IntegrationDeps = {
    value: () => current,
    commit: vi.fn(async (patch: Partial<IntegrationSettingsValue>) => {
      if (opts.commitFails) throw new Error('disk full');
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
  it('reads as an optional shortcut: its own heading and description, after the manual sections', async () => {
    setLang('en');
    const f = importDeps();
    show(f.deps);
    const heading = await screen.findByRole('heading', { name: t('integrations.import.heading') });
    const section = heading.closest('section') as HTMLElement;
    expect(section.textContent).toContain(t('integrations.import.intro'));
    expect(section.contains(await importButton())).toBe(true);
    expect(section.contains(screen.getByText(t('integrations.import.dropHere')))).toBe(true);
    // The manual AI fields come first in the pane.
    const ai = screen.getByRole('heading', { name: t('integrations.aiProvider') });
    expect(ai.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(t('integrations.import.heading')).toBe('Import from a file (optional)');
    setLang('ko');
    expect(t('integrations.import.heading')).toBe('파일로 한 번에 가져오기(선택)');
    setLang('en');
  });

  it('imports through Rust, saves the settings, shows the summary, refreshes statuses and offers to delete', async () => {
    const seen: SecretStatus[] = [];
    const off = onSecretsChange((s) => seen.push(s));
    const f = importDeps();
    show(f.deps);
    await waitFor(() => expect(f.status).toHaveBeenCalledTimes(1));
    await userEvent.click(await importButton());
    // Rust 가 고르기 창을 띄운다: 웹뷰는 경로를 보내지 않는다.
    await waitFor(() => expect(f.io.run).toHaveBeenCalledWith());
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
    const f = importDeps({ outcome: null });
    show(f.deps);
    await userEvent.click(await importButton());
    await waitFor(() => expect(f.io.run).toHaveBeenCalledTimes(1));
    expect(f.commit).not.toHaveBeenCalled();
    expect(document.querySelector('[role="status"]')).toBeNull();
    expect(screen.queryByText(t('integrations.import.deleteAsk'))).toBeNull();
    f.io.run.mockRejectedValue({ kind: 'keychain', message: 'raw-rust-text' });
    await userEvent.click(await importButton());
    expect(await screen.findByText(t('integrations.import.failed'))).toBeTruthy();
    expect(document.body.textContent).not.toContain('raw-rust-text');
  });

  it('when saving the imported settings fails, it warns and does not offer to delete the file', async () => {
    const f = importDeps({ commitFails: true });
    show(f.deps);
    await userEvent.click(await importButton());
    expect(await screen.findByText(t('integrations.import.saveFailed'))).toBeTruthy();
    expect(screen.queryByText(t('integrations.import.deleteAsk'))).toBeNull();
    expect(screen.queryByRole('button', { name: t('integrations.import.deleteYes') })).toBeNull();
  });

  it('an LLM import that names no provider, with the stored provider off, says to choose one', async () => {
    const f = importDeps({
      outcome: { status: 'done', imported: [{ part: 'llm', keySaved: true }], invalid: [], settings: { llmModel: 'm' } },
    });
    expect(BASE.llmProvider).toBe('none');
    show(f.deps);
    await userEvent.click(await importButton());
    expect(await screen.findByText(t('integrations.import.chooseProvider'))).toBeTruthy();
    // 공급자를 말한 파일(DONE)에는 이 줄이 없다.
    cleanup();
    const g = importDeps();
    show(g.deps);
    await userEvent.click(await importButton());
    await screen.findByText(t('integrations.import.importedKey', t('integrations.import.part.llm')));
    expect(screen.queryByText(t('integrations.import.chooseProvider'))).toBeNull();
  });

  it('a failed settings_vault_write through useVaultSettings and integrationDepsFor warns and offers no delete', async () => {
    let writes = 0;
    const f = fakeInvoke({
      settings_vault_read: () => '{}',
      settings_vault_write: () => {
        writes++;
        throw { kind: 'io', message: 'raw-rust-text' };
      },
      secret_status: () => secretStatusOf({ llmOpenai: true }),
      integration_import_pick: () => DONE,
      integration_import_delete: () => 'trashed',
    });
    const hook = renderHook(() => useVaultSettings('/vault', f.invoke));
    await waitFor(() => expect(hook.result.current.settings).toBeDefined());
    // 앱의 update 는 던지지 않고 false 로 실패를 알린다.
    let ok: boolean | undefined;
    await act(async () => {
      ok = await hook.result.current.update({ llmModel: 'x' });
    });
    expect(ok).toBe(false);
    const ctx = {
      get settings() {
        return hook.result.current.settings!;
      },
      updateSettings: (p: Partial<IntegrationSettingsValue>) => hook.result.current.update(p),
      host: { notify: () => {} },
    } as unknown as CommandContext;
    const deps = integrationDepsFor(ctx, f.invoke);
    await act(async () => {
      await expect(deps.commit({ llmModel: 'y' })).rejects.toBeTruthy();
    });
    show(deps);
    await userEvent.click(await importButton());
    expect(await screen.findByText(t('integrations.import.saveFailed'))).toBeTruthy();
    expect(writes).toBeGreaterThanOrEqual(3);
    expect(screen.queryByText(t('integrations.import.deleteAsk'))).toBeNull();
    expect(f.calls.some(([cmd]) => cmd === 'integration_import_delete')).toBe(false);
    expect(document.body.textContent).not.toContain('raw-rust-text');
  });

  it('integrationDepsFor asks Rust to pick (title only), drops non-connection settings, and passes a cancel through', async () => {
    let answer: unknown = {
      status: 'done',
      imported: [{ part: 'llm', keySaved: true }],
      invalid: [],
      settings: { llmModel: 'm', mcpEnabled: true, apiKey: 'x' },
    };
    const f = fakeInvoke({ integration_import_pick: () => answer, integration_import_delete: () => 'trashed' });
    const ctx = { settings: fromPluginData(undefined), updateSettings: () => {}, host: { notify: () => {} } } as unknown as CommandContext;
    const deps = integrationDepsFor(ctx, f.invoke);
    const out = await deps.importFile!.run();
    expect(out?.status === 'done' && out.settings).toEqual({ llmModel: 'm' });
    answer = null;
    expect(await deps.importFile!.run()).toBeNull();
    expect(await deps.importFile!.remove(false)).toBe('trashed');
    expect(f.calls).toEqual([
      ['integration_import_pick', { title: t('integrations.import.pickTitle') }],
      ['integration_import_pick', { title: t('integrations.import.pickTitle') }],
      ['integration_import_delete', { permanent: false }],
    ]);
  });

  it('no source file invokes the old path-taking command', () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) {
          if (name !== '__tests__') walk(p);
        } else if (/\.(ts|tsx)$/.test(name) && readFileSync(p, 'utf-8').includes('integration_import_file')) hits.push(p);
      }
    };
    walk('src');
    expect(hits).toEqual([]);
  });
});

/** 끌어 놓은 파일 하나(또는 여럿)를 실은 drop 사건. */
function dropFiles(target: Element, files: File[]) {
  const dataTransfer = { files, types: ['Files'], dropEffect: 'none' };
  fireEvent.dragOver(target, { dataTransfer });
  fireEvent.drop(target, { dataTransfer });
}

const dropZone = () => screen.getByText(t('integrations.import.dropHere')).closest('.integration-drop')!;

describe('Integration settings: drop a connections file', () => {
  it('sends the bytes and name once, saves the settings, and asks the user to delete the original themselves', async () => {
    const f = importDeps();
    show(f.deps);
    await importButton();
    const text = 'LLM_BASE_URL=https://gw.lab.example/v1\nLLM_API_KEY=sk-dropped-secret\n';
    dropFiles(dropZone(), [new File([text], 'conn.env')]);
    await waitFor(() => expect(f.io.runBytes).toHaveBeenCalledTimes(1));
    const [name, bytes] = f.io.runBytes.mock.calls[0]!;
    expect(name).toBe('conn.env');
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBe(new TextEncoder().encode(text).length);
    // 보낸 뒤 버퍼를 0 으로 지운다.
    await waitFor(() => expect(Array.from(bytes).every((b) => b === 0)).toBe(true));
    await waitFor(() => expect(f.commit).toHaveBeenCalledWith(DONE.status === 'done' ? DONE.settings : {}));
    expect(await screen.findByText(t('integrations.import.dropDeleteYourself'))).toBeTruthy();
    // 경로가 없으니 지우기 제안은 없다. 키는 화면 어디에도 없다.
    expect(screen.queryByText(t('integrations.import.deleteAsk'))).toBeNull();
    expect(document.body.innerHTML).not.toContain('sk-dropped-secret');
    expect(f.io.run).not.toHaveBeenCalled();
    expect(styleAttributes()).toEqual([]);
  });

  it('highlights on dragover and clears on dragleave', async () => {
    const f = importDeps();
    show(f.deps);
    await importButton();
    const zone = dropZone();
    fireEvent.dragOver(zone, { dataTransfer: { files: [], types: ['Files'] } });
    expect(zone.classList.contains('over')).toBe(true);
    fireEvent.dragLeave(zone);
    expect(zone.classList.contains('over')).toBe(false);
  });

  it('refuses several files, a file over 64 KiB and another file type, without calling Rust', async () => {
    const f = importDeps();
    show(f.deps);
    await importButton();
    dropFiles(dropZone(), [new File(['a'], 'a.env'), new File(['b'], 'b.env')]);
    expect(await screen.findByText(t('integrations.import.dropOneFile'))).toBeTruthy();
    dropFiles(dropZone(), [new File([new Uint8Array(64 * 1024 + 1)], 'big.json')]);
    expect(await screen.findByText(t('integrations.import.refused.tooLarge'))).toBeTruthy();
    dropFiles(dropZone(), [new File(['x'], 'conn.exe')]);
    expect(await screen.findByText(t('integrations.import.refused.wrongType'))).toBeTruthy();
    expect(f.io.runBytes).not.toHaveBeenCalled();
    expect(f.commit).not.toHaveBeenCalled();
  });

  it('accepts .env, .json, .txt and no extension', async () => {
    const { checkDroppedFiles } = await import('../importFile');
    for (const name of ['.env', 'conn.env', 'CONN.JSON', 'notes.txt', 'connections']) {
      expect(checkDroppedFiles([new File(['x'], name)])).toEqual({ file: expect.any(File) });
    }
    for (const name of ['conn.env.bak', 'a.md', 'run.exe']) {
      expect(checkDroppedFiles([new File(['x'], name)])).toEqual({ refused: 'wrongType' });
    }
    expect(checkDroppedFiles([])).toEqual({ refused: 'oneFile' });
  });

  it('importConnectionsBytes keeps the mcpClientServers list and the mcp summary', async () => {
    const { importConnectionsBytes } = await import('../importFile');
    const servers = [{ id: '0a1b2c3d', name: 'RAPID', url: 'https://rapid.kbiofoundry.kr/mcp', auth: 'bearer', preset: 'rapid', enabled: true, tools: {} }];
    const mcp = [{ id: '0a1b2c3d', name: 'RAPID', origin: 'https://rapid.kbiofoundry.kr', preset: 'rapid', tokenStored: true, needsToken: false }];
    const invoke = (async () => ({
      status: 'done',
      imported: [],
      invalid: [{ part: 'mcpServer', field: 'command', reason: 'stdioSkipped', name: 'fs' }],
      mcp,
      settings: { mcpClientServers: servers, mcpEnabled: true, other: [1] },
    })) as never;
    const out = await importConnectionsBytes('pasted.json', new Uint8Array([123, 125]), invoke);
    expect(out.status === 'done' && out.settings).toEqual({ mcpClientServers: servers });
    expect(out.status === 'done' && out.mcp).toEqual(mcp);
    expect(out.status === 'done' && out.invalid[0]!.name).toBe('fs');
  });

  it('importConnectionsBytes sends a raw body with the encoded name and zeroes the buffer even on failure', async () => {
    const { importConnectionsBytes } = await import('../importFile');
    const seen: unknown[] = [];
    const invoke = (async (cmd: string, body: unknown, options: unknown) => {
      seen.push([cmd, Array.from(body as Uint8Array), options]);
      return { status: 'done', imported: [], invalid: [], settings: { llmModel: 'm', apiKey: 'x' } };
    }) as never;
    const bytes = new Uint8Array([65, 66]);
    const out = await importConnectionsBytes('연결.env', bytes, invoke);
    expect(out.status === 'done' && out.settings).toEqual({ llmModel: 'm' });
    expect(seen).toEqual([['integration_import_bytes', [65, 66], { headers: { 'x-lno-name': '%EC%97%B0%EA%B2%B0.env' } }]]);
    expect(Array.from(bytes)).toEqual([0, 0]);
    const failing = (async () => {
      throw { kind: 'notConfigured', message: 'raw-rust-text' };
    }) as never;
    const again = new Uint8Array([1, 2]);
    await expect(importConnectionsBytes('c.env', again, failing)).rejects.toBeTruthy();
    expect(Array.from(again)).toEqual([0, 0]);
  });
});
