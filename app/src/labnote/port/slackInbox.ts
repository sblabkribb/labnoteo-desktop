// Ported from app/vendor/labnoteo/src/scan/slack.ts:21-432 sha256:cd5e27c1737f30e1
// labnoteO 0.140.2, Apache-2.0.
// Changes: SlackConfig.token is removed: the bot token is the secret_* slot slackBot in Windows Credential Manager,
// which only Rust reads (B6), and a poll without it calls nothing; requestUrl becomes slackCall (the Web API methods
// by their Rust SlackMethod names) and slackDownload, the scopes come from reply.scopes and a 429 from
// reply.retryAfter; the config (now SlackLink, with enabled) persists through readSlackLink / writeSlackLink and
// pcStore is removed, so config() and status() are asynchronous and re-read the stored link; polling happens only
// when link.enabled (B6), and start() also sets the pollMs interval that the plugin's BarcodeFeature set, which stop()
// clears; beginLink(mode, channelId) and verify(mode, channelId) no longer take the token, and disconnect() writes
// enabled: false instead of deleting the link; a download NetError of kind notJson, redirect or status (also
// forbiddenPath) gives the plugin's "Slack refused the download" text, and tooLarge makes the file unsupported;
// describeSlackError's missing_scope text becomes overrideOr('scan.slackMissingScope', scopes) and the failed-check
// notice (which pointed at docs/SCAN.md) becomes overrideOr('scan.slackCheckFailed'), so no text names the plugin's
// docs (B11); a NetError is named by its kind, never by Rust's text, a NetError while claiming ends the check like
// any other failed call, and a cancelled request (vault switch) is silent; SlackDeps drop store and t (coreT is the Translator) and gain invoke; the Translator parameter of
// describeSlackError is named translate, so the app's own t-key check does not read plugin keys as app keys. A vault
// switch is checked for (SP6 D11, B6): each poll takes a vaultGuard() first (deps.guard, default over invoke) and
// hands it to run and report; every write of the link (save, saveState) re-reads the stored link and calls
// guard.check() before writing, so the old vault's link is never written into another vault (no fallback to the
// link the poll started with unless the guard says the vault is the same); after run, a stop() or a switch ends
// the poll before anything is saved, replied or reported.
/**
 * Slack as a way in for scans: send photos of worksheets to your own Slack bot by DM (or post them in a private
 * channel the bot was invited to), and this PC files them and replies in the thread.
 *
 * The bot token stays in Rust; the link to one Slack user is per vault app-data state. Linking works with a one-time
 * code the user sends to the bot, so only that person's files are taken, and only messages sent after it.
 *
 * Before touching a message this PC claims it with an 👀 reaction, so two PCs given the same token do not both file
 * the same photo. `claimedTs` remembers the claims this PC made, so a message it claimed and then crashed on is
 * finished rather than mistaken for another PC's work.
 */
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import type { Translator } from '@labnoteo/core';
import {
  NetError,
  secretStatus,
  slackCall,
  slackDownload,
  toNetError,
  vaultGuard,
  type InvokeFn,
  type SlackMethod,
  type VaultGuard,
} from '../../integrations/netIpc';
import { coreT, overrideOr } from '../i18n';
import { readSlackLink, writeSlackLink, type SlackLink } from '../scan/scanIpc';
import type { ScanInput, ScanResult } from './scanPipeline';
import { describeResult } from './scanResults';

export type SlackMode = 'dm' | 'channel';

const FILE_RE = /\.(jpe?g|png|webp|gif|bmp|pdf|zip|heic|heif|tiff?)$/i;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
/** History pages collected per check: Slack returns newest first, so the oldest fall off past this. */
const MAX_HISTORY_PAGES = 20;
const HISTORY_PAGE_LIMIT = 200;
/** Claims remembered; older ones are long handled (`lastTs` has moved past them). */
const MAX_CLAIMS = 200;
/** Download refusals: Rust never follows a redirect, and a sign-in page is `notJson`. */
const REFUSED_KINDS = new Set(['notJson', 'redirect', 'status', 'forbiddenPath']);

/** What the bot needs; `reactions:write` is only recommended (the 👀 claim that keeps two PCs apart). */
export const REQUIRED_SCOPES: Record<SlackMode, readonly string[]> = {
  dm: ['im:history', 'im:read', 'files:read', 'chat:write'],
  channel: ['groups:history', 'files:read', 'chat:write'],
};
export const RECOMMENDED_SCOPE = 'reactions:write';

/** Every scope the app may ask for, each once, in the order the plugin lists them. */
function allScopes(): string {
  return [...new Set([...REQUIRED_SCOPES.dm, ...REQUIRED_SCOPES.channel, RECOMMENDED_SCOPE])].join(', ');
}

/**
 * A Slack error as what to fix, with the code after it (#397). Slack's
 * codes are snake_case; anything else came from the request itself.
 */
export function describeSlackError(translate: Translator, code: string): string {
  if (!/^[a-z_]+$/.test(code)) return translate('Could not reach Slack; check the internet connection ({0}).', code);
  const fix =
    code === 'invalid_auth' || code === 'not_authed' || code === 'account_inactive'
      ? translate('The bot token is not valid. Copy the Bot User OAuth Token (xoxb-…) again from OAuth & Permissions of your Slack app.')
      : code === 'token_revoked' || code === 'token_expired' || code === 'app_uninstalled'
        ? translate('The bot token was revoked or the app was removed. Reinstall the Slack app and copy its new token.')
        : code === 'missing_scope'
          ? // plugin: 'The bot token is missing a permission. Add the scopes in docs/SCAN.md under OAuth & Permissions and reinstall the app.'
            overrideOr('scan.slackMissingScope', allScopes())
          : '';
  return fix ? `${fix} (${code})` : code;
}

/**
 * The channel ID in `input`: an ID (`C…`/`G…`) or a Slack link holding one
 * (`…/archives/C…`, `…/client/T…/C…`); undefined otherwise (#397).
 */
export function slackChannelId(input: string): string | undefined {
  const s = input.trim();
  if (/^[CG][A-Z0-9]+$/.test(s)) return s;
  return /\/(?:archives|client\/T[A-Z0-9]+)\/([CG][A-Z0-9]+)(?:[/?#]|$)/.exec(s)?.[1];
}

interface SlackFile {
  name?: string;
  mimetype?: string;
  size?: number;
  url_private_download?: string;
}
interface SlackMessage {
  ts: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  text?: string;
  files?: SlackFile[];
}

class RateLimited extends Error {
  constructor(readonly retryAfterMs: number) {
    super('ratelimited');
  }
}

export function newLinkCode(random: () => number = Math.random): string {
  return `labnote-${Math.floor(random() * 900000 + 100000)}`;
}

/** Messages to take from a channel's history: the linked user's files after `lastTs`, oldest first. */
export function messagesToProcess(
  messages: readonly SlackMessage[],
  cfg: { userId?: string; lastTs?: string },
): SlackMessage[] {
  const after = Number(cfg.lastTs || '0');
  return messages
    .filter((m) => !m.bot_id && m.user === cfg.userId && Number(m.ts) > after && (m.files?.length ?? 0) > 0)
    .sort((a, b) => Number(a.ts) - Number(b.ts));
}

/** The message carrying the link code, if any. */
export function findLinkMessage(messages: readonly SlackMessage[], code: string): SlackMessage | undefined {
  return messages.find((m) => !m.bot_id && m.user && (m.text ?? '').includes(code));
}

export interface SlackVerification {
  /** The bot's user name, for "/invite @…" guidance. */
  botName: string;
  /** Required scopes the token does not have. Empty when the scopes header was absent. */
  missingScopes: string[];
  /** Whether `reactions:write` is missing (only when the scopes header was present). */
  missingRecommended: boolean;
  /** Channel mode: the bot is not in the channel (or the channel was not found). */
  notInChannel: boolean;
}

export interface SlackDeps {
  /** Files one message's pages: a background run (no dialog, B8), checking `guard` before each write. */
  run(inputs: ScanInput[], guard: VaultGuard): Promise<ScanResult[]>;
  summarize(results: ScanResult[]): string;
  notify(message: string): void;
  /** `guard` is the poll's vault guard: the results it offers belong to that vault. */
  report(results: ScanResult[], guard: VaultGuard): void;
  /** The vault guard a poll takes first (default: vaultGuard over invoke). */
  guard?: () => Promise<VaultGuard>;
  /** IPC (default: Tauri's). */
  invoke?: InvokeFn;
}

/** What a log line or a notice may say about a failure: Slack's code, or a NetError's kind, never Rust's text. */
function codeOf(err: unknown): string {
  if (err instanceof NetError) return err.kind;
  if (err instanceof Error) return err.message;
  return toNetError(err).kind;
}

const isCancelled = (err: unknown): boolean => err instanceof NetError && err.kind === 'cancelled';

export class SlackInbox {
  readonly pollMs = 90_000;
  private polling = false;
  private stopped = false;
  private warned = false;
  private reactionScopeWarned = false;
  /** Wall-clock time before which Slack asked not to call again (429). */
  private pauseUntil = 0;
  private timer?: ReturnType<typeof setInterval>;
  /** What the last failed check said, for the settings screen. */
  lastError: string | undefined;

  constructor(private readonly deps: SlackDeps) {}

  private get invoke(): InvokeFn {
    return this.deps.invoke ?? tauriInvoke;
  }

  /** The stored link when this vault checks Slack (`enabled`); undefined otherwise. */
  async config(): Promise<SlackLink | undefined> {
    const link = await readSlackLink(this.invoke);
    return link?.enabled ? link : undefined;
  }

  /** Settings changed: save and let warnings show again. */
  private async save(link: SlackLink): Promise<void> {
    await writeSlackLink(link, this.invoke);
    this.warned = false;
    this.reactionScopeWarned = false;
    this.lastError = undefined;
  }

  /** Bookkeeping (`lastTs`, `claimedTs`): saved without resetting the warning state. */
  private async saveState(link: SlackLink): Promise<void> {
    await writeSlackLink(link, this.invoke);
  }

  /**
   * The link as stored now (another write may have landed since `cfg` was read), read in the guard's vault: the
   * check after the read rejects (cancelled) when the vault was switched, so a link of another vault, or `cfg` in
   * place of another vault's missing link, is never handed back for writing.
   */
  private async latest(cfg: SlackLink, guard: VaultGuard): Promise<SlackLink> {
    const stored = await readSlackLink(this.invoke);
    await guard.check();
    return stored ?? cfg;
  }

  async status(): Promise<'off' | 'linking' | 'linked'> {
    const cfg = await this.config();
    if (!cfg) return 'off';
    return cfg.userId ? 'linked' : 'linking';
  }

  /** Start linking: a fresh code to send to the bot. The token must already be stored (slot slackBot). */
  async beginLink(mode: SlackMode, channelId?: string): Promise<string> {
    const code = newLinkCode();
    await this.save({
      enabled: true,
      mode,
      channelId: mode === 'channel' ? (channelId?.trim() ?? '') : '',
      linkCode: code,
      userId: '',
      lastTs: '',
      claimedTs: [],
    });
    return code;
  }

  /** Stop checking Slack in this vault and forget the linked user. The token stays (the settings offer to clear it). */
  async disconnect(): Promise<void> {
    const prev = await readSlackLink(this.invoke);
    const mode = prev?.mode ?? 'dm';
    await this.save({
      enabled: false,
      mode,
      channelId: mode === 'channel' ? (prev?.channelId ?? '') : '',
      linkCode: '',
      userId: '',
      lastTs: '',
      claimedTs: [],
    });
  }

  /** Check now, then every `pollMs` until stop(). A vault whose link is not enabled calls nothing. */
  start(): void {
    this.stopped = false;
    if (this.timer === undefined) this.timer = globalThis.setInterval(() => void this.poll(), this.pollMs);
    void this.poll();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) globalThis.clearInterval(this.timer);
    this.timer = undefined;
  }

  private async call<T>(
    method: SlackMethod,
    params: Record<string, string>,
  ): Promise<{ json: { ok: boolean; error?: string } & T; scopes?: string }> {
    const reply = await slackCall({ method, params }, this.invoke);
    const body = reply.json && typeof reply.json === 'object' ? (reply.json as { ok: boolean; error?: string } & T) : undefined;
    if (reply.status === 429 || body?.error === 'ratelimited') {
      throw new RateLimited((reply.retryAfter ?? 0) * 1000);
    }
    const json = body ?? ({ ok: false, error: 'HTTP error' } as { ok: boolean; error?: string } & T);
    return { json, scopes: reply.scopes };
  }

  private async api<T>(method: SlackMethod, params: Record<string, string>): Promise<T> {
    const { json } = await this.call<T>(method, params);
    if (!json.ok) throw new Error(json.error ?? 'HTTP error');
    return json;
  }

  /**
   * Check the stored token before linking: who the bot is, which required scopes are
   * missing (none reported when Slack omits the scopes header), and in channel
   * mode whether the bot is in the channel. Throws on a bad token.
   */
  async verify(mode: SlackMode, channelId?: string): Promise<SlackVerification> {
    const { json, scopes: scopesHeader } = await this.call<{ user?: string }>('authTest', {});
    if (!json.ok) throw new Error(json.error ?? 'HTTP error');
    const botName = json.user ?? 'bot';
    const scopes = new Set((scopesHeader ?? '').split(',').map((s) => s.trim()).filter(Boolean));
    const missingScopes = scopesHeader ? REQUIRED_SCOPES[mode].filter((s) => !scopes.has(s)) : [];
    const missingRecommended = Boolean(scopesHeader) && !scopes.has(RECOMMENDED_SCOPE);
    let notInChannel = false;
    if (mode === 'channel' && channelId) {
      try {
        await this.api('conversationsHistory', { channel: channelId.trim(), limit: '1' });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === 'not_in_channel' || msg === 'channel_not_found') notInChannel = true;
        else if (!(err instanceof RateLimited)) throw err;
      }
    }
    return { botName, missingScopes, missingRecommended, notInChannel };
  }

  /** The channel's history after `oldest`, oldest first (across pages, newest pages first from Slack). */
  private async collectHistory(channel: string, oldest?: string): Promise<{ messages: SlackMessage[]; truncated: boolean }> {
    const messages: SlackMessage[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
      const params: Record<string, string> = { channel, limit: String(HISTORY_PAGE_LIMIT) };
      if (oldest) params.oldest = oldest;
      if (cursor) params.cursor = cursor;
      const res = await this.api<{ messages?: SlackMessage[]; has_more?: boolean; response_metadata?: { next_cursor?: string } }>(
        'conversationsHistory',
        params,
      );
      messages.push(...(res.messages ?? []));
      cursor = res.response_metadata?.next_cursor;
      if (!res.has_more || !cursor) return { messages, truncated: false };
    }
    return { messages, truncated: true };
  }

  /** Check for the link code or for new files. */
  async poll(): Promise<void> {
    if (this.polling || this.stopped || Date.now() < this.pauseUntil) return;
    this.polling = true;
    try {
      let guard: VaultGuard;
      try {
        guard = await (this.deps.guard ? this.deps.guard() : vaultGuard(this.invoke));
      } catch {
        return; // no vault Rust can name: nothing to file into
      }
      const cfg = await this.config();
      if (!cfg) return;
      if (!(await secretStatus(this.invoke)).set.slackBot) return;
      if (!cfg.userId) await this.pollLink(cfg, guard);
      else await this.pollFiles(cfg, guard);
      this.lastError = undefined;
    } catch (err) {
      if (err instanceof RateLimited) {
        // Slack asked for a pause: pick up where lastTs left off on a later check.
        this.pauseUntil = Date.now() + Math.max(err.retryAfterMs, this.pollMs);
        return;
      }
      if (isCancelled(err)) return; // the vault closed mid-check
      const msg = codeOf(err);
      this.lastError = msg;
      console.warn('[labnoteo] Slack check failed:', msg);
      if (!this.warned) {
        this.warned = true;
        // plugin: 'Slack scans: checking failed ({0}). See the Slack section of docs/SCAN.md for the bot permissions.'
        this.deps.notify(overrideOr('scan.slackCheckFailed', describeSlackError(coreT, msg)));
      }
    } finally {
      this.polling = false;
    }
  }

  private threadGuidance(): string {
    return coreT('Send new photos as a new message here, not as a reply in this thread.');
  }

  private async pollLink(cfg: SlackLink, guard: VaultGuard): Promise<void> {
    if (!cfg.linkCode) return;
    const channels =
      cfg.mode === 'channel' && cfg.channelId
        ? [cfg.channelId]
        : (await this.api<{ channels?: { id: string }[] }>('conversationsList', { types: 'im', limit: '200' })).channels?.map(
            (c) => c.id,
          ) ?? [];
    for (const channel of channels) {
      const { messages } = await this.collectHistory(channel);
      const hit = findLinkMessage(messages, cfg.linkCode);
      if (!hit?.user) continue;
      if (this.stopped) return;
      const latest = await this.latest(cfg, guard);
      await this.save({ ...latest, channelId: channel, userId: hit.user, lastTs: hit.ts, linkCode: '' });
      await this.api('chatPostMessage', {
        channel,
        thread_ts: hit.ts,
        text: `${coreT('Linked. Send photos or scans of printed worksheets here, and they will be filed in their notes.')} ${this.threadGuidance()}`,
      });
      this.deps.notify(coreT('Slack scans are linked. Photos you send to the bot are filed in their notes.'));
      return;
    }
  }

  /**
   * Claim `ts` with the 👀 reaction. `true` to process it here: a fresh claim,
   * one this PC made earlier (crashed mid-work), or no way to claim (the scope
   * is missing — a lone PC works fine without it).
   */
  private async claim(cfg: SlackLink, ts: string, guard: VaultGuard): Promise<boolean> {
    try {
      await this.api('reactionsAdd', { channel: cfg.channelId, timestamp: ts, name: 'eyes' });
    } catch (err) {
      if (err instanceof RateLimited || err instanceof NetError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'already_reacted') return cfg.claimedTs.includes(ts);
      if (msg === 'missing_scope' && !this.reactionScopeWarned) {
        this.reactionScopeWarned = true;
        this.deps.notify(coreT('The Slack bot cannot add the 👀 reaction (reactions:write). Fine on one PC, but do not link a second one.'));
      }
      return true;
    }
    if (this.stopped) return false;
    const latest = await this.latest(cfg, guard);
    await this.saveState({ ...latest, claimedTs: [...latest.claimedTs, ts].slice(-MAX_CLAIMS) });
    return true;
  }

  /** One message's files, downloaded: inputs to run, plus per-file failures for the summary. */
  private async download(files: readonly SlackFile[]): Promise<{ inputs: ScanInput[]; failures: ScanResult[] }> {
    const inputs: ScanInput[] = [];
    const failures: ScanResult[] = [];
    for (const file of files) {
      const name = file.name ?? 'slack-file';
      if (!FILE_RE.test(name) || (file.size ?? 0) > MAX_FILE_BYTES) {
        failures.push({ source: name, status: 'unsupported' });
        continue;
      }
      if (!file.url_private_download) {
        failures.push({
          source: name,
          status: 'error',
          message: coreT('Slack gave no download link (the file may be deleted, or hidden by the free plan limit).'),
        });
        continue;
      }
      let bytes: ArrayBuffer;
      try {
        bytes = await slackDownload({ url: file.url_private_download }, this.invoke);
      } catch (e) {
        const err = toNetError(e);
        if (REFUSED_KINDS.has(err.kind)) {
          failures.push({ source: name, status: 'error', message: coreT('Slack refused the download (check the files:read permission).') });
          continue;
        }
        if (err.kind === 'tooLarge') {
          failures.push({ source: name, status: 'unsupported' });
          continue;
        }
        throw err;
      }
      inputs.push({ name, bytes });
    }
    return { inputs, failures };
  }

  private async pollFiles(cfg: SlackLink, guard: VaultGuard): Promise<void> {
    if (!cfg.channelId) return;
    const { messages, truncated } = await this.collectHistory(cfg.channelId, cfg.lastTs || undefined);
    if (truncated) this.deps.notify(coreT('Slack had more messages than one check reads; the oldest may have been skipped.'));
    for (const message of messagesToProcess(messages, cfg)) {
      if (this.stopped) return;
      if (!(await this.claim(await this.latest(cfg, guard), message.ts, guard))) {
        if (this.stopped) return;
        // Another PC's work: step past it and leave it alone.
        const latest = await this.latest(cfg, guard);
        await this.saveState({ ...latest, lastTs: message.ts });
        continue;
      }
      const { inputs, failures } = await this.download(message.files ?? []);
      const results = [...(inputs.length ? await this.deps.run(inputs, guard) : []), ...failures];
      // Stopped (the vault is closing) or switched while the pages were filed: nothing more is saved, replied or
      // reported here; the message is still after lastTs in its own vault.
      if (this.stopped) return;
      // Done with this message — remember that before replying, so a failed
      // reply (chat:write missing, …) cannot make the next check redo it.
      const latest = await this.latest(cfg, guard);
      await this.saveState({ ...latest, lastTs: message.ts });
      const lines = results
        .filter((r) => r.status !== 'skipped')
        .map((r) => `• ${r.sourcePage ? `${r.source} p.${r.sourcePage}` : r.source}: ${describeResult(coreT, r)}`);
      const text = [this.deps.summarize(results), ...lines, this.threadGuidance()].join('\n');
      try {
        await this.api('chatPostMessage', { channel: cfg.channelId, thread_ts: message.ts, text });
      } catch (err) {
        if (err instanceof RateLimited || isCancelled(err)) throw err;
        const msg = codeOf(err);
        this.lastError = msg;
        console.warn('[labnoteo] Slack reply failed:', msg);
        if (!this.warned) {
          this.warned = true;
          this.deps.notify(coreT('Slack scans were filed, but replying in Slack failed ({0}). Check the chat:write permission.', msg));
        }
      }
      if (results.length) this.deps.report(results, guard);
    }
  }
}
