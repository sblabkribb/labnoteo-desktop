// @vitest-environment jsdom
/**
 * 옮겨 온 노트 사용 보고(vendor tests/plugin/partbankUsageSync.test.ts 의 모든 경우와 계획 Task 25 의 이름 붙은 경우).
 * 실험 노트만, partbank 에 연결된 샘플 참조만, 지난번과 달라진 것만 보내고, 꺼졌거나 오래된 서버에는 알림을 띄우지 않는다.
 * 상태는 앱 데이터(integration_state `partbankUsage`)에만 있다. 네트워크는 fakeInvoke 가 맡는다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SampleSource } from '@labnoteo/core';
import { secretStatusOf } from '../../integrations/__tests__/fakeNet';
import { cancelAllRequests, vaultGuard, type InvokeFn } from '../../integrations/netIpc';
import { linkIndex } from '../../links/linkIndex';
import {
  PartbankUsageSync,
  RECONCILE_DEBOUNCE_MS,
  SAVE_DEBOUNCE_MS,
  STARTUP_DELAY_MS,
  cachedResolver,
  isUsageNote,
  noteUsage,
  serverKey,
  usageStateStore,
  type UsageEvents,
} from '../../labnote/port/partbankUsageSync';
import { resolveSampleDefinition } from '../../labnote/port/sampleQuery';
import { PB_VAULT_ROOT, PB_WEB, partbankRoutes, pbEnv, type PbEnv } from './pbFixture';

const WEB = PB_WEB;
const GLOBAL = 'resources/labsamples';
const EXP = 'labnote/001_GFP_expression';
const LOCAL = `${EXP}/resources/labsamples`;
const NOTE = `${EXP}/002_WB140.labnote.md`;
const OTHER = `${EXP}/003_WT060.labnote.md`;
const PART = '507f1f77bcf86cd799439011';
const PART2 = '507f1f77bcf86cd799439022';
const PUT = '/labnoteo/usages/notes';
const PRUNE = '/labnoteo/usages/prune';

const source = (id: string, origin = WEB): SampleSource => ({
  system: 'partbank',
  connection: 'web',
  origin,
  type: 'part',
  id,
  kid: null,
});

const REGISTRY = {
  'DNA-1': { alias: 'pTrc', location: null, source: source(PART) },
  'DNA-2': { alias: null, location: null },
  'DNA-3': { alias: null, location: null, source: source(PART2, 'https://elsewhere.example') },
};

let pb: PbEnv;
/** integration_state `partbankUsage` 의 지금 글(Rust 의 앱 데이터 파일 흉내). */
let stateText: string | null;
let enabled: boolean;
/** 다음 PUT·prune 이 던질 값(없으면 성공). 함수는 부를 때마다 묻는다. */
let putFails: (() => unknown) | undefined;
let pruneFails: (() => unknown) | undefined;
/** PUT 을 받을 때마다 부른다(답하기 전에). */
let onPut: ((args: Record<string, unknown>) => void) | undefined;
let sync: PartbankUsageSync;

type PutBody = {
  client_id: string;
  generation: string;
  vault_name: string;
  notes: Array<{ note_path: string; note_title: string; experiment: string | null; refs: Array<{ sample_id: string }> }>;
};

const requests = (path: string) =>
  pb.calls.filter(([cmd, args]) => cmd === 'partbank_request' && args.path === path).map(([, args]) => args);
const puts = () => requests(PUT).map((a) => a.body as PutBody);
const prunes = () => requests(PRUNE).map((a) => a.body as { client_id: string; generation: string });
/** 보낸 노트를 차례로 `path: [샘플 id]` 로. */
const sentNotes = () => puts().flatMap((b) => b.notes.map((n) => `${n.note_path}: ${n.refs.map((r) => r.sample_id).join(',')}`));
const clearCalls = () => pb.calls.splice(0, pb.calls.length);
const savedState = () => JSON.parse(stateText ?? 'null') as Record<string, unknown> | null;

function newSync(overrides: Partial<ConstructorParameters<typeof PartbankUsageSync>[0]> = {}): PartbankUsageSync {
  return new PartbankUsageSync({
    env: () => pb.env,
    feature: pb.feature,
    enabled: () => enabled,
    vaultName: () => 'lab',
    state: usageStateStore(pb.invoke),
    guard: () => vaultGuard(pb.invoke),
    ...overrides,
  });
}

async function setNote(path: string, text: string): Promise<void> {
  await pb.th.vault.mem.write(path, text);
  linkIndex.setFiles(Object.keys(pb.th.vault.files()));
}

async function deleteNote(path: string): Promise<void> {
  await pb.th.vault.mem.remove(path);
  linkIndex.setFiles(Object.keys(pb.th.vault.files()));
}

async function writeRegistry(folder: string, records: Record<string, unknown>): Promise<void> {
  await pb.th.vault.mem.write(`${folder}/DNA.json`, JSON.stringify(records));
}

beforeEach(() => {
  stateText = null;
  enabled = true;
  putFails = undefined;
  pruneFails = undefined;
  onPut = undefined;
  pb = pbEnv(
    { [`${GLOBAL}/DNA.json`]: JSON.stringify(REGISTRY) },
    {
      settings: { globalSampleFolder: GLOBAL, partbankSendUsages: true },
      routes: {
        ...partbankRoutes({
          [PUT]: (args: Record<string, unknown>) => {
            onPut?.(args);
            if (putFails) throw putFails();
            return { stored: 0, skipped: [] };
          },
          [PRUNE]: () => {
            if (pruneFails) throw pruneFails();
            return { deleted: 0 };
          },
        }),
        integration_state_read: () => stateText,
        integration_state_write: (args) => {
          stateText = String(args.content);
          return null;
        },
      },
    },
  );
  sync = newSync();
});

afterEach(() => {
  sync.stop();
  pb.th.cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('what is sent', () => {
  it('sends the partbank-linked references of lab notes with their sections', async () => {
    await setNote(NOTE, ['# Run', '## Methods', 'Mix @DNA;DNA-1 and @DNA;DNA-2.', '## Results', 'Band of @DNA;DNA-1.'].join('\n'));

    await sync.syncAll();

    expect(puts()).toHaveLength(1);
    const body = puts()[0];
    expect(body.vault_name).toBe('lab');
    expect(body.client_id).toEqual(expect.any(String));
    expect(body.notes).toEqual([
      {
        note_path: NOTE,
        note_title: '002_WB140',
        experiment: '001_GFP_expression',
        refs: [
          {
            type: 'part',
            id: PART,
            sample_type: 'DNA',
            sample_id: 'DNA-1',
            alias: 'pTrc',
            headings: ['Run › Methods', 'Run › Results'],
          },
        ],
      },
    ]);
  });

  it('leaves out AI callouts, other servers, and notes that are not lab notes', async () => {
    await setNote(NOTE, ['> [!note] AI suggestion', '> try @DNA;DNA-1', '', 'Use @DNA;DNA-3.'].join('\n'));
    await setNote('daily/2026-10-27.md', 'Used @DNA;DNA-1 today.');
    await setNote('templates/run.md', '@DNA;DNA-1');

    await sync.syncAll();

    expect(sentNotes()).toEqual([]);
  });

  it('sends a note outside any experiment without one', async () => {
    await setNote('scratch/idea.labnote.md', '@DNA;DNA-1');

    await sync.syncAll();

    expect(puts()[0].notes[0]).toMatchObject({ note_title: 'idea', experiment: null });
  });

  it('sends nothing when turned off or with no connection', async () => {
    await setNote(NOTE, '@DNA;DNA-1');
    enabled = false;
    await sync.syncAll();
    enabled = true;
    pb.feature.setStatus(secretStatusOf({}));
    await sync.syncAll();

    expect(puts()).toEqual([]);
  });

  it('PUT body carries vault_name, note_path, note_title, experiment and sorted refs', async () => {
    await writeRegistry(GLOBAL, {
      ...REGISTRY,
      'DNA-4': { alias: null, location: null, source: source(PART2) },
    });
    await setNote(NOTE, '## Methods\n@DNA;DNA-4 then @DNA;DNA-1');

    await sync.syncAll();

    const [body] = puts();
    expect(body.vault_name).toBe('lab');
    expect(body.notes).toHaveLength(1);
    expect(body.notes[0]).toMatchObject({ note_path: NOTE, note_title: '002_WB140', experiment: '001_GFP_expression' });
    // 정렬: type, id, sample_type, sample_id 순. PART(…011) 이 PART2(…022) 앞이다.
    expect(body.notes[0].refs.map((r) => r.sample_id)).toEqual(['DNA-1', 'DNA-4']);
  });

  it('only *.labnote.md notes are reported', () => {
    expect(isUsageNote(NOTE)).toBe(true);
    expect(isUsageNote('X/RUN.LABNOTE.MD')).toBe(true);
    expect(isUsageNote('daily/2026-10-27.md')).toBe(false);
    expect(isUsageNote('labnote/README.md')).toBe(false);
    expect(isUsageNote('notes/labnote.md')).toBe(false);
  });
});

describe('changes only', () => {
  beforeEach(async () => {
    await setNote(NOTE, '@DNA;DNA-1');
    await setNote(OTHER, 'nothing linked');
    await sync.syncAll();
    clearCalls();
  });

  it('does not resend a note whose references did not change', async () => {
    await setNote(NOTE, 'Edited text, same @DNA;DNA-1.');
    sync.markDirty(NOTE);
    await sync.syncDirty();
    await sync.syncAll();

    expect(puts()).toEqual([]);
    expect(prunes()).toEqual([]);
  });

  it('sends a note again when its references changed, and empty when they are gone', async () => {
    await setNote(NOTE, '## Results\n@DNA;DNA-1');
    sync.markDirty(NOTE);
    await sync.syncDirty();
    await setNote(NOTE, 'no references left');
    sync.markDirty(NOTE);
    await sync.syncDirty();
    sync.markDirty(NOTE);
    await sync.syncDirty();

    expect(sentNotes()).toEqual([`${NOTE}: DNA-1`, `${NOTE}: `]);
  });

  it('clears a renamed or deleted note', async () => {
    const moved = `${EXP}/004_moved.labnote.md`;
    await deleteNote(NOTE);
    await setNote(moved, '@DNA;DNA-1');
    sync.markDirty(NOTE);
    sync.markDirty(moved);
    await sync.syncDirty();

    expect(sentNotes().sort()).toEqual([`${moved}: DNA-1`, `${NOTE}: `].sort());
  });

  it('notices a note deleted while the app was closed on the next full pass', async () => {
    await deleteNote(NOTE);

    await sync.syncAll();

    expect(sentNotes()).toEqual([`${NOTE}: `]);
  });

  it('picks up a registry change in a note that did not change', async () => {
    await writeRegistry(GLOBAL, { 'DNA-1': { alias: 'pTrc', location: null } });

    await sync.syncAll();

    expect(sentNotes()).toEqual([`${NOTE}: `]);
  });
});

describe('backfill', () => {
  it('tags the first pass with a generation and prunes the rest once it went through', async () => {
    await setNote(NOTE, '@DNA;DNA-1');

    await sync.syncAll();

    const [put] = puts();
    expect(prunes()).toEqual([{ client_id: put.client_id, generation: put.generation }]);
  });

  it('does not prune after a failed batch, and starts over next time', async () => {
    await setNote(NOTE, '@DNA;DNA-1');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    putFails = () => ({ kind: 'offline', message: 'raw-rust-text' });

    await sync.syncAll();
    expect(prunes()).toEqual([]);

    putFails = undefined;
    await sync.syncAll();
    const [first, second] = puts().map((b) => b.generation);
    expect(second).not.toBe(first);
    expect(prunes()).toEqual([expect.objectContaining({ generation: second })]);
  });

  it('a key re-save for the same origin starts a new generation and prunes', async () => {
    await setNote(NOTE, '@DNA;DNA-1');
    pb.feature.setStatus(secretStatusOf({ partbankWeb: true }, { partbankWeb: 1 }));
    await sync.syncAll();
    const g1 = puts()[0].generation;
    expect(prunes()).toEqual([expect.objectContaining({ generation: g1 })]);

    pb.feature.setStatus(secretStatusOf({ partbankWeb: true }, { partbankWeb: 2 }));
    await sync.syncAll();

    expect(puts()).toHaveLength(2);
    const g2 = puts()[1].generation;
    expect(g2).not.toBe(g1);
    // 다시 채우기는 참조가 있는 노트를 모두 보낸다(바뀌지 않았어도).
    expect(sentNotes()).toEqual([`${NOTE}: DNA-1`, `${NOTE}: DNA-1`]);
    expect(prunes()).toHaveLength(2);
    expect(prunes()[1]).toEqual({ client_id: puts()[1].client_id, generation: g2 });
  });

  it('the same key epoch does not backfill again', async () => {
    await setNote(NOTE, '@DNA;DNA-1');
    await sync.syncAll();
    pb.feature.setStatus(secretStatusOf({ partbankWeb: true }));

    await sync.syncAll();

    expect(puts()).toHaveLength(1);
    expect(prunes()).toHaveLength(1);
  });
});

describe('failures', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(async () => {
    await setNote(NOTE, '@DNA;DNA-1');
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
  });

  it.each([404, 405])('404 or 405 marks the server unsupported for the session (%i)', async (status) => {
    putFails = () => ({ kind: 'status', message: 'raw-rust-text', status, body: 'secret-ish body' });

    await sync.syncAll();
    sync.markDirty(NOTE);
    await sync.syncDirty();
    await sync.syncAll();

    expect(puts()).toHaveLength(1);
    expect(pb.th.notes).toEqual([]);
  });

  it('keeps the note queued across restarts while the server is down', async () => {
    putFails = () => ({ kind: 'offline', message: 'raw-rust-text' });
    sync.markDirty(NOTE);
    await sync.syncDirty();
    expect(savedState()?.dirty).toEqual([NOTE]);

    putFails = undefined;
    sync.stop();
    const restarted = newSync();
    await restarted.syncDirty();
    restarted.stop();

    expect(sentNotes().at(-1)).toBe(`${NOTE}: DNA-1`);
    expect(savedState()?.dirty).toEqual([]);
  });

  it('unauthorized warns once', async () => {
    putFails = () => ({ kind: 'status', message: 'raw-rust-text', status: 401 });

    await sync.syncAll();
    await sync.syncAll();

    expect(pb.th.notes.filter((n) => n.kind === 'error')).toHaveLength(1);
    expect(pb.th.notes[0].message).not.toContain('raw-rust-text');
  });

  it('a warning never carries the error body or Rust text', async () => {
    putFails = () => ({ kind: 'status', message: 'raw-rust-text', status: 500, body: 'body-with-pbk_secret' });

    await sync.syncAll();

    expect(warn).toHaveBeenCalled();
    const logged = JSON.stringify(warn.mock.calls, (_k, v: unknown) => (v instanceof Error ? `${v.name}: ${v.message}` : v));
    expect(logged).not.toContain('pbk_secret');
    expect(logged).not.toContain('raw-rust-text');
  });
});

describe('turning it off', () => {
  it('disable prunes with an off- generation', async () => {
    await setNote(NOTE, '@DNA;DNA-1');
    await sync.syncAll();
    const clientId = puts()[0].client_id;
    clearCalls();

    enabled = false;
    await sync.disable();

    const [{ client_id, generation }] = prunes();
    expect(client_id).toBe(clientId);
    expect(client_id).toBe(savedState()?.clientId);
    expect(generation).toMatch(/^off-/);
    expect(savedState()?.sent).toEqual({});
    expect(savedState()?.backfill).toEqual({});
  });

  it('turning it on again backfills anew with the same client id', async () => {
    await setNote(NOTE, '@DNA;DNA-1');
    await sync.syncAll();
    await sync.disable();
    clearCalls();

    await sync.syncAll();

    expect(sentNotes()).toEqual([`${NOTE}: DNA-1`]);
    expect(prunes()).toHaveLength(1);
    expect(puts()[0].client_id).toBe(savedState()?.clientId);
  });

  it('does nothing while partbankSendUsages is off', async () => {
    vi.useFakeTimers();
    enabled = false;
    const events = fakeEvents();
    sync.register(events);
    await setNote(NOTE, '@DNA;DNA-1');

    events.modify(NOTE);
    sync.markDirty(NOTE);
    sync.scheduleReconcile();
    await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS + RECONCILE_DEBOUNCE_MS);
    await sync.syncAll();
    await sync.syncDirty();

    expect(pb.calls.filter(([cmd]) => cmd === 'partbank_request')).toEqual([]);
    expect(pb.calls.filter(([cmd]) => cmd === 'integration_state_write')).toEqual([]);
  });
});

describe('state', () => {
  it('state lives in integration_state, never in settings or the vault', async () => {
    const settingsBefore = JSON.stringify(pb.th.ctx.settings);
    await setNote(NOTE, '@DNA;DNA-1');
    const logBefore = pb.th.vault.log.length;

    await sync.syncAll();

    expect(pb.calls).toContainEqual(['integration_state_read', { name: 'partbankUsage' }]);
    expect(pb.calls).toContainEqual(['integration_state_write', expect.objectContaining({ name: 'partbankUsage' })]);
    const writes = pb.th.vault.log
      .slice(logBefore)
      .filter((e) => ['vault_write', 'vault_modify', 'vault_create', 'vault_remove', 'vault_rename', 'vault_trash', 'vault_mkdir'].includes(e.cmd));
    expect(writes).toEqual([]);
    expect(JSON.stringify(pb.th.ctx.settings)).toBe(settingsBefore);
    const state = savedState()!;
    expect(Object.keys(state).sort()).toEqual(['backfill', 'clientId', 'dirty', 'sent']);
    expect(Object.keys(state.sent as object)).toEqual([serverKey({ kind: 'web', origin: WEB })]);
  });

  it('reads the stored state once', async () => {
    await setNote(NOTE, '@DNA;DNA-1');
    await sync.syncAll();
    await sync.syncAll();
    sync.markDirty(NOTE);
    await sync.syncDirty();

    expect(pb.calls.filter(([cmd]) => cmd === 'integration_state_read')).toHaveLength(1);
  });

  it('an unreadable state file starts afresh instead of failing every sync', async () => {
    stateText = '<<<<<<< not json';
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await setNote(NOTE, '@DNA;DNA-1');

    await sync.syncAll();

    expect(sentNotes()).toEqual([`${NOTE}: DNA-1`]);
  });

  it('a failed state read sends nothing and writes nothing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failing = newSync({
      state: { read: () => Promise.reject(new Error('io')), write: () => Promise.reject(new Error('must not write')) },
    });
    await setNote(NOTE, '@DNA;DNA-1');

    await failing.syncAll();
    failing.stop();

    expect(puts()).toEqual([]);
  });

  it('a vault switch during a sync sends nothing more and writes no state', async () => {
    await setNote(NOTE, '@DNA;DNA-1');
    let root = PB_VAULT_ROOT;
    const currentOnly = (async (cmd: string) => {
      if (cmd === 'vault_current') return { root };
      throw new Error(`unexpected ${cmd}`);
    }) as InvokeFn;
    const switching = newSync({ guard: () => vaultGuard(currentOnly) });
    // 첫 PUT 이 가는 사이에 보관함이 바뀐다: prune 앞의 확인과 상태 저장 앞의 확인이 멈춰야 한다.
    onPut = () => {
      root = 'C:/vaults/other';
    };

    await switching.syncAll();
    switching.stop();

    expect(puts()).toHaveLength(1);
    expect(prunes()).toEqual([]);
    expect(stateText).toBeNull();
  });

  it('cancelAllRequests (vault switch) stops a sync before it sends', async () => {
    await setNote(NOTE, '@DNA;DNA-1');
    const guard = await vaultGuard(pb.invoke);
    cancelAllRequests();
    const s = newSync({ guard: async () => guard });

    await s.syncAll();
    s.stop();

    expect(puts()).toEqual([]);
    expect(stateText).toBeNull();
  });
});

describe('timers and events', () => {
  it('a modify sends after the save delay; rename and delete mark both paths', async () => {
    vi.useFakeTimers();
    await setNote(NOTE, '@DNA;DNA-1');
    await sync.syncAll();
    clearCalls();
    const events = fakeEvents();
    const off = sync.register(events);

    await setNote(NOTE, '## Results\n@DNA;DNA-1');
    events.modify(NOTE);
    events.modify('daily/x.md');
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS - 1);
    expect(puts()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await sync.syncDirty();
    expect(sentNotes()).toEqual([`${NOTE}: DNA-1`]);

    clearCalls();
    const moved = `${EXP}/005_moved.labnote.md`;
    await deleteNote(NOTE);
    await setNote(moved, '@DNA;DNA-1');
    events.rename(moved, NOTE);
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    await sync.syncDirty();
    expect(sentNotes().sort()).toEqual([`${moved}: DNA-1`, `${NOTE}: `].sort());

    clearCalls();
    await deleteNote(moved);
    events.delete(moved);
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    await sync.syncDirty();
    expect(sentNotes()).toEqual([`${moved}: `]);

    off();
    expect(events.listeners()).toBe(0);
  });

  it('the startup pass runs after the startup delay, and the disposer cancels it', async () => {
    vi.useFakeTimers();
    await setNote(NOTE, '@DNA;DNA-1');
    const off = sync.register(fakeEvents());
    await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS - 1);
    expect(puts()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await sync.syncDirty();
    expect(puts()).toHaveLength(1);
    off();

    const other = newSync();
    const off2 = other.register(fakeEvents());
    off2();
    await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS);
    await other.syncDirty();
    other.stop();
    expect(puts()).toHaveLength(1);
  });

  it('scheduleReconcile looks at every note after the reconcile delay', async () => {
    vi.useFakeTimers();
    await setNote(NOTE, '@DNA;DNA-1');
    await sync.syncAll();
    clearCalls();
    await writeRegistry(GLOBAL, { 'DNA-1': { alias: 'pTrc', location: null } });

    sync.scheduleReconcile();
    await vi.advanceTimersByTimeAsync(RECONCILE_DEBOUNCE_MS);
    await sync.syncDirty();

    expect(sentNotes()).toEqual([`${NOTE}: `]);
  });

  it('stop cancels pending timers and nothing is sent after it', async () => {
    vi.useFakeTimers();
    await setNote(NOTE, '@DNA;DNA-1');
    sync.markDirty(NOTE);
    sync.scheduleReconcile();
    sync.stop();
    await vi.advanceTimersByTimeAsync(RECONCILE_DEBOUNCE_MS + STARTUP_DELAY_MS);
    await sync.syncAll();

    expect(puts()).toEqual([]);
    expect(pb.calls.filter(([cmd]) => cmd === 'integration_state_write')).toEqual([]);
  });

  it('injected timers are used', async () => {
    const pending: Array<{ fn: () => void; ms: number }> = [];
    const timers = {
      setTimeout: (fn: () => void, ms: number) => pending.push({ fn, ms }),
      clearTimeout: () => {},
    };
    const s = newSync({ timers });
    s.markDirty(NOTE);
    s.register(fakeEvents());
    s.stop();

    expect(pending.map((p) => p.ms)).toEqual(expect.arrayContaining([SAVE_DEBOUNCE_MS, STARTUP_DELAY_MS]));
  });
});

describe('cachedResolver', () => {
  it('names the same sample as Go to definition (Local first, then Global)', async () => {
    await writeRegistry(LOCAL, { 'DNA-1': { alias: 'local copy', location: null, source: source(PART2) } });
    const resolve = cachedResolver(pb.env);

    for (const [id, docPath] of [
      ['DNA-1', NOTE],
      ['DNA-1', 'scratch/x.labnote.md'],
      ['DNA-2', NOTE],
      ['DNA-9', NOTE],
    ]) {
      expect(await resolve('DNA', id, docPath)).toEqual(await resolveSampleDefinition(pb.env, { type: 'DNA', id, docPath }));
    }
    expect((await resolve('DNA', 'DNA-1', NOTE))?.record.alias).toBe('local copy');
  });

  it('reads each registry file once', async () => {
    const reads = () => pb.th.vault.log.filter((e) => e.cmd === 'vault_read' && e.args.path === `${GLOBAL}/DNA.json`).length;
    const resolve = cachedResolver(pb.env);
    const before = reads();
    await resolve('DNA', 'DNA-1', NOTE);
    await resolve('DNA', 'DNA-2', OTHER);

    expect(reads() - before).toBe(1);
  });
});

describe('helpers', () => {
  it('keys a server by kind and origin', () => {
    expect(serverKey({ kind: 'web', origin: 'https://PB.example' })).toBe('web:https://pb.example');
  });

  it('sorts refs so the same note always hashes the same', () => {
    const a = { type: 'part' as const, id: 'b', sample_type: 'DNA', sample_id: '1', headings: [] };
    const b = { type: 'part' as const, id: 'a', sample_type: 'DNA', sample_id: '2', headings: [] };
    expect(noteUsage(NOTE, [a, b])).toEqual(noteUsage(NOTE, [b, a]));
  });
});

/** 보관함 감시자 흉내: 테스트가 modify / rename / delete 를 쏜다. */
function fakeEvents(): UsageEvents & {
  modify(path: string): void;
  rename(path: string, oldPath: string): void;
  delete(path: string): void;
  listeners(): number;
} {
  const modify = new Set<(p: string) => void>();
  const rename = new Set<(p: string, old: string) => void>();
  const del = new Set<(p: string) => void>();
  const add = <F>(set: Set<F>, fn: F) => {
    set.add(fn);
    return () => void set.delete(fn);
  };
  return {
    onModify: (fn) => add(modify, fn),
    onRename: (fn) => add(rename, fn),
    onDelete: (fn) => add(del, fn),
    modify: (p) => modify.forEach((f) => f(p)),
    rename: (p, old) => rename.forEach((f) => f(p, old)),
    delete: (p) => del.forEach((f) => f(p)),
    listeners: () => modify.size + rename.size + del.size,
  };
}
