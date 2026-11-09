// @vitest-environment jsdom
/**
 * 앱 배선(plan Task 26): `startPartbank(ctx)` 이 보관함마다 PartBank 기능, 카탈로그 저장소, `@` 출처, 연결 시험, 노트 사용처
 * 동기화를 놓고, 돌려준 함수가 모두 거둔다. 네트워크와 자격 증명 관리자는 fakeInvoke 가 맡는다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SampleSource } from '@labnoteo/core';
import { fakeInvoke, secretStatusOf } from '../../integrations/__tests__/fakeNet';
import { integrationDepsFor, notifySecretsChange } from '../../integrations/IntegrationSettingsDialog';
import { probeFor } from '../../integrations/probes';
import type { InvokeFn, SecretStatus } from '../../integrations/netIpc';
import { createTestHost, type TestHost } from '../../labnote/__tests__/testHost';
import { commandById, clearCommandsForTest } from '../../labnote/commands/registry';
import { registerAllCommands } from '../../labnote/commands/registerAll';
import { PartbankUsageSync, type Timers } from '../../labnote/port/partbankUsageSync';
import { fromPluginData, type AppSettings } from '../../labnote/settings';
import { sampleSources } from '../../samples/sources';
import { sampleEvents } from '../../samples/env';
import type { ListenFn } from '../../vault/useVaultEvents';
import { currentCatalogStore, emptyCatalogStore } from '../catalogOverlay';
import { partbank } from '../current';
import { noteSyncEnv, startPartbank } from '../partbankApp';
import { PB_DESKTOP, PB_VAULT_ROOT, PB_WEB, partbankRoutes } from './pbFixture';

const GLOBAL = 'resources/labsamples';
const NOTE = 'labnote/001_GFP_expression/002_WB140.labnote.md';
const PART = '507f1f77bcf86cd799439011';
const PUT = '/labnoteo/usages/notes';
const PRUNE = '/labnoteo/usages/prune';

const source: SampleSource = { system: 'partbank', connection: 'web', origin: PB_WEB, type: 'part', id: PART, kid: null };

/** 지금 걸려 있는 타이머를 아는 가짜 타이머. `advance(ms)` 가 그 사이에 때가 된 것을 차례로 부른다. */
function manualTimers(): Timers & { live(): number; advance(ms: number): void } {
  let now = 0;
  let seq = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimeout(fn, ms) {
      const id = ++seq;
      pending.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(handle) {
      pending.delete(handle as number);
    },
    live: () => pending.size,
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...pending].filter(([, p]) => p.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    },
  };
}

let th: TestHost;
let net: ReturnType<typeof fakeInvoke>;
let status: SecretStatus;
let stateText: string | null;
let stops: Array<() => void> = [];
/** 감시자 구독(가짜 listen 이 받은 처리기). */
let watchers: Array<(e: { payload: { path: string; kind: 'created' | 'modified' | 'removed' } }) => void>;
const listen: ListenFn = async (_event, handler) => {
  watchers.push(handler);
  return () => {
    watchers = watchers.filter((h) => h !== handler);
  };
};

function setup(settings: Partial<AppSettings> = {}, files: Record<string, string> = {}): void {
  th = createTestHost(
    {
      [`${GLOBAL}/DNA.json`]: JSON.stringify({ 'DNA-1': { alias: 'pTrc', location: null, source } }),
      ...files,
    },
    { partbankWebUrl: PB_WEB, partbankDesktopUrl: PB_DESKTOP, globalSampleFolder: GLOBAL, ...settings },
  );
  net = fakeInvoke({
    secret_status: () => status,
    vault_current: () => ({ root: PB_VAULT_ROOT }),
    integration_state_read: () => stateText,
    integration_state_write: (args) => {
      stateText = String(args.content);
      return null;
    },
    partbank_catalog_list: () => [],
    ...partbankRoutes({ [PUT]: { stored: 1, skipped: [] }, [PRUNE]: { deleted: 0 } }),
  });
}

function start(ctx = th.ctx, extra: { timers?: Timers } = {}): () => void {
  const stop = startPartbank(ctx, { invoke: net.invoke as InvokeFn, listen, ...extra });
  stops.push(stop);
  return stop;
}

const requests = (path: string) =>
  net.calls.filter(([cmd, args]) => cmd === 'partbank_request' && args.path === path).map(([, args]) => args);

beforeEach(() => {
  status = secretStatusOf({ partbankWeb: true });
  stateText = null;
  watchers = [];
  stops = [];
});

afterEach(() => {
  stops.forEach((stop) => stop());
  th?.cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('startPartbank', () => {
  it('registers the @ source and both probes, and disposes them', async () => {
    setup();
    expect(sampleSources().some((s) => s.id === 'partbank')).toBe(false);
    const stop = start();

    expect(sampleSources().filter((s) => s.id === 'partbank')).toHaveLength(1);
    expect(probeFor('partbankDesktop')).toBeTypeOf('function');
    expect(probeFor('partbankWeb')).toBeTypeOf('function');
    expect(currentCatalogStore()).not.toBe(emptyCatalogStore);
    await vi.waitFor(() => expect(partbank()?.configured).toBe(true));

    stop();
    expect(sampleSources().some((s) => s.id === 'partbank')).toBe(false);
    expect(probeFor('partbankDesktop')).toBeUndefined();
    expect(probeFor('partbankWeb')).toBeUndefined();
  });

  it('turning usage sending off prunes, on syncs all with enabled() true', async () => {
    setup({ partbankSendUsages: false }, { [NOTE]: 'Mix @DNA;DNA-1.' });
    const seen: boolean[] = [];
    const syncAll = PartbankUsageSync.prototype.syncAll;
    vi.spyOn(PartbankUsageSync.prototype, 'syncAll').mockImplementation(function (this: PartbankUsageSync) {
      seen.push(th.ctx.settings.partbankSendUsages);
      return syncAll.call(this);
    });
    start();
    await vi.waitFor(() => expect(partbank()?.configured).toBe(true));
    const deps = integrationDepsFor(th.ctx, net.invoke as InvokeFn);

    await deps.commit({ partbankSendUsages: true });
    await vi.waitFor(() => expect(requests(PUT)).toHaveLength(1));
    expect(seen).toEqual([true]);
    const body = requests(PUT)[0].body as { notes: Array<{ note_path: string }> };
    expect(body.notes.map((n) => n.note_path)).toEqual([NOTE]);

    // 전부 보낸 뒤 그 세대 밖의 것을 지운다(백필의 prune)
    await vi.waitFor(() => expect(requests(PRUNE)).toHaveLength(1));
    const generations = () => requests(PRUNE).map((a) => (a.body as { generation: string }).generation);
    expect(generations()[0].startsWith('off-')).toBe(false);

    await deps.commit({ partbankSendUsages: false });
    await vi.waitFor(() => expect(requests(PRUNE)).toHaveLength(2));
    expect(generations()[1].startsWith('off-')).toBe(true);
  });

  it('enabled() follows the saved value before ctx.settings catches up', async () => {
    // 앱의 ctx.settings 는 다시 그려진 뒤에야 바뀐다: 저장만 하고 ctx 는 그대로 두는 맥락
    setup({ partbankSendUsages: false }, { [NOTE]: 'Mix @DNA;DNA-1.' });
    const stale = th.ctx.settings;
    const ctx = { ...th.ctx, settings: stale, updateSettings: async () => undefined };
    start(ctx);
    await vi.waitFor(() => expect(partbank()?.configured).toBe(true));

    await integrationDepsFor(ctx, net.invoke as InvokeFn).commit({ partbankSendUsages: true });

    await vi.waitFor(() => expect(requests(PUT)).toHaveLength(1));
  });

  it('a vault switch stops usage sync timers', async () => {
    setup({ partbankSendUsages: true }, { [NOTE]: 'Mix @DNA;DNA-1.' });
    const timers = manualTimers();
    const stop = start(th.ctx, { timers });
    await vi.waitFor(() => expect(partbank()?.configured).toBe(true));
    // 시작 패스가 걸려 있고, 노트가 바뀌면 보내기와 상태 저장이 걸린다
    expect(timers.live()).toBe(1);
    watchers.forEach((w) => w({ payload: { path: NOTE, kind: 'modified' } }));
    expect(timers.live()).toBeGreaterThan(1);

    stop();
    expect(timers.live()).toBe(0);
    timers.advance(35_000);
    await new Promise((r) => setTimeout(r, 0));
    expect(requests(PUT)).toEqual([]);
  });

  it('a note change from the watcher, a rename or a delete is sent', async () => {
    setup({ partbankSendUsages: true }, { [NOTE]: 'Mix @DNA;DNA-1.' });
    const timers = manualTimers();
    start(th.ctx, { timers });
    await vi.waitFor(() => expect(partbank()?.configured).toBe(true));

    watchers.forEach((w) => w({ payload: { path: NOTE, kind: 'modified' } }));
    timers.advance(5_000);
    await vi.waitFor(() => expect(requests(PUT)).toHaveLength(1));
  });

  it('a registry change schedules a reconcile, unless it came from note sync', async () => {
    setup({ partbankSendUsages: true });
    const reconcile = vi.spyOn(PartbankUsageSync.prototype, 'scheduleReconcile');
    start();

    noteSyncEnv({ changed: (paths?: readonly string[]) => sampleEvents.emit(paths) }).changed([`${GLOBAL}/DNA.json`]);
    expect(reconcile).not.toHaveBeenCalled();

    sampleEvents.emit([`${GLOBAL}/DNA.json`]);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it('a saved key refreshes the feature', async () => {
    status = secretStatusOf({});
    setup();
    clearCommandsForTest();
    registerAllCommands();
    start();
    await vi.waitFor(() => expect(net.calls.some(([cmd]) => cmd === 'secret_status')).toBe(true));
    await new Promise((r) => setTimeout(r, 0));
    expect(partbank()!.configured).toBe(false);
    expect(commandById('download-partbank-catalog')!.available!(th.ctx)).toBe(false);

    notifySecretsChange(secretStatusOf({ partbankWeb: true }));

    expect(partbank()!.configured).toBe(true);
    expect(commandById('download-partbank-catalog')!.available!(th.ctx)).toBe(true);
  });

  it('a URL change refreshes the key status', async () => {
    setup();
    start();
    await vi.waitFor(() => expect(partbank()?.configured).toBe(true));
    const before = net.calls.filter(([cmd]) => cmd === 'secret_status').length;

    await integrationDepsFor(th.ctx, net.invoke as InvokeFn).commit({ partbankWebUrl: 'https://pb.example.org' });

    await vi.waitFor(() => expect(net.calls.filter(([cmd]) => cmd === 'secret_status').length).toBe(before + 1));
  });

  it('a key saved in vault A does not start usage sync in vault B', async () => {
    vi.useFakeTimers();
    setup({ ...fromPluginData(undefined) }, { [NOTE]: 'Mix @DNA;DNA-1.' });
    expect(th.ctx.settings.partbankSendUsages).toBe(false);
    expect(th.ctx.settings.partbankWebUrl).toBe(PB_WEB);
    start();

    await vi.advanceTimersByTimeAsync(35_000);

    expect(partbank()?.configured).toBe(true);
    expect(requests(PUT)).toEqual([]);
  });

  it('the disposer clears the singleton and the catalog store', () => {
    setup();
    const stop = start();
    expect(partbank()).toBeDefined();
    expect(currentCatalogStore()).not.toBe(emptyCatalogStore);

    stop();

    expect(partbank()).toBeUndefined();
    expect(currentCatalogStore()).toBe(emptyCatalogStore);
  });
});
