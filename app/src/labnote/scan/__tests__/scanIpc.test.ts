import { describe, expect, it } from 'vitest';
import { fakeInvoke, netError } from '../../../integrations/__tests__/fakeNet';
import { NetError } from '../../../integrations/netIpc';
import { EVENTS_FIXTURE } from '../../../__tests__/fixtures';
import {
  SCAN_FOLDER_CHANGED,
  readScanHistory,
  readSlackLink,
  scanFolderChoose,
  scanFolderClear,
  scanFolderList,
  scanFolderMove,
  scanFolderPruneBaseline,
  scanFolderRead,
  scanFolderSetMode,
  scanFolderStatus,
  scanFolderWatch,
  writeScanHistory,
  writeSlackLink,
  type ScanFolderStatus,
  type SlackLink,
} from '../scanIpc';

const link: SlackLink = { enabled: true, mode: 'dm', channelId: '', linkCode: 'LN-ABCD', userId: 'U1', lastTs: '1.2', claimedTs: [] };
const status: ScanFolderStatus = {
  path: 'D:\\scans',
  mode: 'dedicated',
  exists: true,
  insideVault: false,
  since: 5,
  baseline: ['a|1|2'],
};

describe('scanIpc', () => {
  it('writeSlackLink refuses anything that looks like a Slack token', async () => {
    const f = fakeInvoke({ integration_state_write: () => null });
    await expect(writeSlackLink({ ...link, channelId: 'xoxb-1' }, f.invoke)).rejects.toMatchObject({ kind: 'badInput' });
    for (const bad of ['xoxa-2', 'xoxp-3', 'xoxr-4']) {
      await expect(writeSlackLink({ ...link, userId: bad }, f.invoke)).rejects.toBeInstanceOf(NetError);
    }
    await expect(writeSlackLink({ ...link, claimedTs: ['xoxb-5'] }, f.invoke)).rejects.toMatchObject({ kind: 'badInput' });
    expect(f.calls).toEqual([]);
  });

  it('writeSlackLink writes the link as JSON to slackLink', async () => {
    const f = fakeInvoke({ integration_state_write: () => null });
    await writeSlackLink(link, f.invoke);
    expect(f.calls).toEqual([['integration_state_write', { name: 'slackLink', content: JSON.stringify(link) }]]);
  });

  it('readSlackLink reads slackLink, and gives undefined when nothing or no object is stored', async () => {
    expect(await readSlackLink(fakeInvoke({ integration_state_read: () => JSON.stringify(link) }).invoke)).toEqual(link);
    const f = fakeInvoke({ integration_state_read: () => null });
    expect(await readSlackLink(f.invoke)).toBeUndefined();
    expect(f.calls).toEqual([['integration_state_read', { name: 'slackLink' }]]);
    expect(await readSlackLink(fakeInvoke({ integration_state_read: () => '{' }).invoke)).toBeUndefined();
    expect(await readSlackLink(fakeInvoke({ integration_state_read: () => '[]' }).invoke)).toBeUndefined();
  });

  it('readSlackLink fills missing or wrongly typed fields with defaults', async () => {
    const stored = JSON.stringify({ enabled: 'yes', mode: 'channel', channelId: 'C1', claimedTs: ['1', 2] });
    const got = await readSlackLink(fakeInvoke({ integration_state_read: () => stored }).invoke);
    expect(got).toEqual({ enabled: false, mode: 'channel', channelId: 'C1', linkCode: '', userId: '', lastTs: '', claimedTs: ['1'] });
  });

  it('the scan history round-trips through scanFolderHistory, keeping only numbers', async () => {
    const w = fakeInvoke({ integration_state_write: () => null });
    await writeScanHistory({ 'a|1|2': 3 }, w.invoke);
    expect(w.calls).toEqual([['integration_state_write', { name: 'scanFolderHistory', content: '{"a|1|2":3}' }]]);
    const r = fakeInvoke({ integration_state_read: () => '{"a|1|2":3,"b":"x"}' });
    expect(await readScanHistory(r.invoke)).toEqual({ 'a|1|2': 3 });
    expect(r.calls).toEqual([['integration_state_read', { name: 'scanFolderHistory' }]]);
    expect(await readScanHistory(fakeInvoke({ integration_state_read: () => null }).invoke)).toEqual({});
    expect(await readScanHistory(fakeInvoke({ integration_state_read: () => 'nope' }).invoke)).toEqual({});
  });

  it('every wrapper rejects with NetError', async () => {
    const f = fakeInvoke({
      scan_folder_status: () => {
        throw netError('notConfigured');
      },
    });
    await expect(scanFolderStatus(f.invoke)).rejects.toMatchObject({ kind: 'notConfigured' });
    const raw = fakeInvoke({}); // unrouted: rejects with a plain {kind, message}
    const all: Array<() => Promise<unknown>> = [
      () => scanFolderChoose(raw.invoke),
      () => scanFolderClear(raw.invoke),
      () => scanFolderSetMode('shared', raw.invoke),
      () => scanFolderStatus(raw.invoke),
      () => scanFolderList(raw.invoke),
      () => scanFolderPruneBaseline([], raw.invoke),
      () => scanFolderRead('a.jpg', raw.invoke),
      () => scanFolderMove('a.jpg', 'failed', raw.invoke),
      () => scanFolderWatch(raw.invoke),
      () => readSlackLink(raw.invoke),
      () => writeSlackLink(link, raw.invoke),
      () => readScanHistory(raw.invoke),
      () => writeScanHistory({}, raw.invoke),
    ];
    for (const run of all) await expect(run()).rejects.toBeInstanceOf(NetError);
  });

  it('scanFolderPruneBaseline sends the present keys only', async () => {
    const f = fakeInvoke({ scan_folder_prune_baseline: () => ['a|1|2'] });
    await expect(scanFolderPruneBaseline(['a|1|2'], f.invoke)).resolves.toEqual(['a|1|2']);
    expect(f.calls).toEqual([['scan_folder_prune_baseline', { present: ['a|1|2'] }]]);
  });

  it('the folder wrappers send their arguments and pass the answers through', async () => {
    const bytes = new ArrayBuffer(3);
    const entry = { name: 'a.jpg', size: 1, mtimeMs: 2, birthtimeMs: null };
    const f = fakeInvoke({
      scan_folder_choose: () => status,
      scan_folder_clear: () => null,
      scan_folder_set_mode: () => null,
      scan_folder_status: () => status,
      scan_folder_list: () => [entry],
      scan_folder_read: () => bytes,
      scan_folder_move: () => 'labnote-processed/a.jpg',
      scan_folder_watch: () => null,
    });
    expect(await scanFolderChoose(f.invoke)).toEqual(status);
    expect(await scanFolderClear(f.invoke)).toBeUndefined();
    expect(await scanFolderSetMode('shared', f.invoke)).toBeUndefined();
    expect(await scanFolderStatus(f.invoke)).toEqual(status);
    expect(await scanFolderList(f.invoke)).toEqual([entry]);
    expect(await scanFolderRead('a.jpg', f.invoke)).toBe(bytes);
    expect(await scanFolderMove('a.jpg', 'processed', f.invoke)).toBe('labnote-processed/a.jpg');
    expect(await scanFolderWatch(f.invoke)).toBeUndefined();
    expect(f.calls).toEqual([
      ['scan_folder_choose', {}],
      ['scan_folder_clear', {}],
      ['scan_folder_set_mode', { mode: 'shared' }],
      ['scan_folder_status', {}],
      ['scan_folder_list', {}],
      ['scan_folder_read', { name: 'a.jpg' }],
      ['scan_folder_move', { name: 'a.jpg', outcome: 'processed' }],
      ['scan_folder_watch', {}],
    ]);
  });

  it('SCAN_FOLDER_CHANGED is the event name Rust emits', () => {
    const events = EVENTS_FIXTURE as unknown as Record<string, { name: string }>;
    expect(SCAN_FOLDER_CHANGED).toBe(events.scanFolderChanged.name);
  });
});
