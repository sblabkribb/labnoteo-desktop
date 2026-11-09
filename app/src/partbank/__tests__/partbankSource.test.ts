// @vitest-environment jsdom
/**
 * `@` 완성의 "Search partbank" 줄(vendor sampleSuggest.ts partbankSearchType 와 renderSuggestion 의 partbank 줄).
 * 줄을 만들 때는 네트워크를 쓰지 않고, 줄을 고르면 register-or-reuse(pickPartbankReference)가 대화상자를 연다.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { coreT } from '../../labnote/i18n';
import { pickPartbankReference } from '../../labnote/port/partbankRegister';
import { PARTBANK_ORDER, partbankRowLabel, partbankSearchType } from '../../labnote/port/partbankSuggest';
import { secretStatusOf } from '../../integrations/__tests__/fakeNet';
import { clearSampleSourceCaches, localActionsSource, orderRows, sampleQueryAt, type SampleActionRow, type SampleRow } from '../../samples/sources';
import { partbankSource } from '../partbankSource';
import { pbEnv, type PbEnv } from './pbFixture';

vi.mock('../../labnote/port/partbankRegister', async (orig) => ({
  ...(await orig<typeof import('../../labnote/port/partbankRegister')>()),
  pickPartbankReference: vi.fn(),
}));
const pick = vi.mocked(pickPartbankReference);

const NOTE = 'labnote/001_Exp/001_WD010_A.labnote.md';
const REAGENT_CATALOG = 'resources/labsamples/Reagent_vendor.json';

let envs: PbEnv[] = [];
function setup(...a: Parameters<typeof pbEnv>): PbEnv {
  const pb = pbEnv(a[0] ?? {}, { ...a[1], settings: { customSampleTypes: ['Media'], ...a[1]?.settings } });
  envs.push(pb);
  return pb;
}
afterEach(() => {
  for (const pb of envs) pb.th.cleanup();
  envs = [];
  pick.mockReset();
  clearSampleSourceCaches();
});

const query = (pb: PbEnv, line: string) => sampleQueryAt(line, NOTE, pb.env.types())!;
const rowsOf = async (pb: PbEnv, line: string) =>
  (await partbankSource(() => pb.feature).rows(query(pb, line), pb.env)) as SampleActionRow[];

it('@sample gives one row "Search partbank" for every type', async () => {
  const pb = setup();
  const rows = await rowsOf(pb, '@sample;');
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ kind: 'action', source: 'partbank', type: null, order: 100, label: coreT('Search partbank') });
  expect(PARTBANK_ORDER).toBe(100);
  expect(partbankSearchType(true, query(pb, '@sample;').trigger)).toBeNull();
});

it('@Plasmid; gives "Find and register partbank {0}"', async () => {
  const pb = setup();
  const rows = await rowsOf(pb, '@Plasmid;');
  expect(rows.map((r) => [r.type, r.label, r.detail])).toEqual([
    ['Plasmid', coreT('Search partbank'), coreT('Find and register partbank {0}', coreT('plasmids'))],
  ]);
  expect(partbankRowLabel(coreT, 'Plasmid')).toEqual({ label: rows[0].label, detail: rows[0].detail });
  // @DNA; searches parts, devices and molecules: the plural list the plugin builds.
  expect((await rowsOf(pb, '@DNA;'))[0].detail).toBe(
    coreT('Find and register partbank {0}', coreT('{0} and {1}', [coreT('parts'), coreT('devices')].join(coreT(', ')), coreT('molecules'))),
  );
});

it('a type with no partbank entity gives no row', async () => {
  const pb = setup();
  expect(await rowsOf(pb, '@Media;')).toEqual([]);
  expect(partbankSearchType(true, query(pb, '@Media;').trigger)).toBeUndefined();
});

it('a vault strain type gives a strain row', async () => {
  const pb = setup({}, { settings: { customSampleTypes: ['Strain'] } });
  expect((await rowsOf(pb, '@Strain;')).map((r) => [r.type, r.detail])).toEqual([
    ['Strain', coreT('Find and register partbank {0}', coreT('strains'))],
  ]);
  // the strain type is the vault's: without it a custom type named Strain is just another type
  expect(partbankSearchType(true, query(pb, '@Strain;').trigger)).toBeUndefined();
  expect(partbankSearchType(true, query(pb, '@Strain;').trigger, 'Strain')).toBe('Strain');
  expect(partbankRowLabel(coreT, 'Strain', 'Strain').detail).toBe(coreT('Find and register partbank {0}', coreT('strains')));
});

it('not configured gives no row', async () => {
  const pb = setup({}, { status: secretStatusOf({}) });
  expect(pb.feature.configured).toBe(false);
  expect(await rowsOf(pb, '@sample;')).toEqual([]);
  expect(await rowsOf(pb, '@DNA;')).toEqual([]);
  expect(partbankSearchType(false, query(pb, '@DNA;').trigger)).toBeUndefined();
  // no feature at all (no vault open) is the same
  expect(await partbankSource(() => undefined).rows(query(pb, '@DNA;'), pb.env)).toEqual([]);
});

it('rows never touch the network', async () => {
  const pb = setup();
  const before = pb.calls.length;
  for (let i = 0; i < 20; i++) await rowsOf(pb, i % 2 ? '@DNA;pU' : '@sample;x');
  expect(pb.calls.length - before).toBe(0);
});

it('run passes the typed text as the initial query and returns the reference', async () => {
  const pb = setup();
  pick.mockResolvedValue('DNA-3;sfGFP');
  const q = query(pb, '@DNA;sfG');
  const [row] = await rowsOf(pb, '@DNA;sfG');
  expect(await row.run(q)).toBe('DNA-3;sfGFP');
  expect(pick).toHaveBeenCalledWith(pb.env, pb.feature, { type: 'DNA', initialQuery: 'sfG' });

  const qs = query(pb, '@sample');
  const [all] = await rowsOf(pb, '@sample');
  pick.mockResolvedValue(undefined);
  expect(await all.run(qs)).toBeUndefined();
  expect(pick).toHaveBeenLastCalledWith(pb.env, pb.feature, { type: null, initialQuery: '' });
});

it('orderRows puts the partbank row after catalog, generate and manual', async () => {
  const pb = setup({ [REAGENT_CATALOG]: '{"R-1":{"type":"Reagent","alias":"x","descriptions":[],"sources":[]}}' });
  const q = query(pb, '@Reagent;');
  const rows: SampleRow[] = [...(await partbankSource(() => pb.feature).rows(q, pb.env)), ...(await localActionsSource.rows(q, pb.env))];
  expect(orderRows(rows).map((r) => (r.kind === 'action' ? r.source : r.entry.id))).toEqual([
    'catalog',
    'generate',
    'manual',
    'partbank',
  ]);
});
