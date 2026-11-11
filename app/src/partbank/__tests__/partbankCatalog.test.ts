// @vitest-environment jsdom
/**
 * 옮겨 온 카탈로그 내려받기(vendor tests/plugin/partbankCatalog.test.ts 의 모든 경우와 계획 Task 21 의 이름 붙은 경우).
 * 내려받기는 `{Type}_partbank-*.json` 을 통째로 다시 쓴다: 지킬 것은 항목이 이미 가진 ID 를 그대로 갖는 것이다.
 * 앱에서는 그 파일이 보관함이 아니라 앱 데이터(카탈로그 저장소)에 쓰인다(D13). 네트워크는 fakeInvoke 가 맡는다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PartbankItem, SampleSource } from '@labnoteo/core';
import { upsertSampleRecord, type SampleRecord } from '@labnoteo/core/lib/sampleStorage';
import { setLang } from '../../i18n/lang';
import { t } from '../../i18n/t';
import { cancelAllRequests } from '../../integrations/netIpc';
import { secretStatusOf } from '../../integrations/__tests__/fakeNet';
import { closeAllDialogs } from '../../labnote/host/dialogStore';
import { clearCommandsForTest, commandById, commands } from '../../labnote/commands/registry';
import { registerAllCommands } from '../../labnote/commands/registerAll';
import type { AppSettings } from '../../labnote/settings';
import {
  catalogFileName,
  downloadPartbankCatalog,
  heldByOtherTypes,
  itemSourceKey,
  planCatalogFile,
} from '../../labnote/port/partbankCatalog';
import type { PartbankCatalogStore } from '../catalogOverlay';
import { setPartbankFeature } from '../current';
import { LIST_PAGE_SIZE } from '../../labnote/port/partbankClient';
import { PB_WEB, pbEnv, type PbEnv } from './pbFixture';

const WEB = PB_WEB;
const GLOBAL = 'resources/labsamples';

const item = (kid: string, name: string, id = kid.toLowerCase()): PartbankItem => ({
  type: 'part',
  id,
  kid,
  name,
  description: null,
  moleculeType: null,
});

/** The key `planCatalogFile` looks ids up by, built the same way it does. */
const key = (source: SampleSource): string =>
  `${source.connection === 'desktop' ? 'desktop' : source.origin.toLowerCase()}\u0000${source.type}\u0000${source.id}`;

const webKey = (id: string, type = 'part'): string => `${WEB.toLowerCase()}\u0000${type}\u0000${id}`;

/** Deterministic ids, so a test can tell a reused id from a fresh one. */
function idFactory(): (type: string) => string {
  let n = 0;
  return (type) => `${type}-new${++n}`;
}

describe('catalogFileName', () => {
  it('names one file per type and connection', () => {
    expect(catalogFileName('DNA', 'web')).toBe('DNA_partbank-web.json');
    expect(catalogFileName('Plasmid', 'desktop')).toBe('Plasmid_partbank-desktop.json');
  });
});

describe('planCatalogFile', () => {
  it('writes the items in KID order', () => {
    const records = planCatalogFile(
      'DNA',
      [item('KBp_cc0003', 'C'), item('KBp_aa0001', 'A'), item('KBp_bb0002', 'B')],
      'web',
      WEB,
      new Map(),
      idFactory(),
    );
    expect(Object.values(records).map((r) => r.source?.kid)).toEqual(['KBp_aa0001', 'KBp_bb0002', 'KBp_cc0003']);
  });

  it('keeps the id an item already had and generates one only for the rest', () => {
    const known = new Map([[webKey('kbp_aa0001'), 'DNA-1760000000000']]);
    const records = planCatalogFile('DNA', [item('KBp_aa0001', 'A'), item('KBp_bb0002', 'B')], 'web', WEB, known, idFactory());
    expect(Object.keys(records)).toEqual(['DNA-1760000000000', 'DNA-new1']);
  });

  it('stores the link, so the next download finds the item again', () => {
    const records = planCatalogFile('DNA', [item('KBp_aa0001', 'A')], 'web', `${WEB}/`, new Map(), idFactory());
    const source = Object.values(records)[0].source!;
    expect(source).toEqual({ system: 'partbank', connection: 'web', origin: WEB, type: 'part', id: 'kbp_aa0001', kid: 'KBp_aa0001' });
    expect(key(source)).toBe(webKey('kbp_aa0001'));
  });

  it('rewrites the name into a usable alias and leads the description with the KID', () => {
    const records = planCatalogFile(
      'Plasmid',
      [{ type: 'plasmid', id: 'x', kid: 'KBvt_aa0001', name: 'pTrc99A_GFP', description: 'green' }],
      'web',
      WEB,
      new Map(),
      idFactory(),
    );
    const record = Object.values(records)[0];
    expect(record.alias).toBe('pTrc99A-GFP');
    expect(record.descriptions).toEqual(['KBvt_aa0001 · pTrc99A_GFP · green']);
    expect(record.type).toBe('Plasmid');
    expect(record.location).toBeNull();
    expect(record.sources).toEqual([]);
  });

  it('appends the KID to an alias two items share, and leaves unique ones alone', () => {
    const records = planCatalogFile(
      'DNA',
      [item('KBp_aa0001', 'GFP'), item('KBp_bb0002', 'GFP'), item('KBp_cc0003', 'RFP')],
      'web',
      WEB,
      new Map(),
      idFactory(),
    );
    expect(Object.values(records).map((r) => r.alias)).toEqual(['GFP (KBp-aa0001)', 'GFP (KBp-bb0002)', 'RFP']);
  });

  it('is empty for a type with no items', () => {
    expect(planCatalogFile('DNA', [], 'web', WEB, new Map(), idFactory())).toEqual({});
  });

  it('matches a desktop item whatever port it was downloaded through', () => {
    const known = new Map([['desktop\u0000part\u0000kbp_aa0001', 'DNA-1']]);
    const records = planCatalogFile('DNA', [item('KBp_aa0001', 'A')], 'desktop', 'http://127.0.0.1:47999', known, idFactory());
    expect(Object.keys(records)).toEqual(['DNA-1']);
  });
});

describe('heldByOtherTypes', () => {
  const source = (id: string): SampleSource => ({ system: 'partbank', connection: 'web', origin: WEB, type: 'part', id, kid: null });
  const rec = (id: string) => ({ type: 'x', alias: null, descriptions: [], sources: [], location: null, source: source(id) });

  it('lists the items a Global sample of another type stands for', () => {
    const globals = new Map<string, Record<string, SampleRecord>>([
      ['DNA', { 'DNA-1': rec('a1') }],
      ['Plasmid', { 'Plasmid-1': rec('b1') }],
      ['Other', { 'Other-1': { ...rec('x'), source: null } }],
    ]);
    const held = heldByOtherTypes(globals, 'Plasmid');
    expect(held.has(itemSourceKey(item('KBp_A', 'A', 'a1'), 'web', WEB))).toBe(true);
    expect(held.has(itemSourceKey(item('KBp_B', 'B', 'b1'), 'web', WEB))).toBe(false);
    expect(held.size).toBe(1);
  });
});

// ── 내려받기 흐름 ────────────────────────────────────────────────

const OID = (n: number) => `507f1f77bcf86cd7994390${String(n).padStart(2, '0')}`;
const row = (n: number, kid: string, name: string) => ({ id: OID(n), kid, name });

/** 메모리 위의 카탈로그 저장소. write 는 기록된다. */
function memoryStore(files: Record<string, string> = {}): PartbankCatalogStore & { files: Record<string, string>; writes: string[] } {
  const subs = new Set<() => void>();
  const writes: string[] = [];
  return {
    files,
    writes,
    names: async () => Object.keys(files),
    read: async (n) => files[n],
    async write(n, c) {
      writes.push(n);
      files[n] = c;
      for (const s of [...subs]) s();
    },
    subscribe(fn) {
      subs.add(fn);
      return () => void subs.delete(fn);
    },
  };
}

type Segment = 'parts' | 'devices' | 'plasmids' | 'primers' | 'molecules' | 'strains';
type Lists = Partial<Record<Segment, unknown[]>>;
type Routes = Record<string, (args: Record<string, unknown>) => unknown>;

/** `/workspace/<segment>` 마다 한 쪽짜리 목록. 없는 종류는 빈 목록. `pending` 의 경로는 답하지 않고 기다린다. */
function workspaceRoutes(lists: Lists, pending?: { path: string; started: () => void; answer: Promise<unknown> }): Routes {
  return {
    partbank_request: (args) => {
      const path = String(args.path);
      if (pending && path === pending.path) {
        pending.started();
        return pending.answer;
      }
      const m = /^\/workspace\/(\w+)$/.exec(path);
      if (!m) throw { kind: 'status', message: 'raw-rust-text', status: 404 };
      const items = lists[m[1] as Segment] ?? [];
      return { status: 200, json: { items, total: items.length } };
    },
  };
}

/** 답하지 않고 기다리는 경로 하나: 요청이 닿으면 `begun` 이 풀리고, `answer` 로 나중에 답한다. */
function pendingAt(path: string) {
  let started!: () => void;
  const begun = new Promise<void>((r) => (started = r));
  let answer!: (v: unknown) => void;
  const later = new Promise<unknown>((r) => (answer = r));
  return { begun, answer, spec: { path, started, answer: later } };
}

let pb: PbEnv | undefined;
let store: ReturnType<typeof memoryStore>;

function setup(lists: Lists, opts: { settings?: Partial<AppSettings>; routes?: Routes } = {}): PbEnv {
  pb?.th.cleanup();
  store = memoryStore();
  pb = pbEnv(
    {},
    {
      catalogs: store,
      routes: opts.routes ?? workspaceRoutes(lists),
      settings: { globalSampleFolder: GLOBAL, ...opts.settings },
    },
  );
  return pb;
}

const env = () => pb!;
const run = () => downloadPartbankCatalog(env().env, env().feature, store);
const messages = () => env().th.notes.map((n) => n.message);
const catalog = (name: string): Record<string, SampleRecord> => JSON.parse(store.files[name]) as Record<string, SampleRecord>;
const requests = () => env().calls.filter(([c]) => c === 'partbank_request').length;
const vaultCatalogWrites = () =>
  env().th.vault.log.filter((l) => /^vault_(write|modify)$/.test(l.cmd) && /_partbank-/.test(String(l.args.path)));
const linked = (n: number, kid: string): SampleSource => ({
  system: 'partbank',
  connection: 'web',
  origin: WEB,
  type: 'part',
  id: OID(n),
  kid,
});

beforeEach(() => setLang('en'));
afterEach(() => {
  closeAllDialogs();
  pb?.th.cleanup();
  pb = undefined;
  clearCommandsForTest();
  setPartbankFeature(undefined);
});

describe('downloadPartbankCatalog', () => {
  it('writes through the store, never the vault fs', async () => {
    setup({ plasmids: [row(1, 'KBvt_aa0001', 'pTrc99A_GFP')] });
    await run();
    expect(store.writes).toEqual(['Plasmid_partbank-web.json']);
    expect(vaultCatalogWrites()).toEqual([]);
    expect(Object.keys(env().th.vault.files()).some((p) => p.includes('_partbank-'))).toBe(false);
    expect(Object.values(catalog('Plasmid_partbank-web.json')).map((r) => r.alias)).toEqual(['pTrc99A-GFP']);
    expect(messages()).toEqual(['Downloaded the partbank catalog: Plasmid 1.']);
  });

  it('ids stay stable across two downloads', async () => {
    setup({ parts: [row(1, 'KBp_aa0001', 'A'), row(2, 'KBp_bb0002', 'B')] });
    await run();
    const first = Object.keys(catalog('DNA_partbank-web.json'));
    expect(first).toHaveLength(2);
    await run();
    expect(Object.keys(catalog('DNA_partbank-web.json'))).toEqual(first);
  });

  it('keeps the id a Global sample already has for the item', async () => {
    setup({ parts: [row(1, 'KBp_aa0001', 'A')] });
    await upsertSampleRecord(env().env.fs, GLOBAL, 'DNA', 'DNA-1700000000000', {
      alias: 'A',
      description: null,
      location: null,
      source: linked(1, 'KBp_aa0001'),
    });
    await run();
    expect(Object.keys(catalog('DNA_partbank-web.json'))).toEqual(['DNA-1700000000000']);
  });

  it('leaves out an item a Global sample of another type stands for', async () => {
    setup({ parts: [row(1, 'KBp_aa0001', 'A'), row(2, 'KBp_bb0002', 'B')] });
    await upsertSampleRecord(env().env.fs, GLOBAL, 'Plasmid', 'Plasmid-1', {
      alias: 'A',
      description: null,
      location: null,
      source: linked(1, 'KBp_aa0001'),
    });
    await run();
    expect(Object.values(catalog('DNA_partbank-web.json')).map((r) => r.source?.kid)).toEqual(['KBp_bb0002']);
  });

  it('adds the KID to aliases that occur more than once', async () => {
    setup({ parts: [row(1, 'KBp_aa0001', 'GFP'), row(2, 'KBp_bb0002', 'GFP'), row(3, 'KBp_cc0003', 'RFP')] });
    await run();
    expect(Object.values(catalog('DNA_partbank-web.json')).map((r) => r.alias)).toEqual([
      'GFP (KBp-aa0001)',
      'GFP (KBp-bb0002)',
      'RFP',
    ]);
  });

  it('counts left-out strains in the notice', async () => {
    setup({ parts: [row(1, 'KBp_aa0001', 'A')], strains: [row(2, 'KBs_aa0001', 'E. coli'), row(3, 'KBs_bb0002', 'B. subtilis')] });
    env().th.answer.confirm(false);
    await run();
    // 균주 종류를 더할지는 첫 균주에서 한 번만 묻는다
    expect(env().th.asked.confirm).toHaveLength(1);
    expect(store.writes).toEqual(['DNA_partbank-web.json']);
    expect(messages()).toEqual(['Downloaded the partbank catalog: DNA 1. 2 strain(s) were left out.']);
  });

  it('adds the strain type once when the user agrees, and catalogs the strains', async () => {
    setup({ strains: [row(2, 'KBs_aa0001', 'E. coli'), row(3, 'KBs_bb0002', 'B. subtilis')] });
    env().th.answer.confirm(true);
    await run();
    expect(env().th.asked.confirm).toHaveLength(1);
    expect(env().env.settings().customSampleTypes).toContain('Strain');
    expect(Object.keys(catalog('Strain_partbank-web.json'))).toHaveLength(2);
  });

  it('an empty own workspace is said as such, not as a failure (shared and public items are not downloaded)', async () => {
    // real-server check: an account with an empty own workspace saw only "partbank returned nothing".
    setup({});
    await run();
    expect(store.writes).toEqual([]);
    expect(messages()).toEqual([t('partbank.catalogEmptyWorkspace')]);
    expect(messages()[0]).toMatch(/own workspace is empty/);
  });

  it('says partbank returned nothing when items were listed but none went into a catalog', async () => {
    setup({ strains: [row(2, 'KBs_aa0001', 'E. coli')] });
    env().th.answer.confirm(false);
    await run();
    expect(store.writes).toEqual([]);
    expect(messages()).toEqual(['partbank returned nothing to put in a catalog.']);
  });

  it('cancel stops listing and writes nothing', async () => {
    const p = pendingAt('/workspace/devices');
    setup({}, { routes: workspaceRoutes({ parts: [row(1, 'KBp_aa0001', 'A')] }, p.spec) });
    const done = run();
    await p.begun;
    // 진행 창의 취소(단추, Escape)는 창을 닫는다. closeAllDialogs 도 같은 길로 신호를 끊는다
    closeAllDialogs();
    await done;
    const before = requests();
    p.answer({ status: 200, json: { items: [row(5, 'KBp_dd0005', 'D')], total: 1 } });
    await new Promise((r) => setTimeout(r, 0));
    expect(requests()).toBe(before);
    expect(store.writes).toEqual([]);
    // 사용자가 취소했으므로 오류를 띄우지 않고, 날 Rust 글도 보이지 않는다
    expect(env().th.notes.filter((n) => n.kind === 'error')).toEqual([]);
    expect(messages().join(' ')).not.toContain('raw-rust-text');
  });

  it('cancel during a full page asks for no further pages', async () => {
    const p = pendingAt('/workspace/parts');
    setup({}, { routes: workspaceRoutes({}, p.spec) });
    const done = run();
    await p.begun;
    closeAllDialogs();
    await done;
    const before = requests();
    // 꽉 찬 쪽(LIST_PAGE_SIZE)과 더 큰 total: 신호를 보지 않으면 다음 쪽을 계속 청한다
    const full = Array.from({ length: LIST_PAGE_SIZE }, (_, i) => row(i % 100, `KBp_${String(i).padStart(6, '0')}`, `P${i}`));
    p.answer({ status: 200, json: { items: full, total: 1000 } });
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
    expect(requests()).toBe(before);
    expect(store.writes).toEqual([]);
    expect(env().th.notes.filter((n) => n.kind === 'error')).toEqual([]);
  });

  it('a vault switch during listing writes nothing', async () => {
    const p = pendingAt('/workspace/plasmids');
    setup({}, { routes: workspaceRoutes({ parts: [row(1, 'KBp_aa0001', 'A')] }, p.spec) });
    const done = run();
    await p.begun;
    await cancelAllRequests(env().invoke);
    p.answer({ status: 200, json: { items: [], total: 0 } });
    await done;
    expect(store.writes).toEqual([]);
    expect(env().th.notes.filter((n) => n.kind === 'error')).toEqual([]);
  });

  it('a vault root that changed before the write writes nothing', async () => {
    let root = 'C:/vaults/lab';
    setup(
      {},
      {
        routes: {
          ...workspaceRoutes({ parts: [row(1, 'KBp_aa0001', 'A')] }),
          vault_current: () => {
            const r = { root };
            root = 'C:/vaults/other';
            return r;
          },
        },
      },
    );
    await run();
    expect(store.writes).toEqual([]);
  });

  it('without a Global folder it names Sample settings', async () => {
    setup({ parts: [row(1, 'KBp_aa0001', 'A')] });
    // 앱은 빈 설정을 기본 폴더로 읽으므로, 폴더가 없는 env 는 직접 만든다
    await downloadPartbankCatalog({ ...env().env, globalFolder: () => '' }, env().feature, store);
    expect(messages()).toEqual([t('partbank.globalFolderFirst')]);
    expect(requests()).toBe(0);
    expect(store.writes).toEqual([]);
  });

  it('without a connection it says to set one up and calls nothing', async () => {
    store = memoryStore();
    pb = pbEnv({}, { catalogs: store, status: secretStatusOf({}), routes: workspaceRoutes({}) });
    await run();
    expect(messages()).toEqual([t('partbank.setupFirst')]);
    expect(requests()).toBe(0);
  });

  it('a listing failure is told in partbank terms, never as raw Rust text', async () => {
    setup(
      {},
      {
        routes: {
          partbank_request: () => {
            throw { kind: 'status', message: 'raw-rust-text', status: 401 };
          },
        },
      },
    );
    await run();
    expect(store.writes).toEqual([]);
    expect(env().th.notes).toHaveLength(1);
    expect(env().th.notes[0].kind).toBe('error');
    expect(env().th.notes[0].message).toContain('API key was refused');
  });
});

describe('download-partbank-catalog', () => {
  it('download-partbank-catalog is registered once and hidden when not configured', () => {
    registerAllCommands();
    expect(commands().filter((c) => c.id === 'download-partbank-catalog')).toHaveLength(1);
    const cmd = commandById('download-partbank-catalog')!;
    expect(cmd.nameKey).toBe('Download partbank catalog');
    setup({});
    setPartbankFeature(undefined);
    expect(cmd.available?.(env().th.ctx)).toBe(false);
    const unconfigured = pbEnv({}, { status: secretStatusOf({}) });
    setPartbankFeature(unconfigured.feature);
    expect(cmd.available?.(env().th.ctx)).toBe(false);
    unconfigured.th.cleanup();
    setPartbankFeature(env().feature);
    expect(cmd.available?.(env().th.ctx)).toBe(true);
  });

  it('without a feature the command says to set up a connection', async () => {
    registerAllCommands();
    setup({});
    setPartbankFeature(undefined);
    const notify = vi.fn();
    const ctx = env().th.ctx;
    await commandById('download-partbank-catalog')!.run({ ...ctx, host: { ...ctx.host, notify } });
    expect(notify).toHaveBeenCalledWith('info', t('partbank.setupFirst'));
  });
});
