import { t } from '../../i18n/t';
import { offerPluginLlmKey } from '../importLlmKey';
import { onSecretsChange, type SecretStatus } from '../secretsEvents';

type Calls = Array<[string, Record<string, unknown>]>;

/** Rust 흉내: 알려진 커맨드만 답하고, 모르는 커맨드는 badInput 으로 거절한다. */
function fakeInvoke(routes: Record<string, (args: Record<string, unknown>) => unknown>) {
  const calls: Calls = [];
  const invoke = async (cmd: string, args: Record<string, unknown> = {}) => {
    calls.push([cmd, args]);
    const route = routes[cmd];
    if (!route) throw { kind: 'badInput', message: `unrouted ${cmd}` };
    return route(args);
  };
  return { invoke: invoke as never, calls };
}

/** confirm 은 정해 둔 답을 돌려주고, 물은 말과 알림을 기록한다. */
function fakeHost(opts: { confirm: boolean }) {
  const asked: Array<[string, unknown]> = [];
  const notices: Array<[string, string]> = [];
  return {
    asked,
    notices,
    confirm: async (message: string, o?: unknown) => {
      asked.push([message, o]);
      return opts.confirm;
    },
    notify: (kind: 'info' | 'warn' | 'error', message: string) => {
      notices.push([kind, message]);
    },
  };
}

const STATUS: SecretStatus = {
  set: { partbankDesktop: false, partbankWeb: false, llmOpenai: true, bfwServer: false, bfwDesktop: false, slackBot: false, ncbiEutils: false, webSearch: false },
  epoch: { partbankDesktop: 0, partbankWeb: 0, llmOpenai: 1, bfwServer: 0, bfwDesktop: 0, slackBot: 0, ncbiEutils: 0, webSearch: 0 },
};

describe('offerPluginLlmKey (D9)', () => {
  it('declining the confirm writes nothing to the keychain and still warns about data.json', async () => {
    const f = fakeInvoke({ settings_import_llm_key: () => true });
    const host = fakeHost({ confirm: false });
    await offerPluginLlmKey(host, f.invoke);
    expect(host.asked).toEqual([[t('ai.importKeyConfirm'), { confirmLabel: t('ai.importKeyYes') }]]);
    expect(f.calls.map(([c]) => c)).not.toContain('settings_import_llm_key');
    expect(host.notices).toContainEqual(['warn', t('ai.importKeyPlaintext')]);
  });

  it('accepting stores through Rust and the value never reaches the webview', async () => {
    const seen: SecretStatus[] = [];
    const off = onSecretsChange((s) => seen.push(s));
    const f = fakeInvoke({ settings_import_llm_key: () => true, secret_status: () => STATUS });
    const host = fakeHost({ confirm: true });
    try {
      await offerPluginLlmKey(host, f.invoke);
    } finally {
      off();
    }
    expect(f.calls.filter(([c]) => c === 'settings_import_llm_key')).toEqual([['settings_import_llm_key', {}]]);
    expect(seen).toEqual([STATUS]);
    expect(host.notices).toContainEqual(['warn', t('ai.importKeyPlaintext')]);
    expect(JSON.stringify(f.calls)).not.toMatch(/sk-/);
  });

  it('a keychain failure is a toast, not a raw Rust error, and the plain-text warning still shows', async () => {
    const f = fakeInvoke({
      settings_import_llm_key: () => {
        throw { kind: 'keychain', message: 'raw-rust-text' };
      },
    });
    const host = fakeHost({ confirm: true });
    await expect(offerPluginLlmKey(host, f.invoke)).resolves.toBeUndefined();
    expect(host.notices).toContainEqual(['error', t('ai.importKeyFailed')]);
    expect(host.notices).toContainEqual(['warn', t('ai.importKeyPlaintext')]);
    expect(JSON.stringify(host.notices)).not.toContain('raw-rust-text');
  });
});
