/**
 * The ported MCP approval helpers (port/mcpApproval.ts), with the plugin's own tests from
 * vendor tests/plugin/mcpServer.test.ts (awaitApproval, buildToolCallResult, TaskQueue, approveStable).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  APPROVAL_TIMEOUT_MS,
  TaskQueue,
  approveStable,
  awaitApproval,
  buildToolCallResult,
} from '../../port/mcpApproval';

it('APPROVAL_TIMEOUT_MS is the plugin value', () => { expect(APPROVAL_TIMEOUT_MS).toBe(50_000); });

// #47: a write approval must not hang forever, and a request the client has
// abandoned must not be applied by a late "Allow".
describe('awaitApproval', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A dialog that answers `answer` after `ms`, or false as soon as it is withdrawn. */
  const dialog = (answer: boolean, ms: number) => {
    const seen: { withdrawn: boolean } = { withdrawn: false };
    const confirm = (signal: AbortSignal) =>
      new Promise<boolean>(resolve => {
        const timer = setTimeout(() => resolve(answer), ms);
        signal.addEventListener('abort', () => {
          seen.withdrawn = true;
          clearTimeout(timer);
          resolve(false);
        });
      });
    return { confirm, seen };
  };

  it('passes on an answer given in time', async () => {
    vi.useFakeTimers();
    const allow = dialog(true, 1000);
    const allowed = awaitApproval(allow.confirm, { timeoutMs: 5000, signal: new AbortController().signal });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await allowed).toBe('allowed');
    expect(allow.seen.withdrawn).toBe(false);

    const deny = dialog(false, 1000);
    const denied = awaitApproval(deny.confirm, { timeoutMs: 5000, signal: new AbortController().signal });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await denied).toBe('denied');
  });

  it('withdraws the dialog and reports a timeout', async () => {
    vi.useFakeTimers();
    const d = dialog(true, 60_000);
    const outcome = awaitApproval(d.confirm, { timeoutMs: 5000, signal: new AbortController().signal });
    await vi.advanceTimersByTimeAsync(5000);
    expect(await outcome).toBe('timeout');
    expect(d.seen.withdrawn).toBe(true);
  });

  it('withdraws the dialog when the client disconnects', async () => {
    vi.useFakeTimers();
    const d = dialog(true, 60_000);
    const client = new AbortController();
    const outcome = awaitApproval(d.confirm, { timeoutMs: 50_000, signal: client.signal });
    await vi.advanceTimersByTimeAsync(2000);
    client.abort();
    expect(await outcome).toBe('disconnected');
    expect(d.seen.withdrawn).toBe(true);
  });

  it('does not count an "Allow" that resolves after the request was abandoned', async () => {
    const client = new AbortController();
    client.abort();
    let asked = false;
    const outcome = await awaitApproval(
      async () => {
        asked = true;
        return true;
      },
      { timeoutMs: 1000, signal: client.signal }
    );
    expect(outcome).toBe('disconnected');
    expect(asked).toBe(false);
  });

  it('ignores the dialog result once the timeout fired, even if it says allow', async () => {
    vi.useFakeTimers();
    const outcome = awaitApproval(
      () => new Promise<boolean>(resolve => setTimeout(() => resolve(true), 6000)),
      { timeoutMs: 5000, signal: new AbortController().signal }
    );
    await vi.advanceTimersByTimeAsync(6000);
    expect(await outcome).toBe('timeout');
  });
});


describe('buildToolCallResult', () => {
  it('carries the data as a single text item', () => {
    expect(buildToolCallResult({ ok: true, data: { id: 'RNA-1' } })).toEqual({
      isError: false,
      content: [{ type: 'text', text: '{"id":"RNA-1"}' }],
    });
  });

  it('appends warnings after the data, leaving the first item as before', () => {
    const { content } = buildToolCallResult({
      ok: true,
      data: { id: 'RNA-1' },
      warnings: ['Ignored unsupported argument(s): foo. Supported: type.'],
    });
    expect(content).toHaveLength(2);
    expect(content[0].text).toBe('{"id":"RNA-1"}');
    expect(content[1].text).toBe('Warning: Ignored unsupported argument(s): foo. Supported: type.');
  });

  it('flags a failed call as an error', () => {
    expect(buildToolCallResult({ ok: false, error: 'boom' })).toEqual({
      isError: true,
      content: [{ type: 'text', text: '"boom"' }],
    });
  });
});

// #69: the prompt named only the tool and the note, so an empty update_section

describe('TaskQueue', () => {
  it('runs tasks one at a time in queue order, past a failing one', async () => {
    const q = new TaskQueue();
    const log: string[] = [];
    let release!: () => void;
    const first = q.run(async () => {
      log.push('a start');
      await new Promise<void>(r => (release = r));
      log.push('a end');
    });
    const second = q.run(async () => {
      log.push('b');
      throw new Error('b failed');
    });
    const third = q.run(async () => void log.push('c'));
    await Promise.resolve();
    expect(log).toEqual(['a start']);
    release();
    await first;
    await expect(second).rejects.toThrow('b failed');
    await third;
    expect(log).toEqual(['a start', 'a end', 'b', 'c']);
  });
});

describe('approveStable', () => {
  it('allows when the preview is unchanged after the answer', async () => {
    const ask = vi.fn(async () => 'allowed' as const);
    expect(await approveStable(async () => ({ message: 'm' }), ask)).toBe('allowed');
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('asks again about a preview that changed while the dialog was open', async () => {
    const messages = ['old', 'new', 'new'];
    const ask = vi.fn(async (_m: string) => 'allowed' as const);
    expect(await approveStable(async () => ({ message: messages.shift()! }), ask)).toBe('allowed');
    expect(ask.mock.calls.map(c => c[0])).toEqual(['old', 'new']);
  });

  it('passes a denial through and reports a call that became invalid', async () => {
    expect(await approveStable(async () => ({ message: 'm' }), async () => 'denied')).toBe('denied');
    const results: Array<{ message: string } | { error: string }> = [{ message: 'm' }, { error: 'gone' }];
    expect(await approveStable(async () => results.shift()!, async () => 'allowed')).toEqual({ error: 'gone' });
  });

  it('gives up when the preview keeps changing', async () => {
    let n = 0;
    const result = await approveStable(async () => ({ message: String(n++) }), async () => 'allowed');
    expect(result).toMatchObject({ error: expect.stringMatching(/kept changing/) });
  });
});
