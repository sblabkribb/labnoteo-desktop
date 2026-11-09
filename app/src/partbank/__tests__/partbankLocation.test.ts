// @vitest-environment jsdom
/**
 * 옮겨 온 보관 위치 갱신(vendor tests/plugin/partbankLocation.test.ts 의 모든 경우와 계획 Task 22 의 이름 붙은 경우).
 * 갱신은 그릴 때마다 묻지 않고 `record.location` 에 쓴다: 샘플 트리, 검색, 표가 그대로 읽고, 마지막으로 안 위치가
 * 오프라인에서도 남는다. 네트워크는 fakeInvoke 가 맡는다.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PickItem, SampleSource } from '@labnoteo/core';
import { loadSamplesByType, upsertSampleRecord, type SampleRecord } from '@labnoteo/core/lib/sampleStorage';
import { setLang } from '../../i18n/lang';
import { t } from '../../i18n/t';
import { cancelAllRequests } from '../../integrations/netIpc';
import { secretStatusOf } from '../../integrations/__tests__/fakeNet';
import { closeAllDialogs } from '../../labnote/host/dialogStore';
import { clearCommandsForTest, commandById, commands } from '../../labnote/commands/registry';
import { registerAllCommands } from '../../labnote/commands/registerAll';
import type { AppSettings } from '../../labnote/settings';
import {
  PartbankLocationProvider,
  applyLocationChanges,
  describeChange,
  linkedSamplesIn,
  locationChangesOf,
  locationRefreshNotice,
  noStockCount,
  refreshLocationsIn,
  refreshOneLocation,
  storableChanges,
  vaultSampleFolders,
  type LocationChange,
} from '../../labnote/port/partbankLocation';
import { sampleEvents } from '../../samples/env';
import { setPartbankFeature } from '../current';
import { PB_WEB, pbEnv, type PbEnv } from './pbFixture';

const WEB = PB_WEB;
const LOCAL = 'labnote/001_Exp/resources/labsamples';
const GLOBAL = 'resources/labsamples';
const OID = (n: number) => `507f1f77bcf86cd7994390${String(n).padStart(2, '0')}`;

const source = (overrides: Partial<SampleSource> = {}): SampleSource => ({
  system: 'partbank',
  connection: 'web',
  origin: WEB,
  type: 'part',
  id: OID(11),
  kid: 'KBp_aa0001',
  ...overrides,
});

const stockPath = (id: string, type = 'part') => `/stock-box/by-resource/${type}/${id}`;
const stock = (box: string, hole: string, storage?: string) => ({
  ...(storage ? { storage: { name: storage } } : {}),
  stock_box: { name: box },
  hole_position: hole,
});

type Routes = Record<string, (args: Record<string, unknown>) => unknown>;
type Answer = unknown | ((args: Record<string, unknown>) => unknown);

/** `partbank_request` 의 경로별 답. 값이 함수면 그 함수가 답하거나 던진다. 없는 경로는 404. */
function stockRoutes(answers: Record<string, Answer>): Routes {
  return {
    partbank_request: (args) => {
      const path = String(args.path);
      if (!(path in answers)) throw { kind: 'status', message: 'raw-rust-text', status: 404 };
      const a = answers[path];
      return { status: 200, json: typeof a === 'function' ? (a as (x: Record<string, unknown>) => unknown)(args) : a };
    },
  };
}

let pb: PbEnv | undefined;
/** pickMany 가 받은 목록과 제목. */
let picked: Array<{ items: PickItem<unknown>[]; opts?: { title?: string } }> = [];

function setup(answers: Record<string, Answer> = {}, opts: { settings?: Partial<AppSettings>; routes?: Routes; pick?: (items: PickItem<unknown>[]) => unknown[] } = {}): PbEnv {
  pb?.th.cleanup();
  picked = [];
  pb = pbEnv({}, { routes: opts.routes ?? stockRoutes(answers), settings: { globalSampleFolder: GLOBAL, ...opts.settings } });
  const choose = opts.pick ?? (() => []);
  Object.assign(pb.th.host, {
    pickMany: async (items: PickItem<unknown>[], o?: { title?: string }) => {
      picked.push({ items, opts: o });
      return choose(items);
    },
  });
  return pb;
}

const env = () => pb!;
const messages = () => env().th.notes.map((n) => n.message);
const requests = () => env().calls.filter(([c]) => c === 'partbank_request');
const add = (folder: string, type: string, id: string, fields: Partial<SampleRecord> & { source?: SampleSource | null } = {}) =>
  upsertSampleRecord(env().env.fs, folder, type, id, {
    alias: fields.alias ?? null,
    description: null,
    location: fields.location ?? null,
    source: fields.source ?? null,
  });
const recordOf = async (folder: string, type: string, id: string) => (await loadSamplesByType(env().env.fs, folder, type))[id];

beforeEach(() => setLang('en'));
afterEach(() => {
  closeAllDialogs();
  pb?.th.cleanup();
  pb = undefined;
  clearCommandsForTest();
  setPartbankFeature(undefined);
});

describe('PartbankLocationProvider', () => {
  it('reads the location partbank reports', async () => {
    setup({ [stockPath(OID(11))]: { items: [stock('Box-3', 'A1', 'Freezer-2')] } });
    await expect(new PartbankLocationProvider(env().feature).fetch(source())).resolves.toBe('Freezer-2 / Box-3 / A1');
  });

  it('reads an item with no visible stock as no location', async () => {
    setup({ [stockPath(OID(11))]: { items: [] } });
    await expect(new PartbankLocationProvider(env().feature).fetch(source())).resolves.toBeNull();
  });

  // Offline, the last known location is still the best answer available.
  it('falls back to the stored location when the lookup fails', async () => {
    setup({
      [stockPath(OID(11))]: () => {
        throw { kind: 'offline', message: 'raw-rust-text' };
      },
    });
    await expect(
      new PartbankLocationProvider(env().feature).getLocation({
        type: 'DNA',
        id: 'DNA-1',
        record: { type: 'DNA', alias: null, descriptions: [], sources: [], location: 'Freezer-1', source: source() },
      }),
    ).resolves.toBe('Freezer-1');
  });

  it('leaves an unlinked sample to the local field without calling out', async () => {
    setup();
    await expect(
      new PartbankLocationProvider(env().feature).getLocation({
        type: 'DNA',
        id: 'DNA-1',
        record: { type: 'DNA', alias: null, descriptions: [], sources: [], location: 'Shelf A' },
      }),
    ).resolves.toBe('Shelf A');
    expect(requests()).toEqual([]);
  });

  // A link to a server that is not set up must not be fetched from another.
  it('refuses a link no configured connection matches', async () => {
    setup();
    await expect(new PartbankLocationProvider(env().feature).fetch(source({ origin: 'https://other.kr' }))).rejects.toMatchObject({
      kind: 'notFound',
    });
    expect(requests()).toEqual([]);
  });
});

describe('linkedSamplesIn', () => {
  it('finds the linked samples in both scopes and skips the rest', async () => {
    setup();
    await add(LOCAL, 'DNA', 'DNA-1', { alias: 'a', source: source() });
    await add(LOCAL, 'DNA', 'DNA-2', { alias: 'b' });
    await add(GLOBAL, 'Primer', 'Primer-1', { alias: 'p', source: source({ type: 'primer' }) });

    const linked = await linkedSamplesIn(env().env, [LOCAL, GLOBAL, '']);
    expect(linked.map((l) => l.id).sort()).toEqual(['DNA-1', 'Primer-1']);
    expect(linked.find((l) => l.id === 'Primer-1')?.folder).toBe(GLOBAL);
  });
});

// #437: the bulk refresh reads every experiment, whichever note is open.
describe('vaultSampleFolders', () => {
  it('lists every experiment registry, then the Global one once', async () => {
    const other = 'labnote/002_Other/resources/labsamples';
    setup();
    await add(LOCAL, 'DNA', 'DNA-1', { alias: 'a' });
    await add(other, 'DNA', 'DNA-2', { alias: 'b' });
    expect(await vaultSampleFolders(env().env)).toEqual([LOCAL, other, GLOBAL]);

    // An experiment registry set as Global (#408) is read once.
    await env().th.ctx.updateSettings({ globalSampleFolder: other });
    expect(await vaultSampleFolders(env().env)).toEqual([LOCAL, other]);
  });
});

describe('locationChangesOf / storableChanges', () => {
  const row = (before: string | null, after: string | null): LocationChange => ({
    type: 'DNA',
    id: 'DNA-1',
    alias: 'a',
    folder: LOCAL,
    before,
    after,
  });

  it('keeps only the rows whose text actually differs', () => {
    expect(locationChangesOf([row('A', 'A'), row(null, ''), row('A', 'B'), row(null, 'C')])).toHaveLength(2);
  });

  // #294: partbank showing no stock is often a sharing boundary, not a move.
  it('leaves out a change that would empty the location', () => {
    expect(storableChanges([row('A', 'B'), row('A', null), row('A', '')]).offer).toEqual([row('A', 'B')]);
  });

  it('never empties a location (#294)', () => {
    expect(storableChanges([{ before: 'F1', after: null } as never]).offer).toEqual([]);
  });

  // #552: a sample with no location stored and none to read is no change.
  it('counts every sample with no stock, including one that was never located', () => {
    expect(noStockCount([row('A', 'B'), row('A', null), row(null, null), row(null, 'C')])).toBe(2);
  });

  it('adds the kept and unread counts to every closing notice', () => {
    setup();
    expect(locationRefreshNotice(env().env, 'Done.', 0, 0)).toBe('Done.');
    expect(locationRefreshNotice(env().env, 'Done.', 2, 1)).toBe(
      'Done. 2 sample(s) with no stock in partbank keep their current location. 1 sample(s) could not be read from partbank.',
    );
  });

  it('describeChange shows (none) for an empty side', () => {
    setup();
    expect(describeChange(row(null, 'Box-1 / A1'), env().env)).toBe('(none) → Box-1 / A1');
    expect(describeChange(row('Box-1 / A1', ''), env().env)).toBe('Box-1 / A1 → (none)');
    setLang('ko');
    expect(describeChange(row(null, 'B'), env().env)).not.toContain('(none)');
  });
});

describe('applyLocationChanges', () => {
  it('writes the new location and leaves the rest of the record alone', async () => {
    setup();
    await upsertSampleRecord(env().env.fs, LOCAL, 'DNA', 'DNA-1', { alias: 'gfp', description: 'KBp_aa0001', source: source() });
    const emitted: Array<readonly string[] | undefined> = [];
    const off = sampleEvents.subscribe((p) => emitted.push(p));
    await applyLocationChanges(env().env, [
      { type: 'DNA', id: 'DNA-1', alias: 'gfp', folder: LOCAL, before: null, after: 'Freezer-2 / Box-3 / A1' },
    ]);
    off();

    const rec = await recordOf(LOCAL, 'DNA', 'DNA-1');
    expect(rec.location).toBe('Freezer-2 / Box-3 / A1');
    expect(rec.alias).toBe('gfp');
    expect(rec.descriptions).toEqual(['KBp_aa0001']);
    // Losing the link here would make the next refresh impossible.
    expect(rec.source).toEqual(source());
    expect(emitted).toEqual([[`${LOCAL}/DNA.json`]]);
  });

  it('skips a sample that is gone and writes nothing for an empty list', async () => {
    setup();
    const emitted: unknown[] = [];
    const off = sampleEvents.subscribe((p) => emitted.push(p));
    await applyLocationChanges(env().env, [{ type: 'DNA', id: 'DNA-9', alias: null, folder: LOCAL, before: null, after: 'X' }]);
    await applyLocationChanges(env().env, []);
    off();
    expect(await loadSamplesByType(env().env.fs, LOCAL, 'DNA')).toEqual({});
    expect(emitted).toEqual([]);
  });
});

// #269: one Enter on "store (none)?" used to erase a hand-typed location.
describe('refreshOneLocation', () => {
  const ref = async (id: string, type = 'DNA', folder = LOCAL) => ({ type, id, folder, record: await recordOf(folder, type, id) });

  it('keeps the stored location without asking when partbank shows no stock', async () => {
    setup({ [stockPath(OID(11))]: { items: [] } });
    await add(LOCAL, 'DNA', 'DNA-1', { alias: 'gfp', location: '4도 냉장고 B칸', source: source() });

    await expect(refreshOneLocation(env().env, env().feature, await ref('DNA-1'))).resolves.toBe(false);

    expect((await recordOf(LOCAL, 'DNA', 'DNA-1')).location).toBe('4도 냉장고 B칸');
    expect(env().th.asked.confirm).toEqual([]);
    expect(messages()).toEqual([
      'partbank shows no stock for DNA-1, so the current location is kept. To clear it, empty the location in Edit sample.',
    ]);
  });

  // #552: with no location stored either, "no stock" read as "unchanged".
  it('says there is nothing to read for a sample that has no location stored', async () => {
    setup({ [stockPath(OID(12))]: { items: [] } });
    await add(LOCAL, 'DNA', 'DNA-2', { alias: 'rfp', source: source({ id: OID(12) }) });

    await expect(refreshOneLocation(env().env, env().feature, await ref('DNA-2'))).resolves.toBe(false);

    expect(messages()).toEqual([
      'partbank has no stock for DNA-2, so there is no storage location to read. Register the stock in partbank, then refresh again.',
    ]);
  });

  it('says the location is unchanged when partbank reads back the one stored', async () => {
    setup({ [stockPath(OID(13))]: { items: [{ is_owner: true, ...stock('Box-1', 'A1') }] } });
    await add(LOCAL, 'DNA', 'DNA-3', { alias: 'cfp', location: 'Box-1 / A1', source: source({ id: OID(13) }) });

    await expect(refreshOneLocation(env().env, env().feature, await ref('DNA-3'))).resolves.toBe(false);

    expect(messages()).toEqual(['The storage location is unchanged.']);
  });

  it('asks with Store and writes the new location on yes', async () => {
    setup({ [stockPath(OID(11))]: { items: [stock('Box-3', 'A1', 'Freezer-2')] } });
    await add(LOCAL, 'DNA', 'DNA-1', { alias: 'gfp', location: 'Box-1 / B2', source: source() });
    env().th.answer.confirm(true);

    await expect(refreshOneLocation(env().env, env().feature, await ref('DNA-1'))).resolves.toBe(true);

    expect(env().th.asked.confirm).toEqual([
      {
        message: 'Store the storage location of DNA-1 as read from partbank?\nBox-1 / B2 → Freezer-2 / Box-3 / A1',
        opts: { confirmLabel: 'Store' },
      },
    ]);
    expect((await recordOf(LOCAL, 'DNA', 'DNA-1')).location).toBe('Freezer-2 / Box-3 / A1');
  });

  it('writes nothing when the confirmation is declined', async () => {
    setup({ [stockPath(OID(11))]: { items: [stock('Box-3', 'A1')] } });
    await add(LOCAL, 'DNA', 'DNA-1', { location: 'Box-1 / B2', source: source() });
    env().th.answer.confirm(false);

    await expect(refreshOneLocation(env().env, env().feature, await ref('DNA-1'))).resolves.toBe(false);
    expect((await recordOf(LOCAL, 'DNA', 'DNA-1')).location).toBe('Box-1 / B2');
  });

  it('says an unlinked sample is not linked and calls nothing', async () => {
    setup();
    await add(LOCAL, 'DNA', 'DNA-1', { location: 'Box-1' });
    await expect(refreshOneLocation(env().env, env().feature, await ref('DNA-1'))).resolves.toBe(false);
    expect(messages()).toEqual(['This sample is not linked to partbank.']);
    expect(requests()).toEqual([]);
  });

  it('a lookup failure is told in partbank terms, never as raw Rust text', async () => {
    setup({
      [stockPath(OID(11))]: () => {
        throw { kind: 'status', message: 'raw-rust-text', status: 401 };
      },
    });
    await add(LOCAL, 'DNA', 'DNA-1', { location: 'Box-1', source: source() });
    await expect(refreshOneLocation(env().env, env().feature, await ref('DNA-1'))).resolves.toBe(false);
    expect(env().th.notes).toHaveLength(1);
    expect(env().th.notes[0].kind).toBe('error');
    expect(env().th.notes[0].message).toContain('API key was refused');
    expect(messages().join(' ')).not.toContain('raw-rust-text');
  });

  it('a vault switch before the write stores nothing', async () => {
    let root = 'C:/vaults/lab';
    setup(
      {},
      {
        routes: {
          ...stockRoutes({ [stockPath(OID(11))]: { items: [stock('Box-3', 'A1')] } }),
          vault_current: () => ({ root }),
        },
      },
    );
    await add(LOCAL, 'DNA', 'DNA-1', { location: 'Box-1 / B2', source: source() });
    env().th.answer.confirm(() => {
      root = 'C:/vaults/other';
      return true;
    });

    await expect(refreshOneLocation(env().env, env().feature, await ref('DNA-1'))).resolves.toBe(false);
    expect((await recordOf(LOCAL, 'DNA', 'DNA-1')).location).toBe('Box-1 / B2');
    expect(env().th.notes.filter((n) => n.kind === 'error')).toEqual([]);
  });
});

describe('refreshLocationsIn', () => {
  it('keeps locations partbank would empty without listing them, and says so (#294)', async () => {
    setup({ [stockPath(OID(11))]: { items: [] } });
    await add(LOCAL, 'DNA', 'DNA-1', { alias: 'gfp', location: '4도 냉장고 B칸', source: source() });

    await refreshLocationsIn(env().env, env().feature, [LOCAL]);

    expect((await recordOf(LOCAL, 'DNA', 'DNA-1')).location).toBe('4도 냉장고 B칸');
    expect(picked).toEqual([]);
    expect(messages()).toEqual([
      'Checked 1 linked sample(s); no storage location changed. 1 sample(s) with no stock in partbank keep their current location.',
    ]);
  });

  it('says so when no sample is linked, and calls nothing', async () => {
    setup();
    await add(LOCAL, 'DNA', 'DNA-1', { location: 'Box-1' });
    await refreshLocationsIn(env().env, env().feature, [LOCAL, GLOBAL]);
    expect(messages()).toEqual(['No sample in this vault is linked to partbank.']);
    expect(requests()).toEqual([]);
  });

  it('skips discarded samples', async () => {
    setup({ [stockPath(OID(11))]: { items: [stock('Box-3', 'A1')] }, [stockPath(OID(12))]: { items: [stock('Box-9', 'H9')] } });
    await add(LOCAL, 'DNA', 'DNA-1', { location: 'Box-1', source: source() });
    await add(LOCAL, 'DNA', 'DNA-2', { location: 'Box-2', source: source({ id: OID(12) }) });
    await env().env.fs.modify(`${LOCAL}/DNA.json`, (raw) => {
      const records = JSON.parse(raw) as Record<string, SampleRecord>;
      records['DNA-2'] = { ...records['DNA-2'], discarded: '2026-11-01' };
      return JSON.stringify(records, null, 2);
    });

    await refreshLocationsIn(env().env, env().feature, [LOCAL]);

    expect(requests().map(([, a]) => a.path)).toEqual([stockPath(OID(11))]);
    expect(picked).toHaveLength(1);
    expect(picked[0].items.map((i) => i.label)).toEqual(['DNA-1']);
    expect((await recordOf(LOCAL, 'DNA', 'DNA-2')).location).toBe('Box-2');
  });

  it('offers the changes in pickMany and writes only the chosen ones', async () => {
    setup(
      {
        [stockPath(OID(11))]: { items: [stock('Box-3', 'A1', 'Freezer-2')] },
        [stockPath(OID(12))]: { items: [stock('Box-9', 'H9')] },
        [stockPath(OID(13))]: { items: [stock('Box-1', 'A1')] },
      },
      { pick: (items) => items.filter((i) => i.label.startsWith('DNA-1')).map((i) => i.value) },
    );
    await add(LOCAL, 'DNA', 'DNA-1', { alias: 'gfp', location: 'Box-1 / B2', source: source() });
    await add(GLOBAL, 'DNA', 'DNA-2', { location: null, source: source({ id: OID(12) }) });
    await add(LOCAL, 'DNA', 'DNA-3', { location: 'Box-1 / A1', source: source({ id: OID(13) }) });

    await refreshLocationsIn(env().env, env().feature, [LOCAL, GLOBAL]);

    expect(picked).toHaveLength(1);
    expect(picked[0].opts?.title).toBe('Storage locations to store (2 changed)');
    expect(picked[0].items.map((i) => [i.label, i.description, i.checked])).toEqual([
      ['DNA-1;gfp', 'Box-1 / B2 → Freezer-2 / Box-3 / A1 · 001_Exp', true],
      ['DNA-2', '(none) → Box-9 / H9 · Global', true],
    ]);
    expect((await recordOf(LOCAL, 'DNA', 'DNA-1')).location).toBe('Freezer-2 / Box-3 / A1');
    expect((await recordOf(GLOBAL, 'DNA', 'DNA-2')).location).toBeNull();
    expect(messages()).toEqual(['Stored 1 storage location(s).']);
  });

  it('says nothing was stored when no change is picked', async () => {
    setup({ [stockPath(OID(11))]: { items: [stock('Box-3', 'A1')] } });
    await add(LOCAL, 'DNA', 'DNA-1', { location: 'Box-1', source: source() });
    await refreshLocationsIn(env().env, env().feature, [LOCAL]);
    expect((await recordOf(LOCAL, 'DNA', 'DNA-1')).location).toBe('Box-1');
    expect(messages()).toEqual(['No storage location was stored.']);
  });

  it('stops on 429 and reports the rest as failed', async () => {
    setup(
      {
        [stockPath(OID(11))]: { items: [stock('Box-3', 'A1')] },
        [stockPath(OID(12))]: () => {
          throw { kind: 'status', message: 'raw-rust-text', status: 429 };
        },
        [stockPath(OID(13))]: { items: [stock('Box-7', 'C3')] },
      },
      { pick: (items) => items.map((i) => i.value) },
    );
    await add(LOCAL, 'DNA', 'DNA-1', { location: 'Box-1', source: source() });
    await add(LOCAL, 'DNA', 'DNA-2', { location: 'Box-2', source: source({ id: OID(12) }) });
    await add(LOCAL, 'DNA', 'DNA-3', { location: 'Box-3', source: source({ id: OID(13) }) });

    await refreshLocationsIn(env().env, env().feature, [LOCAL]);

    // the third sample is never asked for once partbank refuses
    expect(requests().map(([, a]) => a.path)).toEqual([stockPath(OID(11)), stockPath(OID(12))]);
    // what was read before the refusal is still offered and stored
    expect(picked[0].items.map((i) => i.label)).toEqual(['DNA-1']);
    expect((await recordOf(LOCAL, 'DNA', 'DNA-1')).location).toBe('Box-3 / A1');
    expect((await recordOf(LOCAL, 'DNA', 'DNA-3')).location).toBe('Box-3');
    expect(env().th.notes).toEqual([
      { kind: 'error', message: 'partbank is refusing further requests for now. Try again in a minute.' },
      { kind: 'info', message: 'Stored 1 storage location(s). 2 sample(s) could not be read from partbank.' },
    ]);
  });

  it('one unreadable item does not end the run', async () => {
    setup(
      {
        [stockPath(OID(11))]: () => {
          throw { kind: 'status', message: 'raw-rust-text', status: 404 };
        },
        [stockPath(OID(12))]: { items: [stock('Box-9', 'H9')] },
      },
      { pick: (items) => items.map((i) => i.value) },
    );
    await add(LOCAL, 'DNA', 'DNA-1', { location: 'Box-1', source: source() });
    await add(LOCAL, 'DNA', 'DNA-2', { location: 'Box-2', source: source({ id: OID(12) }) });

    await refreshLocationsIn(env().env, env().feature, [LOCAL]);

    expect((await recordOf(LOCAL, 'DNA', 'DNA-2')).location).toBe('Box-9 / H9');
    expect(messages()).toEqual(['Stored 1 storage location(s). 1 sample(s) could not be read from partbank.']);
  });

  it('cancel stops the run and writes nothing', async () => {
    let started!: () => void;
    const begun = new Promise<void>((r) => (started = r));
    let answer!: (v: unknown) => void;
    const later = new Promise<unknown>((r) => (answer = r));
    setup(
      {},
      {
        routes: {
          partbank_request: (args) => {
            if (String(args.path) === stockPath(OID(11))) {
              started();
              return later;
            }
            return { status: 200, json: { items: [stock('Box-9', 'H9')] } };
          },
        },
        pick: (items) => items.map((i) => i.value),
      },
    );
    await add(LOCAL, 'DNA', 'DNA-1', { location: 'Box-1', source: source() });
    await add(LOCAL, 'DNA', 'DNA-2', { location: 'Box-2', source: source({ id: OID(12) }) });

    const done = refreshLocationsIn(env().env, env().feature, [LOCAL]);
    await begun;
    // 진행 창의 취소(단추, Escape)는 창을 닫는다. closeAllDialogs 도 같은 길로 신호를 끊는다
    closeAllDialogs();
    await done;
    answer({ status: 200, json: { items: [stock('Box-3', 'A1')] } });
    await new Promise((r) => setTimeout(r, 0));

    expect(requests()).toHaveLength(1);
    expect(picked).toEqual([]);
    expect((await recordOf(LOCAL, 'DNA', 'DNA-1')).location).toBe('Box-1');
    expect(env().th.notes).toEqual([]);
  });

  it('a vault switch while reading writes nothing', async () => {
    let started!: () => void;
    const begun = new Promise<void>((r) => (started = r));
    let answer!: (v: unknown) => void;
    const later = new Promise<unknown>((r) => (answer = r));
    setup(
      {},
      {
        routes: {
          partbank_request: () => {
            started();
            return later;
          },
        },
        pick: (items) => items.map((i) => i.value),
      },
    );
    await add(LOCAL, 'DNA', 'DNA-1', { location: 'Box-1', source: source() });

    const done = refreshLocationsIn(env().env, env().feature, [LOCAL]);
    await begun;
    await cancelAllRequests(env().invoke);
    answer({ status: 200, json: { items: [stock('Box-3', 'A1')] } });
    await done;

    expect(picked).toEqual([]);
    expect((await recordOf(LOCAL, 'DNA', 'DNA-1')).location).toBe('Box-1');
    expect(env().th.notes.filter((n) => n.kind === 'error')).toEqual([]);
  });

  it('a vault root that changed before the write stores nothing', async () => {
    let root = 'C:/vaults/lab';
    setup(
      {},
      {
        routes: {
          ...stockRoutes({ [stockPath(OID(11))]: { items: [stock('Box-3', 'A1')] } }),
          vault_current: () => ({ root }),
        },
        pick: (items) => {
          root = 'C:/vaults/other';
          return items.map((i) => i.value);
        },
      },
    );
    await add(LOCAL, 'DNA', 'DNA-1', { location: 'Box-1', source: source() });

    await refreshLocationsIn(env().env, env().feature, [LOCAL]);

    expect((await recordOf(LOCAL, 'DNA', 'DNA-1')).location).toBe('Box-1');
    expect(messages()).toEqual([]);
  });
});

describe('refresh-partbank-locations', () => {
  it('is registered once and hidden when not configured', () => {
    registerAllCommands();
    expect(commands().filter((c) => c.id === 'refresh-partbank-locations')).toHaveLength(1);
    const cmd = commandById('refresh-partbank-locations')!;
    expect(cmd.nameKey).toBe('Refresh storage locations from partbank');
    setup();
    setPartbankFeature(undefined);
    expect(cmd.available?.(env().th.ctx)).toBe(false);
    const unconfigured = pbEnv({}, { status: secretStatusOf({}) });
    setPartbankFeature(unconfigured.feature);
    expect(cmd.available?.(env().th.ctx)).toBe(false);
    unconfigured.th.cleanup();
    setPartbankFeature(env().feature);
    expect(cmd.available?.(env().th.ctx)).toBe(true);
  });

  it('refreshes every experiment and the Global registry, whichever note is open', async () => {
    registerAllCommands();
    const other = 'labnote/002_Other/resources/labsamples';
    setup(
      {
        [stockPath(OID(11))]: { items: [stock('Box-3', 'A1')] },
        [stockPath(OID(12))]: { items: [stock('Box-4', 'B1')] },
        [stockPath(OID(13))]: { items: [stock('Box-5', 'C1')] },
      },
      { pick: (items) => items.map((i) => i.value) },
    );
    await add(LOCAL, 'DNA', 'DNA-1', { source: source() });
    await add(other, 'DNA', 'DNA-2', { source: source({ id: OID(12) }) });
    await add(GLOBAL, 'DNA', 'DNA-3', { source: source({ id: OID(13) }) });
    setPartbankFeature(env().feature);

    await commandById('refresh-partbank-locations')!.run(env().th.ctx);

    expect((await recordOf(LOCAL, 'DNA', 'DNA-1')).location).toBe('Box-3 / A1');
    expect((await recordOf(other, 'DNA', 'DNA-2')).location).toBe('Box-4 / B1');
    expect((await recordOf(GLOBAL, 'DNA', 'DNA-3')).location).toBe('Box-5 / C1');
    expect(messages()).toEqual(['Stored 3 storage location(s).']);
  });

  it('without a feature the command says to set up a connection', async () => {
    registerAllCommands();
    setup();
    setPartbankFeature(undefined);
    await commandById('refresh-partbank-locations')!.run(env().th.ctx);
    expect(messages()).toEqual([t('partbank.setupFirst')]);
  });
});
