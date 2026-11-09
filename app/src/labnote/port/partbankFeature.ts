// Ported from app/vendor/labnoteo/src/partbank/partbankFeature.ts:31-175 sha256:6991cdd9569fbcd0
// labnoteO 0.140.2, Apache-2.0.
// Changes: the per-PC key store becomes Windows Credential Manager behind the Rust keychain commands: apiKey() and setApiKey() are removed, and hasKey(kind) reads a cached SecretStatus ('a key is set' plus its epoch) that refresh() reloads and setStatus() replaces; keyEpoch(kind) is new. The constructor takes { settings(), host, invoke? } instead of the plugin, and url(kind) reads settings(). available() always offers ['desktop', 'web'] (this is a desktop app) and returns { kind, origin } with no url or apiKey, and only for an address that is a full origin. probeClient becomes probeMessage(kind, url, apiKey?), which calls partbank_probe and returns { ok, message } for the Integration settings dialog (the plugin's Test connection handler in partbankSettings.ts did the empty and invalid address checks). describeError, describeProbeError and notifyError take an optional client instead of a kind and say the client's origin; a NetError is first mapped through toPartbankError, and the new kinds get app sentences (notConfigured, redirected, insecure, keychain, tooLarge, badRequest), so no raw Rust text reaches the user; describeProbeError says 'Enter the address and the API key first.' for notConfigured. Notices go through host.notify without durations, and the not-configured sentence points at Integration settings (overrideOr('partbank.setupFirst')). registerPartbankProbes is new.
/**
 * The partbank connections this vault knows about, and the one thing every
 * caller needs besides a client: a failure turned into a sentence the user can
 * act on.
 *
 * The API keys live in Windows Credential Manager, per PC and per origin, not
 * per vault (D6). The webview never holds one: it only learns whether a key is
 * set for a connection, and Rust attaches the key to each request itself.
 */
import type { PartbankConnection, SampleSource } from '@labnoteo/core';
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { t } from '../../i18n/t';
import { NetError, partbankProbe, secretStatus, type InvokeFn, type SecretStatus } from '../../integrations/netIpc';
import { registerProbe } from '../../integrations/probes';
import type { AppHost } from '../host/createAppHost';
import { overrideOr } from '../i18n';
import { isOriginUrl, type AppSettings } from '../settings';
import {
  PartbankClient,
  PartbankError,
  connectionForOrigin,
  connectionForSource,
  toPartbankError,
  type PartbankConnectionConfig,
} from './partbankClient';

const SLOT = { desktop: 'partbankDesktop', web: 'partbankWeb' } as const;

export class PartbankFeature {
  /** One client per connection and origin. */
  private readonly clients = new Map<string, PartbankClient>();
  private status: SecretStatus | undefined;
  private readonly invoke: InvokeFn;

  constructor(
    private readonly deps: {
      settings(): AppSettings;
      host: Pick<AppHost, 'notify' | 't'>;
      invoke?: InvokeFn;
    },
  ) {
    this.invoke = deps.invoke ?? tauriInvoke;
  }

  /** Reloads which keys are set. A failed read leaves no connection usable rather than a stale one. */
  async refresh(): Promise<void> {
    try {
      this.setStatus(await secretStatus(this.invoke));
    } catch {
      this.status = undefined;
      this.clients.clear();
    }
  }

  /** The status a key change reported (onSecretsChange). */
  setStatus(status: SecretStatus): void {
    this.status = status;
    this.clients.clear();
  }

  /** Whether a key is stored for a connection's current address. */
  private hasKey(kind: PartbankConnection): boolean {
    return this.status?.set[SLOT[kind]] === true;
  }

  /** How many times the key of a connection changed; usage sync notices a new key by it. */
  keyEpoch(kind: PartbankConnection): number {
    return this.status?.epoch[SLOT[kind]] ?? 0;
  }

  /** The address configured for a connection. */
  url(kind: PartbankConnection): string {
    const settings = this.deps.settings();
    return (kind === 'desktop' ? settings.partbankDesktopUrl : settings.partbankWebUrl).trim();
  }

  /** Which connections can be used: a full origin is saved and a key is stored for it. */
  available(): PartbankConnectionConfig[] {
    const kinds: PartbankConnection[] = ['desktop', 'web'];
    return kinds.flatMap((kind) => {
      const url = this.url(kind);
      return isOriginUrl(url) && this.hasKey(kind) ? [{ kind, origin: new URL(url).origin }] : [];
    });
  }

  /** Whether anything is set up at all; what hides the partbank actions. */
  get configured(): boolean {
    return this.available().length > 0;
  }

  /** A client for one connection, or undefined when it has no key yet. */
  client(kind: PartbankConnection): PartbankClient | undefined {
    const config = this.available().find((c) => c.kind === kind);
    return config ? this.clientFor(config) : undefined;
  }

  /**
   * The connection search and the catalog download use: the chosen default,
   * falling back to the other one when the default has no key.
   */
  defaultClient(): PartbankClient | undefined {
    const available = this.available();
    const preferred = this.deps.settings().partbankDefaultConnection;
    const config = available.find((c) => c.kind === preferred) ?? available[0];
    return config ? this.clientFor(config) : undefined;
  }

  /** The client that can fetch a stored link, or undefined when none matches. */
  clientForSource(source: SampleSource): PartbankClient | undefined {
    const config = connectionForSource(source, this.available());
    return config ? this.clientFor(config) : undefined;
  }

  /** The client for an origin an external caller named; see {@link connectionForOrigin}. */
  clientForOrigin(origin: string): PartbankClient | undefined {
    const config = connectionForOrigin(origin, this.available());
    return config ? this.clientFor(config) : undefined;
  }

  /**
   * "Test connection" with what the fields hold now, saved or not. With no key
   * typed, Rust uses the stored key only when the address is the saved one.
   */
  async probeMessage(kind: PartbankConnection, url: string, apiKey?: string): Promise<{ ok: boolean; message: string }> {
    const address = url.trim();
    if (!address) return { ok: false, message: this.deps.host.t('Enter the address and the API key first.') };
    if (!isOriginUrl(address)) {
      return { ok: false, message: this.deps.host.t('Enter a full address starting with http:// or https://.') };
    }
    const probeClient = new PartbankClient(kind, new URL(address).origin, this.invoke);
    try {
      const me = (await partbankProbe({ connection: kind, url: address, apiKey: apiKey?.trim() || undefined }, this.invoke)) as {
        username?: unknown;
        email?: unknown;
      } | null;
      const name = [me?.username, me?.email].find((v): v is string => typeof v === 'string' && Boolean(v.trim()));
      // Any web server can answer 200 with JSON; partbank's account call names the account.
      if (!name) throw new PartbankError('notPartbank', 200, 'no account in the response');
      return { ok: true, message: this.deps.host.t('Connected as {0}.', name.trim()) };
    } catch (err) {
      return { ok: false, message: this.describeProbeError(err, probeClient) };
    }
  }

  private clientFor(config: PartbankConnectionConfig): PartbankClient {
    const cacheKey = `${config.kind}\u0000${config.origin}`;
    const hit = this.clients.get(cacheKey);
    if (hit) return hit;
    const client = new PartbankClient(config.kind, config.origin, this.invoke);
    this.clients.set(cacheKey, client);
    return client;
  }

  /** What went wrong, said in terms of what to do about it. */
  describeError(err: unknown, client?: PartbankClient): string {
    const host = this.deps.host;
    let e = err;
    if (e instanceof NetError) {
      if (e.kind === 'cancelled') return t('integrations.cancelled');
      e = toPartbankError(e);
    }
    if (!(e instanceof PartbankError)) return String(e);
    const kind = client?.kind ?? this.defaultClient()?.kind ?? 'web';
    const address = client?.origin ?? this.url(kind);
    switch (e.kind) {
      case 'offline':
      case 'timeout':
        return kind === 'desktop'
          ? host.t(
              'Could not reach the partbank app at {0}. Check that it is running, and that its port has not moved.',
              address,
            )
          : host.t('Could not reach the partbank server at {0}.', address);
      case 'unauthorized':
        return host.t(
          'The partbank API key was refused. Issue a new one in partbank under Profile - API Keys (a key lasts at most 365 days).',
        );
      case 'forbidden':
        return host.t('This partbank item is not shared with your account.');
      case 'notFound':
        return host.t('This item is no longer in partbank, or it was never on this server.');
      case 'rateLimited':
        return host.t('partbank is refusing further requests for now. Try again in a minute.');
      case 'notPartbank':
        return host.t('The address answered, but not as partbank does. Check the partbank address in the settings.');
      case 'notConfigured':
        // plugin: 'Set up a partbank connection in the plugin settings first.'
        return overrideOr('partbank.setupFirst');
      case 'redirected':
        return t('integrations.redirected', e.location ?? '?');
      case 'insecure':
        return t('integrations.insecure');
      case 'keychain':
        return t('integrations.keychain');
      case 'tooLarge':
        return t('integrations.tooLarge');
      case 'badRequest':
        return t('integrations.badRequest');
      default:
        return host.t('partbank returned an error ({0}).', String(e.status ?? '?'));
    }
  }

  /**
   * {@link describeError} for Test connection, where the call is the account
   * check: a 404 there means the address has no partbank API, not a missing item,
   * and a missing key means the field is still empty.
   */
  describeProbeError(err: unknown, client?: PartbankClient): string {
    let e = err;
    if (e instanceof NetError && e.kind !== 'cancelled') e = toPartbankError(e);
    if (e instanceof PartbankError && (e.kind === 'notFound' || e.kind === 'notPartbank')) {
      return this.deps.host.t('No partbank API was found at this address. Check the address.');
    }
    if (e instanceof PartbankError && e.kind === 'notConfigured') {
      return this.deps.host.t('Enter the address and the API key first.');
    }
    return this.describeError(e, client);
  }

  /** Show {@link describeError}; returns false so callers can `return notify(...)`. */
  notifyError(err: unknown, client?: PartbankClient): false {
    this.deps.host.notify('error', this.describeError(err, client));
    return false;
  }

  /** Told to the user wherever a partbank action is unavailable. */
  notifyNotConfigured(): void {
    // plugin: 'Set up a partbank connection in the plugin settings first.'
    this.deps.host.notify('info', overrideOr('partbank.setupFirst'));
  }
}

/** The Test connection buttons of the Integration settings dialog for both partbank connections. */
export function registerPartbankProbes(feature: PartbankFeature): () => void {
  const off = (['desktop', 'web'] as const).map((kind) =>
    registerProbe(kind === 'desktop' ? 'partbankDesktop' : 'partbankWeb', (fields) =>
      feature.probeMessage(kind, fields.url, fields.apiKey),
    ),
  );
  return () => off.forEach((f) => f());
}
