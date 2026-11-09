// bfworkflow in the app: readiness (is a key set for the current connection),
// the connection test registered with the Integration settings dialog, and the
// user sentences for every bfworkflow error. Written fresh (D5).
import { t } from '../i18n/t';
import type { CommandContext } from '../labnote/commands/context';
import { bfwProbe, NetError, secretStatus, type InvokeFn, type SecretStatus } from '../integrations/netIpc';
import { onIntegrationChange, registerProbe, type ProbeFn } from '../integrations/probes';
import { onSecretsChange } from '../integrations/secretsEvents';

type BfwConnection = 'server' | 'desktop';

/** The last key status this module saw: `secret_status` at start, then every `onSecretsChange`. */
let cached: SecretStatus | undefined;
/** Bumped by every start and stop: a stopped start never writes the status again. */
let generation = 0;
/** Bumped by every status change, so a late `secret_status` answer never overwrites a newer status. */
let statusVersion = 0;

function setStatus(s: SecretStatus | undefined): void {
  cached = s;
  statusVersion++;
}

/** A key for the current connection (`bfwServer` or `bfwDesktop`) is set. Uses the cached status. */
export function bfwReady(ctx: CommandContext): boolean {
  if (!cached) return false;
  return ctx.settings.bfwConnection === 'desktop' ? cached.set.bfwDesktop : cached.set.bfwServer;
}

/** The origin of a URL, or the text as it is when it is not a URL. */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/**
 * The user sentence for a bfworkflow failure. Never Rust's own `message`: the text comes from the kind.
 * `scope` is the scope the failed call needs, named on a 403.
 */
export function bfwErrorText(err: unknown, opts: { connection: BfwConnection; url: string; scope?: 'read' | 'ai' }): string {
  if (!(err instanceof NetError)) return t('bfw.failed', '?');
  switch (err.kind) {
    case 'offline':
      return t('bfw.offline', originOf(opts.url));
    case 'notConfigured':
    case 'keyMissing':
      return opts.connection === 'desktop' && err.kind === 'notConfigured'
        ? t('bfw.desktopNotRunning')
        : t('bfw.notConfigured');
    case 'redirect':
      return t('integrations.redirected', err.location ?? '?');
    case 'insecure':
      return t('integrations.insecure');
    case 'keychain':
      return t('integrations.keychain');
    case 'tooLarge':
      return t('integrations.tooLarge');
    case 'status':
      if (err.status === 401) return t('bfw.keyRefused');
      if (err.status === 403) return t('bfw.noScope', opts.scope ?? 'read');
      if (err.status === 429) return t('bfw.rateLimited');
      return t('bfw.failed', `HTTP ${err.status ?? '?'}`);
    default:
      return t('bfw.failed', err.kind);
  }
}

/** The connection test for the Integration settings dialog, on the unsaved field values (D8). */
function probeWith(invoke: InvokeFn | undefined): ProbeFn {
  return async (fields) => {
    const connection: BfwConnection = fields.connection === 'desktop' ? 'desktop' : 'server';
    try {
      const r = await bfwProbe(
        { connection, url: fields.url || undefined, apiKey: fields.apiKey || undefined },
        invoke,
      );
      const yesNo = (v: boolean) => (v ? t('bfw.probe.yes') : t('bfw.probe.no'));
      const ai =
        r.ai === 'ok' ? t('bfw.probe.yes') : r.ai === 'noScope' ? t('bfw.probe.ai.noScope') : t('bfw.probe.ai.adminOnly');
      return { ok: true, message: t('bfw.probe.ok', r.user, yesNo(r.read), ai) };
    } catch (e) {
      return { ok: false, message: bfwErrorText(e, { connection, url: fields.url, scope: 'read' }) };
    }
  };
}

/**
 * Start bfworkflow for the open vault: load the key status, register the connection test, and follow key and
 * settings changes so a saved key shows the commands without a vault switch. The returned function stops it all.
 */
export function startBfworkflow(ctx: CommandContext, invoke?: InvokeFn): () => void {
  void ctx;
  const mine = ++generation;
  setStatus(undefined);
  const refresh = () => {
    const asked = statusVersion;
    secretStatus(invoke).then(
      (s) => {
        if (asked === statusVersion && mine === generation) setStatus(s);
      },
      () => undefined, // no status: the commands stay hidden
    );
  };
  refresh();
  const offProbe = registerProbe('bfw', probeWith(invoke));
  const offSecrets = onSecretsChange((s) => {
    if (mine === generation) setStatus(s);
  });
  // A changed address binds another key (D6): read the status again.
  const offChange = onIntegrationChange(() => refresh());
  return () => {
    offProbe();
    offSecrets();
    offChange();
    if (mine === generation) {
      generation++;
      setStatus(undefined);
    }
  };
}
