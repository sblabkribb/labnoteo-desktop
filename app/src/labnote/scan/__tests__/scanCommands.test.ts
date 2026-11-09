// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeInvoke, secretStatusOf } from '../../../integrations/__tests__/fakeNet';
import { createTestHost } from '../../__tests__/testHost';
import { createDecodeClient } from '../decodeClient';
import { scanCommands, startScan } from '../commands';
import { scanFeature } from '../scanFeature';
import type { ScanFolderStatus } from '../scanIpc';

const NO_FOLDER: ScanFolderStatus = { path: null, mode: 'dedicated', exists: false, insideVault: false, since: null, baseline: null };
const FOLDER: ScanFolderStatus = { path: 'D:/scans', mode: 'dedicated', exists: true, insideVault: false, since: 1, baseline: [] };
const LINK = JSON.stringify({ enabled: true, mode: 'dm', channelId: 'D1', linkCode: '', userId: 'U1', lastTs: '1.0', claimedTs: [] });

/** Rust as the scan feature sees it: a folder (or none), an enabled Slack link with a stored bot token, and an empty folder and inbox. */
function rust(status: () => ScanFolderStatus) {
  return fakeInvoke({
    vault_current: () => ({ root: 'C:/Vault', name: 'Vault' }),
    scan_folder_status: () => status(),
    scan_folder_watch: () => null,
    scan_folder_list: () => [],
    scan_folder_prune_baseline: () => [],
    integration_state_read: (a) => (a.name === 'slackLink' ? LINK : null),
    integration_state_write: () => null,
    secret_status: () => secretStatusOf({ slackBot: true }),
    slack_call: () => ({ status: 200, json: { ok: true, messages: [], channel: { id: 'D1' } } }),
  });
}

/** A Worker stand-in: it never answers, and counts terminate(). */
class FakeWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  stop = undefined;
  vi.useRealTimers();
});

describe('scan commands', () => {
  it('registers the three scan commands with the plugin names', () => {
    expect(scanCommands.map((c) => [c.id, c.nameKey])).toEqual([
      ['import-scanned-pages', 'Import scanned pages'],
      ['process-scan-folder', 'Process scan folder now'],
      ['assign-unmatched-scans', 'Assign unmatched scans'],
    ]);
  });

  it('process-scan-folder is hidden without a folder', async () => {
    let status = NO_FOLDER;
    const f = rust(() => status);
    const { ctx } = createTestHost();
    const available = (id: string) => scanCommands.find((c) => c.id === id)!.available?.(ctx) ?? true;
    stop = startScan(ctx, { invoke: f.invoke, listen: async () => () => undefined });
    await vi.waitFor(() => expect(f.calls.some(([c]) => c === 'scan_folder_status')).toBe(true));
    await flush();
    expect(available('process-scan-folder')).toBe(false);
    expect(available('import-scanned-pages')).toBe(true);
    expect(available('assign-unmatched-scans')).toBe(true);
    // Choosing a folder in the settings restarts the watcher, which reads the status again.
    status = FOLDER;
    scanFeature()!.watcher.restart();
    await vi.waitFor(() => expect(available('process-scan-folder')).toBe(true));
    // A vault switch forgets the folder.
    stop();
    stop = undefined;
    expect(available('process-scan-folder')).toBe(false);
  });

  it('a vault switch stops polling and terminates the decode worker', async () => {
    vi.useFakeTimers();
    const f = rust(() => FOLDER);
    const { ctx } = createTestHost();
    const workers: FakeWorker[] = [];
    const client = createDecodeClient(() => {
      const w = new FakeWorker();
      workers.push(w);
      return w as unknown as Worker;
    });
    stop = startScan(ctx, { invoke: f.invoke, listen: async () => () => undefined, decodeClient: client });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.calls.map(([c]) => c)).toContain('scan_folder_watch');
    expect(f.calls.map(([c]) => c)).toContain('slack_call');
    // A page in flight: the worker is running.
    const page = client.page({ close() {} } as ImageBitmap, { maxEdge: 2400, quality: 0.85 }).catch((e: unknown) => e);
    expect(workers).toHaveLength(1);
    expect(scanFeature()).toBeDefined();

    stop();
    stop = undefined;
    expect(scanFeature()).toBeUndefined();
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
    expect(await page).toBeInstanceOf(Error);

    const before = f.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.calls.slice(before).filter(([c]) => c === 'scan_folder_list')).toEqual([]);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.calls.slice(before).filter(([c]) => c === 'slack_call')).toEqual([]);
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
  });
});
