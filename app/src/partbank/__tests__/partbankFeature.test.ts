/**
 * 옮겨 온 PartbankFeature. 키는 웹뷰에 없다: `hasKey` 는 `secret_status` 의 '설정됨' 여부만 보고, 주소는
 * 설정에서 읽는다. 실패는 사용자가 할 일을 말하는 문장이 되고, Rust 의 원래 글('raw-rust-text')은 나오지 않는다.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { NotifyKind, SampleSource } from '@labnoteo/core';
import { PartbankFeature, registerPartbankProbes } from '../../labnote/port/partbankFeature';
import { PartbankClient, PartbankError, toPartbankError } from '../../labnote/port/partbankClient';
import { coreT } from '../../labnote/i18n';
import { fromPluginData, type AppSettings } from '../../labnote/settings';
import { t } from '../../i18n/t';
import { probeFor } from '../../integrations/probes';
import { fakeInvoke, netError, secretStatusOf } from '../../integrations/__tests__/fakeNet';
import type { InvokeFn, SecretStatus } from '../../integrations/netIpc';

const WEB = 'https://partbank.kbiofoundry.kr';
const DESKTOP = 'http://127.0.0.1:47830';

function setup(
  opts: {
    status?: SecretStatus;
    settings?: Partial<AppSettings>;
    routes?: Record<string, (args: Record<string, unknown>) => unknown>;
  } = {},
) {
  let settings: AppSettings = {
    ...fromPluginData(undefined),
    partbankWebUrl: WEB,
    partbankDesktopUrl: DESKTOP,
    partbankDefaultConnection: 'web',
    ...opts.settings,
  };
  const notes: Array<{ kind: NotifyKind; message: string }> = [];
  const f = fakeInvoke({ secret_status: () => opts.status ?? secretStatusOf({}), ...opts.routes });
  const feature = new PartbankFeature({
    settings: () => settings,
    host: { notify: (kind, message) => void notes.push({ kind, message }), t: coreT },
    invoke: f.invoke,
  });
  return {
    feature,
    notes,
    calls: f.calls,
    invoke: f.invoke as InvokeFn,
    setSettings(p: Partial<AppSettings>) {
      settings = { ...settings, ...p };
    },
  };
}

let unregister: (() => void) | undefined;
afterEach(() => {
  unregister?.();
  unregister = undefined;
});

describe('connections', () => {
  it('configured needs a valid URL and a stored key', async () => {
    const off = setup({ status: secretStatusOf({ partbankWeb: false }) });
    await off.feature.refresh();
    expect(off.feature.configured).toBe(false);

    const on = setup({ status: secretStatusOf({ partbankWeb: true }) });
    expect(on.feature.configured).toBe(false); // refresh 전에는 키가 있는지 모른다
    await on.feature.refresh();
    expect(on.feature.configured).toBe(true);
    expect(on.feature.available()).toEqual([{ kind: 'web', origin: WEB }]);
    expect(on.calls.map((c) => c[0])).toEqual(['secret_status']);

    on.setSettings({ partbankWebUrl: '' });
    expect(on.feature.configured).toBe(false);
    on.setSettings({ partbankWebUrl: 'partbank.kbiofoundry.kr' });
    expect(on.feature.configured).toBe(false);
  });

  it('available offers desktop and web, never with a url or key field', () => {
    const { feature } = setup();
    feature.setStatus(secretStatusOf({ partbankDesktop: true, partbankWeb: true }));
    expect(feature.available()).toEqual([
      { kind: 'desktop', origin: DESKTOP },
      { kind: 'web', origin: WEB },
    ]);
  });

  it('a failed secret_status read leaves every connection unavailable', async () => {
    const { feature } = setup({
      routes: {
        secret_status: () => {
          throw netError('keychain');
        },
      },
    });
    feature.setStatus(secretStatusOf({ partbankWeb: true }));
    await feature.refresh();
    expect(feature.configured).toBe(false);
  });

  it('defaultClient prefers the default connection and falls back to the other', () => {
    const { feature, setSettings } = setup({ settings: { partbankDefaultConnection: 'desktop' } });
    feature.setStatus(secretStatusOf({ partbankDesktop: true, partbankWeb: true }));
    expect(feature.defaultClient()?.kind).toBe('desktop');
    feature.setStatus(secretStatusOf({ partbankWeb: true }));
    expect(feature.defaultClient()?.kind).toBe('web');
    setSettings({ partbankDefaultConnection: 'web' });
    feature.setStatus(secretStatusOf({ partbankDesktop: true }));
    expect(feature.defaultClient()?.kind).toBe('desktop');
    feature.setStatus(secretStatusOf({}));
    expect(feature.defaultClient()).toBeUndefined();
  });

  it('client(kind) gives a client only for an available connection', () => {
    const { feature } = setup();
    feature.setStatus(secretStatusOf({ partbankWeb: true }));
    const web = feature.client('web');
    expect(web).toBeInstanceOf(PartbankClient);
    expect(web?.origin).toBe(WEB);
    expect(feature.client('web')).toBe(web); // 같은 연결은 같은 클라이언트
    expect(feature.client('desktop')).toBeUndefined();
  });

  it('clientForSource and clientForOrigin match only configured connections', () => {
    const { feature } = setup();
    feature.setStatus(secretStatusOf({ partbankWeb: true }));
    expect(feature.clientForOrigin(`${WEB}/`)?.kind).toBe('web');
    expect(feature.clientForOrigin('https://evil.example')).toBeUndefined();
    expect(feature.clientForOrigin(DESKTOP)).toBeUndefined();
    const source = { connection: 'web', origin: WEB, type: 'plasmid', id: 'x' } as unknown as SampleSource;
    expect(feature.clientForSource(source)?.kind).toBe('web');
  });

  it('keyEpoch follows setStatus', () => {
    const { feature } = setup();
    expect(feature.keyEpoch('web')).toBe(0);
    feature.setStatus(secretStatusOf({ partbankWeb: true }, { partbankWeb: 4 }));
    expect(feature.keyEpoch('web')).toBe(4);
    expect(feature.keyEpoch('desktop')).toBe(0);
  });

  it('url(kind) reads the settings, trimmed', () => {
    const { feature } = setup({ settings: { partbankWebUrl: `  ${WEB}  ` } });
    expect(feature.url('web')).toBe(WEB);
    expect(feature.url('desktop')).toBe(DESKTOP);
  });
});

describe('describeError', () => {
  it('describeError names the desktop address when offline', () => {
    const { feature: f, invoke: inv } = setup();
    expect(
      f.describeError(new PartbankError('offline', undefined, 'x'), new PartbankClient('desktop', DESKTOP, inv)),
    ).toBe(
      coreT(
        'Could not reach the partbank app at {0}. Check that it is running, and that its port has not moved.',
        DESKTOP,
      ),
    );
    expect(f.describeError(new PartbankError('timeout', undefined, 'x'), new PartbankClient('web', WEB, inv))).toBe(
      coreT('Could not reach the partbank server at {0}.', WEB),
    );
  });

  it('describeError for notConfigured says to set up partbank in Integration settings', () => {
    const { feature: f } = setup();
    expect(f.describeError(new PartbankError('notConfigured', undefined, 'x'))).toBe(t('partbank.setupFirst'));
  });

  it('a keychain failure gives the Credential Manager sentence, never a raw string', () => {
    const { feature: f } = setup();
    expect(f.describeError(toPartbankError(netError('keychain')))).toBe(t('integrations.keychain'));
    expect(f.describeError(netError('keychain'))).toBe(t('integrations.keychain'));
  });

  it('redirected names the target origin', () => {
    const { feature: f } = setup();
    expect(f.describeError(toPartbankError(netError('redirect', { location: 'https://pb.example' })))).toBe(
      t('integrations.redirected', 'https://pb.example'),
    );
  });

  it('the other new kinds have their own sentences', () => {
    const { feature: f } = setup();
    expect(f.describeError(toPartbankError(netError('insecure')))).toBe(t('integrations.insecure'));
    expect(f.describeError(toPartbankError(netError('tooLarge')))).toBe(t('integrations.tooLarge'));
    expect(f.describeError(toPartbankError(netError('forbiddenPath')))).toBe(t('integrations.badRequest'));
  });

  it('status kinds keep the plugin sentences', () => {
    const { feature: f } = setup();
    expect(f.describeError(new PartbankError('unauthorized', 401, 'x'))).toBe(
      coreT(
        'The partbank API key was refused. Issue a new one in partbank under Profile - API Keys (a key lasts at most 365 days).',
      ),
    );
    expect(f.describeError(new PartbankError('server', 502, 'x'))).toBe(coreT('partbank returned an error ({0}).', '502'));
  });

  it('no NetError kind ever shows the raw Rust text', () => {
    const { feature: f } = setup();
    for (const kind of ['offline', 'tls', 'timeout', 'notJson', 'status', 'keyMissing', 'redirect', 'cancelled'] as const) {
      expect(f.describeError(netError(kind, { status: 500 }))).not.toContain('raw-rust-text');
    }
  });
});

describe('probes', () => {
  it('describeProbeError for notFound says no partbank API was found', () => {
    const { feature: f } = setup();
    const want = coreT('No partbank API was found at this address. Check the address.');
    expect(f.describeProbeError(new PartbankError('notFound', 404, 'x'))).toBe(want);
    expect(f.describeProbeError(new PartbankError('notPartbank', 200, 'x'))).toBe(want);
  });

  it('probeMessage returns Connected as {0}.', async () => {
    const { feature: f, calls } = setup({ routes: { partbank_probe: () => ({ username: 'kim' }) } });
    await expect(f.probeMessage('web', ` ${WEB} `, 'pbk_typed')).resolves.toEqual({
      ok: true,
      message: coreT('Connected as {0}.', 'kim'),
    });
    expect(calls).toEqual([['partbank_probe', { connection: 'web', url: WEB, apiKey: 'pbk_typed' }]]);
  });

  it('probeMessage with nothing typed asks for address and key', async () => {
    const { feature: f, calls } = setup();
    await expect(f.probeMessage('web', '  ')).resolves.toEqual({
      ok: false,
      message: coreT('Enter the address and the API key first.'),
    });
    expect(calls).toEqual([]);
  });

  it('probeMessage refuses an address that is not a full origin without calling Rust', async () => {
    const { feature: f, calls } = setup();
    await expect(f.probeMessage('web', 'partbank.kbiofoundry.kr', 'k')).resolves.toEqual({
      ok: false,
      message: coreT('Enter a full address starting with http:// or https://.'),
    });
    expect(calls).toEqual([]);
  });

  it('probe keyMissing asks for the address and the key', async () => {
    const { feature: f } = setup({
      routes: {
        partbank_probe: () => {
          throw netError('keyMissing');
        },
      },
    });
    await expect(f.probeMessage('web', WEB, '')).resolves.toEqual({
      ok: false,
      message: coreT('Enter the address and the API key first.'),
    });
  });

  it('probe offline names the typed address, and a reply with no account is not partbank', async () => {
    const offline = setup({
      routes: {
        partbank_probe: () => {
          throw netError('offline');
        },
      },
    });
    await expect(offline.feature.probeMessage('desktop', 'http://127.0.0.1:5000')).resolves.toEqual({
      ok: false,
      message: coreT(
        'Could not reach the partbank app at {0}. Check that it is running, and that its port has not moved.',
        'http://127.0.0.1:5000',
      ),
    });
    const empty = setup({ routes: { partbank_probe: () => ({ ok: true }) } });
    await expect(empty.feature.probeMessage('web', WEB, 'k')).resolves.toEqual({
      ok: false,
      message: coreT('No partbank API was found at this address. Check the address.'),
    });
  });

  it('registerPartbankProbes registers both probes and removes them', async () => {
    const { feature: f } = setup({ routes: { partbank_probe: (a) => ({ username: String(a.connection) }) } });
    unregister = registerPartbankProbes(f);
    await expect(probeFor('partbankDesktop')?.({ url: DESKTOP })).resolves.toEqual({
      ok: true,
      message: coreT('Connected as {0}.', 'desktop'),
    });
    await expect(probeFor('partbankWeb')?.({ url: WEB, apiKey: 'k' })).resolves.toEqual({
      ok: true,
      message: coreT('Connected as {0}.', 'web'),
    });
    unregister();
    unregister = undefined;
    expect(probeFor('partbankDesktop')).toBeUndefined();
    expect(probeFor('partbankWeb')).toBeUndefined();
  });
});

describe('notices', () => {
  it('notifyNotConfigured points at Integration settings', () => {
    const { feature: f, notes } = setup();
    f.notifyNotConfigured();
    expect(notes).toEqual([{ kind: 'info', message: t('partbank.setupFirst') }]);
  });

  it('notifyError shows the described error and returns false', () => {
    const { feature: f, notes } = setup();
    expect(f.notifyError(new PartbankError('rateLimited', 429, 'x'))).toBe(false);
    expect(notes).toEqual([
      { kind: 'error', message: coreT('partbank is refusing further requests for now. Try again in a minute.') },
    ]);
  });
});
