// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from '@testing-library/react';
import { setLang } from '../../../i18n/lang';
import { fakeInvoke, netError, secretStatusOf } from '../../../integrations/__tests__/fakeNet';
import type { NetError } from '../../../integrations/netIpc';
import { createTestHost } from '../../__tests__/testHost';
import { cleanupDialogs } from '../../host/__tests__/harness';
import { currentDialog } from '../../host/dialogStore';
import { clearToasts } from '../../host/toastStore';
import { coreT } from '../../i18n';
import type { PageDecoder, ScanInput, ScanPipeline, ScanResult } from '../../port/scanPipeline';
import {
  RECOMMENDED_SCOPE,
  REQUIRED_SCOPES,
  SlackInbox,
  describeSlackError,
  findLinkMessage,
  messagesToProcess,
  newLinkCode,
  slackChannelId,
} from '../../port/slackInbox';
import { ScanFeature, type ScanFeatureDeps } from '../scanFeature';
import type { SlackLink } from '../scanIpc';

const file = (name: string) => ({ name, size: 10, url_private_download: `https://files.slack.com/files-pri/T1-F1/${name}` });

/** Rust's method names (camelCase) back to the Slack Web API names the plugin's tests speak. */
const API_NAME: Record<string, string> = {
  authTest: 'auth.test',
  conversationsHistory: 'conversations.history',
  conversationsList: 'conversations.list',
  chatPostMessage: 'chat.postMessage',
  reactionsAdd: 'reactions.add',
};

beforeEach(() => setLang('en'));
afterEach(() => setLang('ko'));

// #397
describe('Slack errors and channel links', () => {
  const t = (s: string, ...a: Array<string | number | boolean>) => s.replace(/\{(\d+)\}/g, (_, i: string) => String(a[Number(i)] ?? ''));

  it('says what to fix, keeping the code', () => {
    expect(describeSlackError(t, 'invalid_auth')).toMatch(/^The bot token is not valid\..*\(invalid_auth\)$/);
    expect(describeSlackError(t, 'token_revoked')).toMatch(/revoked.*\(token_revoked\)$/);
    expect(describeSlackError(t, 'missing_scope')).toMatch(/missing a permission.*\(missing_scope\)$/);
    expect(describeSlackError(t, 'channel_not_found')).toBe('channel_not_found');
    expect(describeSlackError(t, 'net::ERR_INTERNET_DISCONNECTED')).toMatch(/^Could not reach Slack/);
  });

  it('missing_scope names the scopes and not docs/SCAN.md', () => {
    for (const lang of ['en', 'ko'] as const) {
      setLang(lang);
      const text = describeSlackError(coreT, 'missing_scope');
      for (const s of ['im:history', 'groups:history', 'files:read', 'chat:write', 'reactions:write']) expect(text).toContain(s);
      expect(text).not.toMatch(/docs\/SCAN\.md|Obsidian/);
    }
  });

  it('lists every scope once', () => {
    const text = describeSlackError(coreT, 'missing_scope');
    const all = [...new Set([...REQUIRED_SCOPES.dm, ...REQUIRED_SCOPES.channel, RECOMMENDED_SCOPE])];
    expect(text).toContain(all.join(', '));
    expect(text.split('files:read')).toHaveLength(2);
  });

  it('takes the channel ID from an ID or a link, trimmed', () => {
    expect(slackChannelId(' C07FAKE123 ')).toBe('C07FAKE123');
    expect(slackChannelId('https://app.slack.com/client/T01ABCDE/C07FAKE123')).toBe('C07FAKE123');
    expect(slackChannelId('https://lab.slack.com/archives/G01FAKE123/p1700000000')).toBe('G01FAKE123');
    expect(slackChannelId('https://app.slack.com/client/T01ABCDE')).toBeUndefined();
    expect(slackChannelId('general')).toBeUndefined();
  });
});

describe('Slack message selection', () => {
  const cfg = { userId: 'U1', lastTs: '100.0' };

  it("takes the linked user's file messages after the last one handled, oldest first", () => {
    const messages = [
      { ts: '103.0', user: 'U1', files: [file('b.jpg')] },
      { ts: '102.0', user: 'U2', files: [file('other.jpg')] },
      { ts: '101.5', user: 'U1', text: 'no files' },
      { ts: '101.0', user: 'U1', files: [file('a.jpg')] },
      { ts: '101.2', bot_id: 'B1', user: 'U1', files: [file('bot.jpg')] },
      { ts: '99.0', user: 'U1', files: [file('old.jpg')] },
    ];
    expect(messagesToProcess(messages, cfg).map((m) => m.ts)).toEqual(['101.0', '103.0']);
  });

  it('finds the message carrying the link code, not a bot echo of it', () => {
    const code = newLinkCode(() => 0.5);
    expect(code).toBe('labnote-550000');
    const messages = [
      { ts: '2.0', bot_id: 'B1', user: 'U9', text: `code ${code}` },
      { ts: '1.0', user: 'U1', text: ` ${code} ` },
    ];
    expect(findLinkMessage(messages, code)?.user).toBe('U1');
    expect(findLinkMessage(messages, 'labnote-000000')).toBeUndefined();
  });
});

type SlackAnswer = Record<string, unknown> & { __status?: number; __scopes?: string; __retryAfter?: number };

describe('SlackInbox', () => {
  /**
   * `slack(method, params)` answers a Web API call (plugin method names); `__status`, `__scopes` and `__retryAfter`
   * shape Rust's SlackReply. `download(url)` returns bytes or throws (a NetError, as Rust rejects).
   */
  function inbox(
    slack: (method: string, params: Record<string, string>) => SlackAnswer | Record<string, unknown>,
    download: (url: string) => ArrayBuffer = () => new ArrayBuffer(4),
    opts: { token?: boolean } = {},
  ) {
    const state = new Map<string, string>();
    const posted: Record<string, string>[] = [];
    const reacted: string[] = [];
    const runs: string[][] = [];
    const notices: string[] = [];
    const f = fakeInvoke({
      secret_status: () => secretStatusOf({ slackBot: opts.token ?? true }),
      integration_state_read: (a) => state.get(String(a.name)) ?? null,
      integration_state_write: (a) => {
        state.set(String(a.name), String(a.content));
        return null;
      },
      slack_call: (a) => {
        const method = API_NAME[String(a.method)];
        const params = a.params as Record<string, string>;
        if (method === 'chat.postMessage') posted.push(params);
        if (method === 'reactions.add') reacted.push(params.timestamp);
        const { __status, __scopes, __retryAfter, ...body } = slack(method, params) as SlackAnswer;
        return {
          status: __status ?? 200,
          json: { ok: true, ...body },
          ...(__scopes !== undefined ? { scopes: __scopes } : {}),
          ...(__retryAfter !== undefined ? { retryAfter: __retryAfter } : {}),
        };
      },
      slack_download: (a) => download(String(a.url)),
    });
    const box = new SlackInbox({
      run: async (inputs: ScanInput[]) => {
        runs.push(inputs.map((i) => i.name));
        return inputs.map((i): ScanResult => ({ source: i.name, status: 'filed', notePath: 'n.md' }));
      },
      summarize: (results) => `${results.length} summarized`,
      notify: (m) => notices.push(m),
      report: () => undefined,
      invoke: f.invoke,
    });
    const link = (): SlackLink | undefined => {
      const s = state.get('slackLink');
      return s === undefined ? undefined : (JSON.parse(s) as SlackLink);
    };
    const linked = (over: Partial<SlackLink> = {}) =>
      state.set(
        'slackLink',
        JSON.stringify({
          enabled: true,
          mode: 'dm',
          channelId: 'D1',
          linkCode: '',
          userId: 'U1',
          lastTs: '10.0',
          claimedTs: [],
          ...over,
        } satisfies SlackLink),
      );
    return { box, posted, reacted, runs, notices, state, link, linked, f };
  }

  it('links to whoever sends the code, then files only their later photos and answers in the thread', async () => {
    let code = '';
    const s = inbox((method, params) => {
      if (method === 'conversations.list') return { channels: [{ id: 'D1' }] };
      if (method === 'conversations.history' && !params.oldest) return { messages: [{ ts: '10.0', user: 'U1', text: code }] };
      if (method === 'conversations.history') {
        return {
          messages: [
            { ts: '12.0', user: 'U1', files: [file('page.jpg'), file('notes.txt')] },
            { ts: '11.0', user: 'U2', files: [file('stranger.jpg')] },
          ],
        };
      }
      return {};
    });
    code = await s.box.beginLink('dm');
    expect(await s.box.status()).toBe('linking');
    expect(s.link()).toMatchObject({ enabled: true, mode: 'dm', linkCode: code, userId: '' });

    await s.box.poll();
    expect(await s.box.status()).toBe('linked');
    expect(s.link()).toMatchObject({ enabled: true, channelId: 'D1', userId: 'U1', lastTs: '10.0', linkCode: '' });
    expect(s.posted.map((p) => p.thread_ts)).toEqual(['10.0']);
    expect(s.posted[0].text).toContain('not as a reply in this thread');

    await s.box.poll();
    expect(s.runs).toEqual([['page.jpg']]);
    expect(s.reacted).toEqual(['12.0']);
    expect(s.posted[1]).toMatchObject({ channel: 'D1', thread_ts: '12.0' });
    expect(s.posted[1].text).toContain('2 summarized'); // the filed page and the unsupported notes.txt
    expect(s.posted[1].text).toContain('notes.txt');
    expect(s.posted[1].text).toContain('not as a reply in this thread');
    expect(s.link()?.lastTs).toBe('12.0');
    expect(s.link()?.claimedTs).toEqual(['12.0']);
  });

  it('warns once when Slack refuses, until the settings change', async () => {
    const s = inbox(() => ({ ok: false, error: 'missing_scope' }));
    await s.box.beginLink('channel', ' C1 ');
    expect(s.link()?.channelId).toBe('C1');
    await s.box.poll();
    await s.box.poll();
    expect(s.notices).toHaveLength(1);
    expect(s.notices[0]).toContain('checking failed');
    expect(s.notices[0]).not.toMatch(/docs\/SCAN\.md|Obsidian/);
    expect(s.box.lastError).toBe('missing_scope');
    await s.box.beginLink('channel', 'C1');
    await s.box.poll();
    expect(s.notices).toHaveLength(2);
  });

  it('reads every history page and still handles the oldest message first', async () => {
    const cursors: (string | undefined)[] = [];
    const s = inbox((method, params) => {
      if (method !== 'conversations.history') return {};
      cursors.push(params.cursor);
      return params.cursor
        ? { messages: [{ ts: '11.0', user: 'U1', files: [file('a.jpg')] }] }
        : { messages: [{ ts: '12.0', user: 'U1', files: [file('b.jpg')] }], has_more: true, response_metadata: { next_cursor: 'c2' } };
    });
    s.linked();
    await s.box.poll();
    expect(cursors).toEqual([undefined, 'c2']);
    expect(s.runs).toEqual([['a.jpg'], ['b.jpg']]);
    expect(s.link()?.lastTs).toBe('12.0');
  });

  it('warns when the pages run out before the history does', async () => {
    const s = inbox((method) =>
      method === 'conversations.history' ? { messages: [], has_more: true, response_metadata: { next_cursor: 'more' } } : {},
    );
    s.linked();
    await s.box.poll();
    expect(s.notices).toHaveLength(1);
    expect(s.notices[0]).toContain('oldest may have been skipped');
  });

  it('does not take a message back up after only the reply failed', async () => {
    const s = inbox((method) => {
      if (method === 'conversations.history') return { messages: [{ ts: '12.0', user: 'U1', files: [file('a.jpg')] }] };
      if (method === 'chat.postMessage') return { ok: false, error: 'not_in_channel' };
      return {};
    });
    s.linked();
    await s.box.poll();
    expect(s.runs).toEqual([['a.jpg']]);
    expect(s.link()?.lastTs).toBe('12.0');
    expect(s.notices).toHaveLength(1);
    expect(s.notices[0]).toContain('replying in Slack failed');

    await s.box.poll(); // lastTs moved on: nothing to redo, and the warning does not repeat
    expect(s.runs).toHaveLength(1);
    expect(s.notices).toHaveLength(1);
  });

  it('skips a message another PC claimed, but finishes one this PC claimed and crashed on', async () => {
    const s = inbox((method) => {
      if (method === 'conversations.history') {
        return {
          messages: [
            { ts: '12.0', user: 'U1', files: [file('b.jpg')] },
            { ts: '11.0', user: 'U1', files: [file('a.jpg')] },
          ],
        };
      }
      if (method === 'reactions.add') return { ok: false, error: 'already_reacted' };
      return {};
    });
    s.linked({ claimedTs: ['12.0'] }); // 11.0 was claimed by another PC; 12.0 by this one, interrupted
    await s.box.poll();
    expect(s.runs).toEqual([['b.jpg']]);
    expect(s.link()?.lastTs).toBe('12.0');
    expect(s.posted.map((p) => p.thread_ts)).toEqual(['12.0']);
    expect(s.notices).toEqual([]);
  });

  it('works without the reactions scope — unlocked, with one warning', async () => {
    const s = inbox((method) => {
      if (method === 'conversations.history') {
        return {
          messages: [
            { ts: '12.0', user: 'U1', files: [file('b.jpg')] },
            { ts: '11.0', user: 'U1', files: [file('a.jpg')] },
          ],
        };
      }
      if (method === 'reactions.add') return { ok: false, error: 'missing_scope' };
      return {};
    });
    s.linked();
    await s.box.poll();
    expect(s.runs).toEqual([['a.jpg'], ['b.jpg']]);
    expect(s.notices).toHaveLength(1);
    expect(s.notices[0]).toContain('reactions:write');
    expect(s.link()?.claimedTs ?? []).toEqual([]);
  });

  it('turns a refused or missing download into that file’s own failure line', async () => {
    const s = inbox(
      (method) =>
        method === 'conversations.history'
          ? {
              messages: [
                {
                  ts: '12.0',
                  user: 'U1',
                  files: [file('ok.jpg'), file('forbidden.jpg'), file('login.jpg'), { name: 'gone.jpg', size: 10 }],
                },
              ],
            }
          : {},
      (url) => {
        if (url.endsWith('forbidden.jpg')) throw netError('status', { status: 403 });
        if (url.endsWith('login.jpg')) throw netError('notJson');
        return new ArrayBuffer(4);
      },
    );
    s.linked();
    await s.box.poll();
    expect(s.runs).toEqual([['ok.jpg']]);
    const text = s.posted[0].text;
    expect(text).toContain('4 summarized');
    expect(text).toMatch(/forbidden\.jpg: .*refused the download/);
    expect(text).toMatch(/login\.jpg: .*refused the download/);
    expect(text).toMatch(/gone\.jpg: .*no download link/);
    expect(text).not.toContain('raw-rust-text');
    expect(s.link()?.lastTs).toBe('12.0');
  });

  it('a refused download is reported with the plugin text and the message is not claimed twice', async () => {
    const s = inbox(
      (method) => (method === 'conversations.history' ? { messages: [{ ts: '1.0', user: 'U1', files: [file('a.jpg')] }] } : {}),
      () => {
        throw netError('redirect', { status: 302, location: 'https://slack.com/signin' });
      },
    );
    s.linked({ lastTs: '0.5' });
    await s.box.poll();
    expect(s.posted).toHaveLength(1);
    expect(s.posted[0].text).toContain(coreT('Slack refused the download (check the files:read permission).'));
    expect(s.runs).toEqual([]);
    expect(s.reacted).toEqual(['1.0']);

    await s.box.poll();
    expect(s.reacted).toEqual(['1.0']);
    expect(s.posted).toHaveLength(1);
  });

  it('goes quiet on a rate limit and keeps what was already done', async () => {
    let historyCalls = 0;
    const s = inbox((method) => {
      if (method === 'conversations.history') {
        historyCalls++;
        return { messages: [{ ts: '12.0', user: 'U1', files: [file('a.jpg')] }] };
      }
      if (method === 'chat.postMessage') return { __status: 429, __retryAfter: 1, ok: false, error: 'ratelimited' };
      return {};
    });
    s.linked();
    await s.box.poll();
    expect(s.runs).toEqual([['a.jpg']]);
    expect(s.link()?.lastTs).toBe('12.0'); // saved before the reply hit the limit
    expect(s.notices).toEqual([]);
    expect(s.box.lastError).toBeUndefined();

    await s.box.poll(); // still inside the pause: no call at all
    expect(historyCalls).toBe(1);
  });

  it('a vault whose link is not enabled never calls Slack', async () => {
    const s = inbox(() => ({ messages: [{ ts: '12.0', user: 'U1', files: [file('a.jpg')] }] }));
    s.linked({ enabled: false });
    await s.box.poll();
    const none = inbox(() => ({}));
    await none.box.poll(); // no link at all
    for (const calls of [s.f.calls, none.f.calls]) {
      expect(calls.map(([cmd]) => cmd).filter((c) => c === 'slack_call' || c === 'slack_download')).toEqual([]);
    }
    expect(s.runs).toEqual([]);
  });

  it('without a stored bot token it does not call Slack', async () => {
    const s = inbox(() => ({ messages: [] }), undefined, { token: false });
    s.linked();
    await s.box.poll();
    expect(s.f.calls.map(([cmd]) => cmd)).not.toContain('slack_call');
    expect(s.notices).toEqual([]);
  });

  it('lastTs is saved before the thread reply', async () => {
    const s = inbox((method) =>
      method === 'conversations.history' ? { messages: [{ ts: '2.0', user: 'U1', files: [file('a.jpg')] }] } : {},
    );
    s.linked({ lastTs: '1.0' });
    await s.box.poll();
    const saved = s.f.calls.findIndex(
      ([cmd, a]) => cmd === 'integration_state_write' && (JSON.parse(String(a.content)) as SlackLink).lastTs === '2.0',
    );
    const reply = s.f.calls.findIndex(([cmd, a]) => cmd === 'slack_call' && a.method === 'chatPostMessage');
    expect(saved).toBeGreaterThanOrEqual(0);
    expect(reply).toBeGreaterThan(saved);
  });

  it('nothing written to integration state contains a token', async () => {
    let code = '';
    const s = inbox((method, params) => {
      if (method === 'conversations.list') return { channels: [{ id: 'D1' }] };
      if (method === 'conversations.history' && !params.oldest) return { messages: [{ ts: '10.0', user: 'U1', text: code }] };
      if (method === 'conversations.history') return { messages: [{ ts: '12.0', user: 'U1', files: [file('a.jpg')] }] };
      return {};
    });
    code = await s.box.beginLink('dm');
    await s.box.poll();
    await s.box.poll();
    await s.box.disconnect();
    const writes = s.f.calls.filter(([cmd]) => cmd === 'integration_state_write');
    expect(writes.length).toBeGreaterThan(3);
    for (const [, a] of writes) expect(String(a.content)).not.toMatch(/xox[abpr]-/);
    // no call of any kind carried a token either
    for (const [, a] of s.f.calls) expect(JSON.stringify(a)).not.toMatch(/xox[abpr]-/);
  });

  it('disconnect turns polling off and forgets the linked user', async () => {
    const s = inbox(() => ({ messages: [] }));
    s.linked();
    await s.box.disconnect();
    expect(s.link()).toMatchObject({ enabled: false, userId: '', lastTs: '', linkCode: '', claimedTs: [] });
    expect(await s.box.status()).toBe('off');
  });

  it('a network failure is named by its kind, never by Rust text', async () => {
    const failing = fakeInvoke({
      secret_status: () => secretStatusOf({ slackBot: true }),
      integration_state_read: () => JSON.stringify({ enabled: true, mode: 'dm', channelId: 'D1', userId: 'U1', lastTs: '1.0' }),
      integration_state_write: () => null,
      slack_call: () => {
        throw netError('offline');
      },
    });
    const notices: string[] = [];
    const box = new SlackInbox({ run: async () => [], summarize: () => '', notify: (m) => notices.push(m), report: () => {}, invoke: failing.invoke });
    await box.poll();
    expect(box.lastError).toBe('offline');
    expect(notices).toHaveLength(1);
    expect(notices[0]).not.toContain('raw-rust-text');
  });

  it('a cancelled request (vault switch) is silent', async () => {
    const failing = fakeInvoke({
      secret_status: () => secretStatusOf({ slackBot: true }),
      integration_state_read: () => JSON.stringify({ enabled: true, mode: 'dm', channelId: 'D1', userId: 'U1', lastTs: '1.0' }),
      integration_state_write: () => null,
      slack_call: (): never => {
        throw netError('cancelled') as NetError;
      },
    });
    const notices: string[] = [];
    const box = new SlackInbox({ run: async () => [], summarize: () => '', notify: (m) => notices.push(m), report: () => {}, invoke: failing.invoke });
    await box.poll();
    expect(notices).toEqual([]);
  });

  it('start polls at once and every pollMs while enabled; stop ends it', async () => {
    vi.useFakeTimers();
    try {
      const s = inbox(() => ({ messages: [] }));
      s.linked();
      s.box.start();
      await vi.advanceTimersByTimeAsync(0);
      const history = () => s.f.calls.filter(([cmd, a]) => cmd === 'slack_call' && a.method === 'conversationsHistory').length;
      expect(history()).toBe(1);
      expect(s.box.pollMs).toBe(90_000);
      await vi.advanceTimersByTimeAsync(90_000);
      expect(history()).toBe(2);
      s.box.stop();
      await vi.advanceTimersByTimeAsync(270_000);
      expect(history()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  describe('verify', () => {
    it('names the bot and the missing permissions', async () => {
      const s = inbox((method) =>
        method === 'auth.test' ? { user: 'labnote-scans', __scopes: 'im:history, files:read' } : {},
      );
      expect(await s.box.verify('dm')).toEqual({
        botName: 'labnote-scans',
        missingScopes: ['im:read', 'chat:write'],
        missingRecommended: true,
        notInChannel: false,
      });
    });

    it('does not block when Slack omits the scopes header', async () => {
      const s = inbox((method) => (method === 'auth.test' ? { user: 'bot' } : {}));
      expect(await s.box.verify('dm')).toMatchObject({ missingScopes: [], missingRecommended: false });
    });

    it('notices when the bot was not invited to the channel', async () => {
      const s = inbox((method) => {
        if (method === 'auth.test') return { user: 'bot', __scopes: 'groups:history,files:read,chat:write,reactions:write' };
        if (method === 'conversations.history') return { ok: false, error: 'not_in_channel' };
        return {};
      });
      expect(await s.box.verify('channel', 'C1')).toMatchObject({ missingScopes: [], notInChannel: true });
    });

    it('rejects a bad token', async () => {
      const s = inbox(() => ({ ok: false, error: 'invalid_auth' }));
      await expect(s.box.verify('dm')).rejects.toThrow('invalid_auth');
    });
  });
});

describe('ScanFeature.slack', () => {
  afterEach(() => {
    cleanupDialogs();
    act(() => clearToasts());
  });

  it('a poll that files scans opens no dialog', async () => {
    const dialogsDuring: unknown[] = [];
    const pipeline = {
      run: vi.fn(async (inputs: readonly ScanInput[]) => {
        dialogsDuring.push(currentDialog());
        return inputs.map((i): ScanResult => ({ source: i.name, status: 'filed', notePath: 'n.md' }));
      }),
    } as unknown as ScanPipeline;
    const withProgress = vi.fn();
    const state = new Map<string, string>([
      ['slackLink', JSON.stringify({ enabled: true, mode: 'dm', channelId: 'D1', linkCode: '', userId: 'U1', lastTs: '1.0', claimedTs: [] })],
    ]);
    const f = fakeInvoke({
      secret_status: () => secretStatusOf({ slackBot: true }),
      integration_state_read: (a) => state.get(String(a.name)) ?? null,
      integration_state_write: (a) => {
        state.set(String(a.name), String(a.content));
        return null;
      },
      slack_call: (a) =>
        a.method === 'conversationsHistory'
          ? { status: 200, json: { ok: true, messages: [{ ts: '2.0', user: 'U1', files: [file('a.jpg')] }] } }
          : { status: 200, json: { ok: true } },
      slack_download: () => new ArrayBuffer(4),
    });
    const { ctx } = createTestHost();
    const feature = new ScanFeature(ctx, {
      pipeline,
      decoder: { expand: vi.fn() } as unknown as PageDecoder,
      withProgress: withProgress as unknown as ScanFeatureDeps['withProgress'],
      notifyStatus: vi.fn(() => ({ update: vi.fn(), close: vi.fn() })),
      invoke: f.invoke,
    });
    const runSpy = vi.spyOn(feature, 'runWithProgress');
    await act(() => feature.slack.poll());
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(runSpy.mock.calls[0][1]).toBe(false); // skipNoQr: a Slack photo without a code is reported
    expect(runSpy.mock.calls[0][2]).toBe(false); // manual: a background run
    expect(withProgress).not.toHaveBeenCalled();
    expect(dialogsDuring).toEqual([null]);
    expect(currentDialog()).toBeNull();
    feature.dispose();
  });
});
