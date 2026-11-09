// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setLang } from '../../i18n/lang';
import { t } from '../../i18n/t';
import { coreT } from '../../labnote/i18n';
import type { CommandContext } from '../../labnote/commands/context';
import { fromPluginData, type AppSettings } from '../../labnote/settings';
import { styleAttributes } from '../../labnote/host/__tests__/harness';
import {
  IntegrationSettingsDialog,
  integrationDepsFor,
  type IntegrationDeps,
  type IntegrationSettingsValue,
} from '../IntegrationSettingsDialog';
import { onIntegrationChange, onSecretsChange, registerProbe } from '../probes';
import type { SecretStatus, Slot } from '../netIpc';
import { fakeInvoke, secretStatusOf } from './fakeNet';

beforeEach(() => setLang('en'));
afterEach(() => cleanup());

const BASE: IntegrationSettingsValue = (() => {
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
    mcpEnabled: s.mcpEnabled,
    mcpPort: s.mcpPort,
  };
})();

type FakeDeps = IntegrationDeps & {
  order: string[];
  commit: ReturnType<typeof vi.fn>;
  setSecret: ReturnType<typeof vi.fn>;
  clearSecret: ReturnType<typeof vi.fn>;
};

function fakeDeps(value: Partial<IntegrationSettingsValue> = {}, set: Partial<Record<Slot, boolean>> = {}): FakeDeps {
  let current: IntegrationSettingsValue = { ...BASE, ...value };
  const keys: Partial<Record<Slot, boolean>> = { ...set };
  const order: string[] = [];
  return {
    order,
    value: () => current,
    commit: vi.fn(async (patch: Partial<IntegrationSettingsValue>) => {
      order.push('commit');
      current = { ...current, ...patch };
    }),
    status: async () => secretStatusOf(keys),
    setSecret: vi.fn(async (slot: Slot) => {
      order.push('setSecret');
      keys[slot] = true;
    }),
    clearSecret: vi.fn(async (slot: Slot) => {
      order.push('clearSecret');
      keys[slot] = false;
    }),
  };
}

function show(deps: IntegrationDeps) {
  return render(<IntegrationSettingsDialog deps={deps} onDone={() => {}} onCancel={() => {}} />);
}

const keyRow = (input: HTMLElement) => within(input.closest('.integration-key') as HTMLElement);

describe('IntegrationSettingsDialog', () => {
  it('KeyField saves through setSecret, clears the input and never renders the key', async () => {
    const deps = fakeDeps();
    show(deps);
    const input = (await screen.findByLabelText('partbank server API key')) as HTMLInputElement;
    expect(input.type).toBe('password');
    expect(input.getAttribute('autocomplete')).toBe('off');
    expect(input.getAttribute('spellcheck')).toBe('false');
    await userEvent.type(input, 'pbk_secret');
    await userEvent.click(keyRow(input).getByText('Save key'));
    expect(deps.setSecret).toHaveBeenCalledWith('partbankWeb', 'pbk_secret');
    expect(input.value).toBe('');
    expect(document.body.textContent).not.toContain('pbk_secret');
    await waitFor(() => expect(keyRow(input).getByText('Set')).toBeTruthy());
    expect(styleAttributes()).toEqual([]);
  });

  it('KeyField ignores Enter while composing', async () => {
    const deps = fakeDeps();
    show(deps);
    const input = (await screen.findByLabelText('partbank server API key')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '키' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
    await act(async () => {});
    expect(deps.setSecret).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(deps.setSecret).toHaveBeenCalledWith('partbankWeb', '키'));
  });

  it('Save key commits a changed URL before storing the key', async () => {
    const deps = fakeDeps();
    show(deps);
    const url = (await screen.findByLabelText('partbank server address')) as HTMLInputElement;
    const input = screen.getByLabelText('partbank server API key') as HTMLInputElement;
    // 키 칸에 바로 값을 넣는다(주소 칸을 떠나지 않은 채로 저장 단추를 누른 경우).
    fireEvent.change(url, { target: { value: 'https://pb.lab.kr' } });
    fireEvent.change(input, { target: { value: 'pbk_x' } });
    fireEvent.click(keyRow(input).getByText('Save key'));
    await waitFor(() => expect(deps.setSecret).toHaveBeenCalled());
    expect(deps.order).toEqual(['commit', 'setSecret']);
    expect(deps.commit).toHaveBeenCalledWith({ partbankWebUrl: 'https://pb.lab.kr' });
  });

  it('web URL over http warns about clear text; loopback desktop does not', async () => {
    show(fakeDeps({ partbankWebUrl: 'http://10.0.0.5:8000' }));
    const warn = coreT('This address is not encrypted, so the API key is sent in the clear.');
    expect((await screen.findAllByText(warn)).length).toBe(1);
    const desktop = screen.getByLabelText('partbank desktop app address') as HTMLInputElement;
    expect(desktop.value).toBe('http://127.0.0.1:47830');
    expect(desktop.closest('.integration-field')!.textContent).not.toContain(warn);
  });

  it('an http OpenAI endpoint or bfworkflow URL warns about clear text too', async () => {
    show(fakeDeps({ llmProvider: 'openai', llmEndpointOpenai: 'http://gw.lab.kr:8080/v1', bfwUrl: 'http://10.0.0.9' }));
    const warn = coreT('This address is not encrypted, so the API key is sent in the clear.');
    await waitFor(() => expect(screen.getAllByText(warn)).toHaveLength(2));
    expect(screen.getAllByLabelText(t('integrations.allowHttp'))).toHaveLength(2);
  });

  it('a loopback http OpenAI endpoint and a bare host do not warn', async () => {
    show(fakeDeps({ llmProvider: 'openai', llmEndpointOpenai: 'gw.lab.kr' }));
    await screen.findByLabelText(coreT('OpenAI endpoint'));
    expect(screen.queryByText(coreT('This address is not encrypted, so the API key is sent in the clear.'))).toBeNull();
  });

  it('the allow checkbox adds the origin to allowHttpOrigins and removes it again', async () => {
    const deps = fakeDeps({ partbankWebUrl: 'http://10.0.0.5:8000' });
    show(deps);
    const box = (await screen.findByLabelText(t('integrations.allowHttp'))) as HTMLInputElement;
    expect(box.checked).toBe(false);
    await userEvent.click(box);
    expect(deps.commit).toHaveBeenLastCalledWith({ allowHttpOrigins: ['http://10.0.0.5:8000'] });
    expect(box.checked).toBe(true);
    await userEvent.click(box);
    expect(deps.commit).toHaveBeenLastCalledWith({ allowHttpOrigins: [] });
    expect(box.checked).toBe(false);
  });

  it('the usage toggle shows the disclosure text', async () => {
    const deps = fakeDeps();
    show(deps);
    expect(
      await screen.findByText(
        coreT(
          'Lists the lab notes that use a sample from partbank on its partbank page. Note paths, experiment folder names and section titles are stored on the partbank server and shown to you only. Turning this off deletes what this PC sent.',
        ),
      ),
    ).toBeTruthy();
    const toggle = screen.getByLabelText(coreT('Send note usages to partbank')) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    await userEvent.click(toggle);
    expect(deps.commit).toHaveBeenLastCalledWith({ partbankSendUsages: true });
  });

  it('the partbank intro names Windows Credential Manager', async () => {
    show(fakeDeps());
    expect(await screen.findByText(t('integrations.partbankIntro'))).toBeTruthy();
    expect(t('integrations.partbankIntro')).toContain('Windows Credential Manager');
    cleanup();
    setLang('ko');
    show(fakeDeps());
    expect(await screen.findByText(t('integrations.partbankIntro'))).toBeTruthy();
    expect(t('integrations.partbankIntro')).toContain('Windows 자격 증명 관리자');
  });

  it('onIntegrationChange runs after the settings are saved', async () => {
    const order: string[] = [];
    const settings: AppSettings = fromPluginData(undefined);
    const ctx = {
      get settings() {
        return settings;
      },
      updateSettings: async () => {
        await Promise.resolve();
        order.push('updateSettings');
      },
    } as unknown as CommandContext;
    const seen: Array<[boolean, boolean]> = [];
    const off = onIntegrationChange((before, after) => {
      order.push('hook');
      seen.push([before.partbankSendUsages, after.partbankSendUsages]);
    });
    await integrationDepsFor(ctx).commit({ partbankSendUsages: true });
    off();
    expect(order).toEqual(['updateSettings', 'hook']);
    expect(seen).toEqual([[false, true]]);
  });

  it('integrationDepsFor uses the secret commands through invoke', async () => {
    const f = fakeInvoke({
      secret_status: () => secretStatusOf({ llmOpenai: true }),
      secret_set: () => null,
      secret_clear: () => null,
    });
    const ctx = { settings: fromPluginData(undefined), updateSettings: () => {} } as unknown as CommandContext;
    const deps = integrationDepsFor(ctx, f.invoke);
    expect((await deps.status()).set.llmOpenai).toBe(true);
    await deps.setSecret('llmOpenai', 'sk-1');
    await deps.clearSecret('llmOpenai');
    expect(f.calls.map((c) => c[0])).toEqual(['secret_status', 'secret_set', 'secret_clear']);
  });

  it('saving a key notifies onSecretsChange with the new status', async () => {
    const seen: SecretStatus[] = [];
    const off = onSecretsChange((st) => seen.push(st));
    show(fakeDeps());
    const input = (await screen.findByLabelText('partbank server API key')) as HTMLInputElement;
    await userEvent.type(input, 'pbk_1');
    await userEvent.click(keyRow(input).getByText('Save key'));
    await waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0].set.partbankWeb).toBe(true);
    off();
  });

  it('changing a keyed address re-reads the key status, so the badge follows the new origin', async () => {
    // Rust 는 키를 주소(origin)에 묶는다(D6): 주소가 바뀌면 그 칸은 새 주소에서 '설정 안 됨'이다.
    const deps = fakeDeps({ partbankWebUrl: 'https://pb.lab.kr' });
    const status = vi.fn(async () => secretStatusOf({ partbankWeb: deps.value().partbankWebUrl === 'https://pb.lab.kr' }));
    deps.status = status;
    const seen: SecretStatus[] = [];
    const off = onSecretsChange((st) => seen.push(st));
    show(deps);
    const input = (await screen.findByLabelText('partbank server API key')) as HTMLInputElement;
    await waitFor(() => expect(keyRow(input).getByText('Set')).toBeTruthy());
    const reads = status.mock.calls.length;
    const url = screen.getByLabelText('partbank server address') as HTMLInputElement;
    fireEvent.change(url, { target: { value: 'https://pb2.lab.kr' } });
    fireEvent.blur(url);
    await waitFor(() => expect(keyRow(input).getByText('Not set')).toBeTruthy());
    expect(status.mock.calls.length).toBeGreaterThan(reads);
    expect(seen.at(-1)?.set.partbankWeb).toBe(false);
    off();
  });

  it('a non-address setting does not re-read the key status', async () => {
    const deps = fakeDeps();
    const status = vi.fn(deps.status);
    deps.status = status;
    show(deps);
    await screen.findByLabelText('partbank server API key');
    await waitFor(() => expect(status).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByLabelText(coreT('Send note usages to partbank')));
    await act(async () => {});
    expect(status).toHaveBeenCalledTimes(1);
  });

  it('an invalid URL shows the full-address warning and is not committed', async () => {
    const deps = fakeDeps();
    show(deps);
    const url = (await screen.findByLabelText('partbank server address')) as HTMLInputElement;
    await userEvent.clear(url);
    await userEvent.type(url, 'partbank.lab');
    fireEvent.blur(url);
    expect(screen.getByText(coreT('Enter a full address starting with http:// or https://.'))).toBeTruthy();
    expect(deps.commit).not.toHaveBeenCalled();
    // 경로가 붙은 주소도 origin 이 아니라서 거절한다(D8).
    await userEvent.clear(url);
    await userEvent.type(url, 'https://pb.lab.kr/api');
    fireEvent.blur(url);
    expect(deps.commit).not.toHaveBeenCalled();
  });

  it('an emptied endpoint goes back to its default with the plugin notice', async () => {
    const deps = fakeDeps({ llmProvider: 'ollama', llmEndpointOllama: 'http://gpu.lab:11434' });
    show(deps);
    const ep = (await screen.findByLabelText(coreT('Ollama endpoint'))) as HTMLInputElement;
    await userEvent.clear(ep);
    fireEvent.blur(ep);
    expect(deps.commit).toHaveBeenCalledWith({ llmEndpointOllama: 'http://localhost:11434' });
    expect(screen.getByText('The endpoint cannot be empty, so it is back to http://localhost:11434.')).toBeTruthy();
    expect(ep.value).toBe('http://localhost:11434');
    expect(screen.getByText(t('ai.schemeHint'))).toBeTruthy();
  });

  it('provider Disabled hides endpoint, model and key rows', async () => {
    const deps = fakeDeps({ llmProvider: 'openai' });
    show(deps);
    expect(await screen.findByLabelText(coreT('OpenAI endpoint'))).toBeTruthy();
    expect(screen.getByLabelText(coreT('Model'))).toBeTruthy();
    expect(screen.getByLabelText(coreT('API key'))).toBeTruthy();
    await userEvent.selectOptions(screen.getByLabelText(coreT('Provider')), 'none');
    expect(deps.commit).toHaveBeenLastCalledWith({ llmProvider: 'none' });
    expect(screen.queryByLabelText(coreT('OpenAI endpoint'))).toBeNull();
    expect(screen.queryByLabelText(coreT('Ollama endpoint'))).toBeNull();
    expect(screen.queryByLabelText(coreT('Model'))).toBeNull();
    expect(screen.queryByLabelText(coreT('API key'))).toBeNull();
  });

  it('the bfworkflow key slot follows the connection', async () => {
    const deps = fakeDeps();
    show(deps);
    const key = (await screen.findByLabelText(t('integrations.bfw.key'))) as HTMLInputElement;
    fireEvent.change(key, { target: { value: 'bfw_1' } });
    fireEvent.click(keyRow(key).getByText('Save key'));
    await waitFor(() => expect(deps.setSecret).toHaveBeenCalledWith('bfwServer', 'bfw_1'));
    await userEvent.selectOptions(screen.getByLabelText(t('integrations.bfw.connection')), 'desktop');
    expect(deps.commit).toHaveBeenLastCalledWith({ bfwConnection: 'desktop' });
    expect(screen.queryByLabelText(t('integrations.bfw.url'))).toBeNull();
    const key2 = screen.getByLabelText(t('integrations.bfw.key')) as HTMLInputElement;
    fireEvent.change(key2, { target: { value: 'bfw_2' } });
    fireEvent.click(keyRow(key2).getByText('Save key'));
    await waitFor(() => expect(deps.setSecret).toHaveBeenCalledWith('bfwDesktop', 'bfw_2'));
  });

  it('Test connection shows only for a registered probe and prints its message', async () => {
    show(fakeDeps());
    await screen.findByLabelText('partbank server API key');
    expect(screen.queryByText(coreT('Test connection'))).toBeNull();
    cleanup();
    const calls: unknown[] = [];
    const off = registerProbe('partbankWeb', async (fields) => {
      calls.push(fields);
      return { ok: true, message: 'Connected as kim.' };
    });
    show(fakeDeps());
    const input = (await screen.findByLabelText('partbank server API key')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'pbk_try' } });
    const buttons = screen.getAllByText(coreT('Test connection'));
    expect(buttons).toHaveLength(1);
    await userEvent.click(buttons[0]);
    expect(await screen.findByText('Connected as kim.')).toBeTruthy();
    expect(calls).toEqual([{ url: 'https://partbank.kbiofoundry.kr', apiKey: 'pbk_try', connection: 'web' }]);
    off();
  });

  it('Remove key shows only when a key is set', async () => {
    const deps = fakeDeps({}, { partbankWeb: true });
    show(deps);
    const web = (await screen.findByLabelText('partbank server API key')) as HTMLInputElement;
    const desktop = screen.getByLabelText('partbank desktop app API key') as HTMLInputElement;
    await waitFor(() => expect(keyRow(web).getByText('Remove key')).toBeTruthy());
    expect(keyRow(desktop).queryByText('Remove key')).toBeNull();
    expect(keyRow(desktop).getByText('Not set')).toBeTruthy();
    await userEvent.click(keyRow(web).getByText('Remove key'));
    expect(deps.clearSecret).toHaveBeenCalledWith('partbankWeb');
    await waitFor(() => expect(keyRow(web).queryByText('Remove key')).toBeNull());
    expect(keyRow(web).getByText('Not set')).toBeTruthy();
  });

  it('a failed save shows an app sentence, not the raw error', async () => {
    const deps = fakeDeps();
    deps.setSecret.mockImplementation(async () => {
      throw { kind: 'keychain', message: 'raw-rust-text' };
    });
    show(deps);
    const input = (await screen.findByLabelText('partbank server API key')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'pbk_bad' } });
    fireEvent.click(keyRow(input).getByText('Save key'));
    expect(await screen.findByText(t('integrations.keyFailed'))).toBeTruthy();
    expect(document.body.textContent).not.toContain('raw-rust-text');
    expect(document.body.textContent).not.toContain('pbk_bad');
  });
});
