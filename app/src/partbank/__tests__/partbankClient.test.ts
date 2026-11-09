/**
 * 옮겨 온 PartBank 클라이언트. 네트워크는 Rust 가 하므로 여기서는 `partbank_request` 에 넘긴 인자와,
 * Rust 의 `NetError` 가 사용자가 알아들을 `PartbankErrorKind` 로 바뀌는지를 본다(vendor
 * tests/plugin/partbankClient.test.ts 의 경우를 `fakeInvoke` 위에서 그대로).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SampleSource } from '@labnoteo/core';
import {
  PartbankClient,
  PartbankError,
  connectionForOrigin,
  connectionForSource,
  toPartbankError,
  type PartbankConnectionConfig,
  type PartbankErrorKind,
} from '../../labnote/port/partbankClient';
import { NET_ERROR_KINDS, type NetErrorKind } from '../../integrations/netIpc';
import { fakeInvoke, netError } from '../../integrations/__tests__/fakeNet';

const WEB = 'https://partbank.kbiofoundry.kr';
const DESKTOP = 'http://127.0.0.1:47830';
const OID1 = '507f1f77bcf86cd799439011';
const OID2 = '507f1f77bcf86cd799439012';

type Route = (args: Record<string, unknown>) => unknown;

/** 차례로 답하는 `partbank_request`. 마지막 답을 되풀이한다. */
function queued(responses: unknown[]): Route {
  let i = 0;
  return () => responses[Math.min(i++, responses.length - 1)];
}

const ok = (json: unknown) => ({ status: 200, json });

function client(kind: 'web' | 'desktop', route: Route) {
  const f = fakeInvoke({ partbank_request: route });
  return { c: new PartbankClient(kind, kind === 'web' ? WEB : DESKTOP, f.invoke), calls: f.calls };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('requests', () => {
  it('asks Rust for the path only; the address and key stay on the Rust side', async () => {
    const { c, calls } = client('desktop', () => ok({ username: 'hs' }));
    await expect(c.whoAmI()).resolves.toBe('hs');
    expect(calls).toEqual([
      ['partbank_request', { connection: 'desktop', method: 'GET', path: '/auth/me', query: null, body: null }],
    ]);
    expect(JSON.stringify(calls)).not.toContain(DESKTOP);
  });

  it('keeps kind and origin for display', () => {
    const c = new PartbankClient('web', WEB, fakeInvoke({}).invoke);
    expect(c.kind).toBe('web');
    expect(c.origin).toBe(WEB);
  });
});

describe('whoAmI', () => {
  it('whoAmI returns username, else email, else notPartbank', async () => {
    await expect(client('web', () => ok({ username: ' hs ' })).c.whoAmI()).resolves.toBe('hs');
    await expect(client('web', () => ok({ email: 'me@lab.kr' })).c.whoAmI()).resolves.toBe('me@lab.kr');
    for (const body of [{}, { ok: true }, null, { username: '  ' }]) {
      await expect(client('web', () => ok(body)).c.whoAmI()).rejects.toMatchObject({ kind: 'notPartbank' });
    }
  });
});

describe('searchGlobal', () => {
  it('search posts entities, limit 10 and exclude_public, and drops public rows not owned', async () => {
    const f = fakeInvoke({
      partbank_request: () => ({
        status: 200,
        json: {
          results: [
            { type: 'vector', id: OID1, kid: 'KP1', name: 'pUC19', owner_is_me: true, sharing_level: 'private' },
            { type: 'vector', id: OID2, kid: 'KP2', name: 'pX', owner_is_me: false, sharing_level: 'public' },
          ],
          type_counts: { vector: 2 },
        },
      }),
    });
    const r = await new PartbankClient('web', WEB, f.invoke).searchGlobal('pUC', ['vector']);
    // netIpc.partbankRequest 는 빠진 query 를 null(Rust Option)로 보낸다
    expect(f.calls[0]).toEqual([
      'partbank_request',
      {
        connection: 'web',
        method: 'POST',
        path: '/search/global',
        query: null,
        body: { query: 'pUC', types: ['vector'], limit: 10, exclude_public: true },
      },
    ]);
    expect(r.hits.map((h) => h.id)).toEqual([OID1]);
    expect(r.typeCounts).toEqual({ plasmid: 2 });
  });

  it('reads the rows back as items, vector as plasmid', async () => {
    const { c } = client('desktop', () =>
      ok({
        results: [
          {
            id: OID1,
            kid: 'KBvt_aa0001',
            name: 'pTrc99A_GFP',
            type: 'vector',
            description: 'green',
            owner_is_me: true,
            sharing_level: 'private',
          },
        ],
      }),
    );
    const { hits, typeCounts } = await c.searchGlobal('gfp', ['vector', 'part']);
    expect(typeCounts).toBeUndefined();
    expect(hits).toEqual([
      {
        type: 'plasmid',
        id: OID1,
        kid: 'KBvt_aa0001',
        name: 'pTrc99A_GFP',
        description: 'green',
        moleculeType: null,
        ownedByMe: true,
        sharingLevel: 'private',
      },
    ]);
  });

  it('drops public items of other people, keeping own and group-shared ones', async () => {
    const { c } = client('desktop', () =>
      ok({
        results: [
          { id: 'mine', type: 'part', owner_is_me: true, sharing_level: 'public' },
          { id: 'group', type: 'part', owner_is_me: false, sharing_level: 'group' },
          { id: 'stranger', type: 'part', owner_is_me: false, sharing_level: 'public' },
        ],
      }),
    );
    const { hits } = await c.searchGlobal('x', ['part']);
    expect(hits.map((h) => h.id)).toEqual(['mine', 'group']);
  });

  it('skips rows without a usable id or type', async () => {
    const { c } = client('desktop', () =>
      ok({ results: [{ id: 'a' }, { type: 'part' }, 'junk', { id: 'b', type: 'storage' }] }),
    );
    await expect(c.searchGlobal('x', ['part'])).resolves.toEqual({ hits: [] });
  });

  it('reads the total of each type, under the type a link stores', async () => {
    const { c } = client('desktop', () =>
      ok({ results: [], type_counts: { vector: 23, part: 4, storage: 9, primer: 'x' } }),
    );
    await expect(c.searchGlobal('x', ['vector', 'part'])).resolves.toEqual({
      hits: [],
      typeCounts: { plasmid: 23, part: 4 },
    });
  });

  it('makes no call for a blank query or an empty entity list', async () => {
    const { c, calls } = client('desktop', () => ok({ results: [] }));
    await c.searchGlobal('  ', ['part']);
    await c.searchGlobal('gfp', []);
    expect(calls).toEqual([]);
  });
});

describe('getItem and getStocks', () => {
  it('getItem uses the plasmid segment', async () => {
    const { c, calls } = client('web', () => ok({ id: OID1, kid: 'KP1', name: 'pUC19', molecule_type: 'DNA' }));
    await expect(c.getItem('plasmid', OID1)).resolves.toEqual({
      type: 'plasmid',
      id: OID1,
      kid: 'KP1',
      name: 'pUC19',
      description: null,
      moleculeType: 'DNA',
    });
    expect(calls[0][1]).toMatchObject({ method: 'GET', path: `/plasmids/${OID1}` });
  });

  it('getItem without a usable id keeps the asked one', async () => {
    const { c } = client('web', () => ok({}));
    await expect(c.getItem('part', OID1)).resolves.toEqual({ type: 'part', id: OID1 });
  });

  it('asks the by-resource endpoint for the type as partbank names it', async () => {
    const { c, calls } = client('desktop', () => ok({ items: [{ hole_position: 'A1' }] }));
    await expect(c.getStocks('plasmid', 'abc')).resolves.toEqual([{ hole_position: 'A1' }]);
    expect(calls[0][1]).toMatchObject({ path: '/stock-box/by-resource/plasmid/abc' });
  });

  it('reads a missing items array as no stock', async () => {
    const { c } = client('desktop', () => ok({}));
    await expect(c.getStocks('part', 'abc')).resolves.toEqual([]);
  });
});

describe('listAll', () => {
  const page = (n: number, from: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `id-${from + i}`, kid: `KBp_${from + i}` }));

  it('listAll pages by 200 until total and reports each page', async () => {
    const { c, calls } = client(
      'desktop',
      queued([
        ok({ items: page(200, 0), total: 450 }),
        ok({ items: page(200, 200), total: 450 }),
        ok({ items: page(50, 400), total: 450 }),
      ]),
    );
    const onPage = vi.fn();
    const items = await c.listAll('part', onPage);
    expect(items).toHaveLength(450);
    expect(calls.map(([, a]) => a.path)).toEqual(['/workspace/parts', '/workspace/parts', '/workspace/parts']);
    expect(calls.map(([, a]) => (a.query as Array<[string, string]>).find(([k]) => k === 'skip')?.[1])).toEqual([
      '0',
      '200',
      '400',
    ]);
    expect(calls[0][1].query).toEqual([
      ['skip', '0'],
      ['limit', '200'],
      ['include_components', 'false'],
    ]);
    expect(onPage.mock.calls.map(([n]) => n)).toEqual([200, 400, 450]);
    expect(items[0]).toEqual({ type: 'part', id: 'id-0', kid: 'KBp_0', name: null, description: null, moleculeType: null });
  });

  it('stops once it has as many items as the total says', async () => {
    const { c, calls } = client('desktop', () => ok({ items: page(200, 0), total: 200 }));
    await expect(c.listAll('part')).resolves.toHaveLength(200);
    expect(calls).toHaveLength(1);
  });
});

describe('note usages', () => {
  it('puts and prunes over the labnoteo routes', async () => {
    const { c, calls } = client('web', queued([ok({ stored: 1, skipped: [] }), ok({ deleted: 2 })]));
    const put = { client_id: 'c', generation: 'g', vault_name: 'v', notes: [] };
    await expect(c.putNoteUsages(put)).resolves.toEqual({ stored: 1, skipped: [] });
    await expect(c.pruneNoteUsages({ client_id: 'c', generation: 'g' })).resolves.toEqual({ deleted: 2 });
    expect(calls.map(([, a]) => [a.method, a.path, a.body])).toEqual([
      ['PUT', '/labnoteo/usages/notes', put],
      ['POST', '/labnoteo/usages/prune', { client_id: 'c', generation: 'g' }],
    ]);
  });
});

describe('failures', () => {
  it.each([
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'notFound'],
    [429, 'rateLimited'],
    [500, 'server'],
  ] as const)('status %i is %s', async (status, kind) => {
    const { c } = client('desktop', () => {
      throw netError('status', { status, body: 'nope' });
    });
    await expect(c.whoAmI()).rejects.toMatchObject({ kind, status });
  });

  it('a non-2xx answer handed back as data reads by its status too', async () => {
    const { c } = client('desktop', () => ({ status: 404, json: null }));
    await expect(c.whoAmI()).rejects.toMatchObject({ kind: 'notFound', status: 404 });
  });

  it('2xx HTML is notPartbank', async () => {
    const { c } = client('desktop', () => {
      throw netError('notJson', { status: 200, body: '<html>login</html>' });
    });
    const err = await c.whoAmI().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PartbankError);
    expect(err).toMatchObject({ kind: 'notPartbank' });
  });

  it('offline and timeout keep their kinds; keyMissing is notConfigured', async () => {
    for (const [net, kind] of [
      ['offline', 'offline'],
      ['timeout', 'timeout'],
      ['keyMissing', 'notConfigured'],
    ] as const) {
      const { c } = client('web', () => {
        throw netError(net);
      });
      await expect(c.whoAmI()).rejects.toMatchObject({ kind });
    }
  });

  const EXPECTED_KIND: Record<Exclude<NetErrorKind, 'cancelled'>, PartbankErrorKind> = {
    offline: 'offline',
    tls: 'offline',
    timeout: 'timeout',
    notJson: 'notPartbank',
    status: 'server',
    keyMissing: 'notConfigured',
    notConfigured: 'notConfigured',
    invalidUrl: 'notConfigured',
    redirect: 'redirected',
    insecure: 'insecure',
    keychain: 'keychain',
    tooLarge: 'tooLarge',
    forbiddenPath: 'badRequest',
    badInput: 'badRequest',
    remote: 'badRequest',
    noResult: 'badRequest',
    // A scan-folder file failure (SP7 Part B); partbank never sees one, so it is an app bug like badInput.
    io: 'badRequest',
  };

  it.each(NET_ERROR_KINDS.filter((k) => k !== 'cancelled'))('NetError %s maps to a named PartbankErrorKind', (kind) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const e = toPartbankError(netError(kind, { status: 500, location: 'https://pb.example' }));
    expect(e).toBeInstanceOf(PartbankError);
    expect(EXPECTED_KIND[kind as Exclude<NetErrorKind, 'cancelled'>]).toBe(e.kind);
    expect(e.message).not.toContain('raw-rust-text');
  });

  it('an app bug is logged by kind only, with no body', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const e = toPartbankError(netError('forbiddenPath', { body: 'body-text' }));
    expect(e.kind).toBe('badRequest');
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain('forbiddenPath');
    expect(logged).not.toContain('body-text');
    expect(logged).not.toContain('raw-rust-text');
  });

  it('redirect keeps the target origin', () => {
    expect(toPartbankError(netError('redirect', { location: 'https://pb.example' })).location).toBe(
      'https://pb.example',
    );
  });

  it('cancelled is rethrown unchanged', async () => {
    const cancel = netError('cancelled');
    const { c } = client('web', () => {
      throw cancel;
    });
    await expect(c.whoAmI()).rejects.toBe(cancel);
    await expect(c.listAll('part')).rejects.toBe(cancel);
  });
});

describe('picking the connection for a link', () => {
  const connections: PartbankConnectionConfig[] = [
    { kind: 'desktop', origin: DESKTOP },
    { kind: 'web', origin: WEB },
  ];
  const source = (overrides: Partial<SampleSource>): SampleSource => ({
    system: 'partbank',
    connection: 'web',
    origin: WEB,
    type: 'part',
    id: 'abc',
    kid: null,
    ...overrides,
  });

  it('matches a desktop link whatever port it was made on', () => {
    expect(
      connectionForSource(source({ connection: 'desktop', origin: 'http://127.0.0.1:47999' }), connections)?.kind,
    ).toBe('desktop');
  });

  it('matches a web link only on the same server', () => {
    expect(connectionForSource(source({}), connections)?.kind).toBe('web');
    expect(connectionForSource(source({ origin: 'https://other.kr' }), connections)).toBeUndefined();
  });

  it('has no connection when the matching one is not set up', () => {
    expect(connectionForSource(source({ connection: 'desktop' }), [connections[1]])).toBeUndefined();
  });

  it('connectionForOrigin only selects a configured connection', () => {
    expect(connectionForOrigin(`${WEB}/`, connections)?.origin).toBe(WEB);
    expect(connectionForOrigin('http://localhost:47830', connections)?.kind).toBe('desktop');
    expect(connectionForOrigin('http://localhost:47830', [connections[1]])).toBeUndefined();
    expect(connectionForOrigin('https://evil.example.com', connections)).toBeUndefined();
    expect(connectionForOrigin('', connections)).toBeUndefined();
  });
});
