// @vitest-environment jsdom
/**
 * 옮겨 온 register-or-reuse(vendor tests/plugin/partbankRegister.test.ts 의 모든 경우와 계획의 이름 붙은 경우).
 * partbank 항목 하나는 labnoteo ID 하나: 이미 대장이나 카탈로그에 있는 항목은 다시 등록하지 않고 쓴다(#270).
 * 네트워크는 fakeInvoke 의 partbank_request 가, 대화상자는 testHost 의 답 줄이, 검색 창은 vi.mock 이 맡는다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SampleSource } from '@labnoteo/core';
import { loadSamplesByType, setSampleDiscarded, upsertSampleRecord } from '@labnoteo/core/lib/sampleStorage';
import { setLang } from '../../i18n/lang';
import { coreT } from '../../labnote/i18n';
import { PartbankClient, type PartbankSearchHit } from '../../labnote/port/partbankClient';
import {
  addStrainType,
  catalogSeedNote,
  collectLinkedCandidates,
  noticeForRegistration,
  pickPartbankReference,
  registerPartbankItem,
  resolveSampleType,
  strainTypeOf,
  type RegisteredPartbankSample,
} from '../../labnote/port/partbankRegister';
import { RegistryUnreadableError, sampleEvents } from '../../samples/env';
import { secretStatusOf } from '../../integrations/__tests__/fakeNet';
import { cancelAllRequests } from '../../integrations/netIpc';
import { CONFLICTED } from '../../samples/__tests__/fixtures';
import { searchPartbankDialog } from '../PartbankSearchDialog';
import { PB_WEB, partbankRoutes, pbEnv, type PbEnv } from './pbFixture';

vi.mock('../PartbankSearchDialog', () => ({ searchPartbankDialog: vi.fn() }));
const search = vi.mocked(searchPartbankDialog);

const WEB = PB_WEB;
const LOCAL = 'labnote/001_Exp/resources/labsamples';
const GLOBAL = 'resources/labsamples';
const NOTE = 'labnote/001_Exp/001_WD010_A.labnote.md';
const OID1 = '507f1f77bcf86cd799439011';
const ITEM = { type: 'part' as const, id: OID1, kid: 'KBp_aa0249', name: 'sfGFP' };
const STOCKS = `/stock-box/by-resource/part/${OID1}`;

const source: SampleSource = {
  system: 'partbank',
  connection: 'web',
  origin: WEB,
  type: 'part',
  id: ITEM.id,
  kid: ITEM.kid,
};

let pb: PbEnv;
let events: Array<readonly string[] | undefined>;
let off: () => void;

/** 기본: 노트가 실험 001_Exp 안에 있고, partbank 는 재고를 하나도 주지 않는다. */
function setup(
  answers: Record<string, unknown> = { [STOCKS]: { items: [] } },
  settings: NonNullable<Parameters<typeof pbEnv>[1]>['settings'] = {},
  routes: Record<string, (args: Record<string, unknown>) => unknown> = {},
): PbEnv {
  pb?.th.cleanup();
  pb = pbEnv(
    { [NOTE]: '# A\n' },
    { routes: { ...partbankRoutes(answers), ...routes }, settings: { globalSampleFolder: GLOBAL, ...settings } },
  );
  pb.th.setActive(NOTE);
  return pb;
}

const client = () => pb.client!;
const messages = () => pb.th.notes.map((n) => n.message);
const fs = () => pb.env.fs;

beforeEach(() => {
  setLang('en');
  events = [];
  off = sampleEvents.subscribe((paths) => void events.push(paths));
  search.mockReset();
  setup();
});
afterEach(() => {
  off();
  pb.th.cleanup();
});

// #504: "Search partbank" made a second sample with an alias the experiment already had.
describe('registerPartbankItem and a sample with the same alias', () => {
  beforeEach(async () => {
    await upsertSampleRecord(fs(), LOCAL, 'DNA', 'DNA-2', { alias: 'sfGFP', description: '손 기록', source: null });
  });

  it('reuses an alias sibling (#504)', async () => {
    pb.th.answer.pick('DNA-2');
    const result = await registerPartbankItem(pb.env, client(), ITEM, { folder: LOCAL, type: 'DNA' });
    expect(result).toMatchObject({ id: 'DNA-2', reused: true, sameAlias: true, referenceText: 'DNA-2;sfGFP', foundIn: 'local' });
    expect(Object.keys(await loadSamplesByType(fs(), LOCAL, 'DNA'))).toEqual(['DNA-2']);
    expect(pb.th.asked.pick[0].items).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: 'Create a new sample anyway', value: null })]),
    );
  });

  it('writes a new sample when asked to, and nothing when cancelled', async () => {
    pb.th.answer.pick(undefined);
    expect(await registerPartbankItem(pb.env, client(), ITEM, { folder: LOCAL, type: 'DNA' })).toBeUndefined();
    expect(Object.keys(await loadSamplesByType(fs(), LOCAL, 'DNA'))).toEqual(['DNA-2']);

    pb.th.answer.pick(() => null);
    const result = await registerPartbankItem(pb.env, client(), ITEM, { folder: LOCAL, type: 'DNA' });
    expect(result?.reused).toBe(false);
    expect(Object.keys(await loadSamplesByType(fs(), LOCAL, 'DNA'))).toHaveLength(2);
  });
});

describe('registerPartbankItem (#270)', () => {
  it('reuses a sample already linked to the item', async () => {
    await upsertSampleRecord(fs(), GLOBAL, 'DNA', 'DNA-1', { alias: 'sfGFP', description: null, source });
    const before = pb.th.vault.log.filter((l) => l.cmd.startsWith('vault_write')).length;

    const result = await registerPartbankItem(pb.env, client(), ITEM, { folder: LOCAL, type: 'DNA' });

    expect(result).toMatchObject({ id: 'DNA-1', reused: true, folder: GLOBAL, foundIn: 'global', referenceText: 'DNA-1;sfGFP' });
    expect(pb.th.vault.log.filter((l) => l.cmd.startsWith('vault_write')).length).toBe(before);
    expect(pb.calls.filter((c) => c[0] === 'partbank_request')).toEqual([]);
    expect(events).toEqual([]);
  });

  it('reuses the sample this experiment already has when Global is the target', async () => {
    await upsertSampleRecord(fs(), LOCAL, 'DNA', 'DNA-1', { alias: 'sfGFP', description: null, source });

    const result = await registerPartbankItem(pb.env, client(), ITEM, { folder: GLOBAL, type: 'DNA', lookIn: LOCAL });

    expect(result).toMatchObject({ id: 'DNA-1', reused: true, folder: LOCAL });
    expect(await loadSamplesByType(fs(), GLOBAL, 'DNA')).toEqual({});
  });

  // #387: a sample marked used up was reused without a word.
  it('carries the discard date of a reused sample', async () => {
    await upsertSampleRecord(fs(), LOCAL, 'DNA', 'DNA-1', { alias: 'sfGFP', description: null, source });
    await setSampleDiscarded(fs(), LOCAL, 'DNA', 'DNA-1', '2026-10-01');
    const result = await registerPartbankItem(pb.env, client(), ITEM, { folder: LOCAL, type: 'DNA' });
    expect(result).toMatchObject({ id: 'DNA-1', reused: true, discarded: '2026-10-01' });
  });

  it('writes to the chosen folder when nothing stands for the item yet', async () => {
    const result = await registerPartbankItem(pb.env, client(), ITEM, { folder: GLOBAL, type: 'DNA', lookIn: LOCAL });

    expect(result?.reused).toBe(false);
    expect(result?.folder).toBe(GLOBAL);
    expect(Object.keys(await loadSamplesByType(fs(), GLOBAL, 'DNA'))).toEqual([result!.id]);
    expect(await loadSamplesByType(fs(), LOCAL, 'DNA')).toEqual({});
    expect(events).toContainEqual([`${GLOBAL}/DNA.json`]);
  });

  it('still finds a Global sample when the target is Local', async () => {
    await upsertSampleRecord(fs(), GLOBAL, 'DNA', 'DNA-9', { alias: 'sfGFP', description: null, source });

    const result = await registerPartbankItem(pb.env, client(), ITEM, { folder: LOCAL, type: 'DNA' });

    expect(result).toMatchObject({ id: 'DNA-9', reused: true, folder: GLOBAL });
  });

  // #301
  it('finds the sample after its type was changed, and says which type was asked for', async () => {
    await upsertSampleRecord(fs(), LOCAL, 'Other', 'Other-3', { alias: 'sfGFP', description: null, source });

    const result = await registerPartbankItem(pb.env, client(), ITEM, { folder: LOCAL, type: 'DNA' });

    expect(result).toMatchObject({ type: 'Other', id: 'Other-3', reused: true, folder: LOCAL, foundIn: 'local', requestedType: 'DNA' });
    expect(await loadSamplesByType(fs(), LOCAL, 'DNA')).toEqual({});
  });

  it('prefers the type asked for when two types stand for the item', async () => {
    await upsertSampleRecord(fs(), LOCAL, 'Other', 'Other-3', { alias: 'sfGFP', description: null, source });
    await upsertSampleRecord(fs(), LOCAL, 'DNA', 'DNA-4', { alias: 'sfGFP', description: null, source });

    const result = await registerPartbankItem(pb.env, client(), ITEM, { folder: LOCAL, type: 'DNA' });

    expect(result).toMatchObject({ id: 'DNA-4' });
    expect(result?.requestedType).toBeUndefined();
  });

  // #295
  it('reports the folder of the catalog it was found in', async () => {
    const record = { type: 'DNA', alias: 'sfGFP', descriptions: [], sources: [], location: null, source };
    await fs().write(`${GLOBAL}/DNA_partbank-web.json`, JSON.stringify({ 'DNA-7': record }));

    const result = await registerPartbankItem(pb.env, client(), ITEM, { folder: LOCAL, type: 'DNA' });

    expect(result).toMatchObject({ id: 'DNA-7', reused: true, folder: GLOBAL, foundIn: 'catalog' });
  });

  it('collectLinkedCandidates reads every type, the asked one first, Local then Global', async () => {
    await upsertSampleRecord(fs(), LOCAL, 'Other', 'Other-3', { alias: 'a', description: null, source });
    await upsertSampleRecord(fs(), GLOBAL, 'DNA', 'DNA-9', { alias: 'b', description: null, source });
    const found = await collectLinkedCandidates(pb.env, 'DNA', LOCAL);
    expect(found.map((c) => [c.type, c.id, c.scope, c.folder])).toEqual([
      ['DNA', 'DNA-9', 'global', GLOBAL],
      ['Other', 'Other-3', 'local', LOCAL],
    ]);
  });
});

describe('a new sample', () => {
  it('a new sample gets its location from the stocks', async () => {
    setup({
      [STOCKS]: {
        items: [
          { is_owner: false, storage: { name: 'Shared' }, stock_box: { name: 'S1' }, hole_position: 'H9' },
          { is_owner: true, storage: { name: 'F1' }, stock_box: { name: 'B2' }, hole_position: 'A3' },
        ],
      },
    });
    const result = await registerPartbankItem(pb.env, client(), { ...ITEM, description: 'green; bright' }, { folder: LOCAL, type: 'DNA' });

    expect(result).toMatchObject({ type: 'DNA', reused: false, folder: LOCAL, alias: 'sfGFP' });
    const record = (await loadSamplesByType(fs(), LOCAL, 'DNA'))[result!.id];
    expect(record.location).toBe('F1 / B2 / A3; Shared / S1 / H9');
    expect(record.source).toEqual(source);
    expect(record.descriptions?.[0]).toBe('KBp_aa0249 · green, bright');
    expect(result!.referenceText).toBe(`${result!.id};sfGFP`);
    expect(pb.calls.find((c) => c[0] === 'partbank_request')?.[1]).toMatchObject({ connection: 'web', method: 'GET', path: STOCKS });
  });

  it('a stock failure still registers, without a location', async () => {
    setup({ [STOCKS]: () => { throw { kind: 'offline', message: 'raw-rust-text' }; } });
    const result = await registerPartbankItem(pb.env, client(), ITEM, { folder: LOCAL, type: 'DNA' });
    expect(result?.reused).toBe(false);
    expect((await loadSamplesByType(fs(), LOCAL, 'DNA'))[result!.id].location).toBeNull();
    expect(messages().join(' ')).not.toContain('raw-rust-text');
  });
});

// D11: a vault switch while partbank is answering must not write into the vault switched to.
describe('a vault switch during registration', () => {
  const STRAIN_ID = '507f1f77bcf86cd799439012';
  const strainHit: PartbankSearchHit = { type: 'strain', id: STRAIN_ID, kid: 'KBs_1', name: 'DH5a', ownedByMe: true, sharingLevel: 'private' };
  const writes = () => pb.th.vault.log.filter((l) => l.cmd.startsWith('vault_write'));
  /** The vault is switched while partbank answers, and Rust gives the request up as cancelled. */
  const switchVault = () => {
    void cancelAllRequests(pb.invoke);
    throw { kind: 'cancelled', message: 'cancelled' };
  };
  let root: string;
  const rootRoute = { vault_current: () => ({ root }) };
  beforeEach(() => {
    root = 'C:/vaults/lab';
  });

  it('a vault switch during the stock lookup writes nothing', async () => {
    setup({ [STOCKS]: switchVault });
    const result = await registerPartbankItem(pb.env, client(), ITEM, { folder: LOCAL, type: 'DNA' });
    expect(result).toBeUndefined();
    expect(writes()).toEqual([]);
    expect(await loadSamplesByType(fs(), LOCAL, 'DNA')).toEqual({});
    expect(events).toEqual([]);
  });

  it('another vault opened before the write writes nothing', async () => {
    setup(
      {
        [STOCKS]: () => {
          root = 'C:/vaults/other';
          return { items: [] };
        },
      },
      {},
      rootRoute,
    );
    const result = await registerPartbankItem(pb.env, client(), ITEM, { folder: LOCAL, type: 'DNA' });
    expect(result).toBeUndefined();
    expect(writes()).toEqual([]);
    expect(events).toEqual([]);
  });

  it('a vault switch during the item refetch registers nothing and asks nothing', async () => {
    setup({ [`/strains/${STRAIN_ID}`]: switchVault });
    search.mockResolvedValueOnce(strainHit);
    const update = vi.spyOn(pb.th.ctx, 'updateSettings');
    expect(await pickPartbankReference(pb.env, pb.feature, { type: null, initialQuery: 'DH' })).toBeUndefined();
    expect(pb.th.asked.confirm).toEqual([]);
    expect(update).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
    expect(pb.th.notes).toEqual([]);
  });

  it('the strain type is not added to the settings after another vault opened', async () => {
    setup(
      {
        [`/strains/${STRAIN_ID}`]: () => {
          root = 'C:/vaults/other';
          return { id: STRAIN_ID, kid: 'KBs_1', name: 'DH5a' };
        },
      },
      {},
      rootRoute,
    );
    search.mockResolvedValueOnce(strainHit);
    pb.th.answer.confirm(true);
    const update = vi.spyOn(pb.th.ctx, 'updateSettings');
    expect(await pickPartbankReference(pb.env, pb.feature, { type: null, initialQuery: 'DH' })).toBeUndefined();
    expect(update).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
    expect(pb.th.notes).toEqual([]);
  });
});

describe('a conflicted target registry', () => {
  it('is refused before the alias question and the stock lookup', async () => {
    await upsertSampleRecord(fs(), GLOBAL, 'DNA', 'DNA-2', { alias: 'sfGFP', description: null, source: null });
    await fs().write(`${LOCAL}/DNA.json`, CONFLICTED);
    await expect(registerPartbankItem(pb.env, client(), ITEM, { folder: LOCAL, type: 'DNA' })).rejects.toBeInstanceOf(
      RegistryUnreadableError,
    );
    expect(pb.th.asked.pick).toEqual([]);
    expect(pb.calls.filter((c) => c[0] === 'partbank_request')).toEqual([]);
    expect(pb.th.vault.files()[`${LOCAL}/DNA.json`]).toBe(CONFLICTED);
  });
});

// #446: the same tube got a new ID and an empty location in the next experiment, without a word.
describe('registerPartbankItem in another experiment (#446)', () => {
  const OTHER = 'labnote/002_Other/resources/labsamples';
  const THIRD = 'labnote/003_Third/resources/labsamples';
  const KEPT = '−20°C 냉동고 B / 플라스미드 박스 2, C5';
  const newLocation = async () => {
    const records = await loadSamplesByType(fs(), LOCAL, 'DNA');
    return Object.values(records)[0]?.location;
  };

  it("offers the other experiment's location when partbank has none, and writes it when accepted", async () => {
    await upsertSampleRecord(fs(), OTHER, 'DNA', 'DNA-3', { alias: 'sfGFP', description: null, location: KEPT, source });
    pb.th.answer.confirm(true);

    const result = await registerPartbankItem(pb.env, client(), ITEM, { folder: LOCAL, type: 'DNA' });

    expect(result).toMatchObject({ reused: false, folder: LOCAL, elsewhere: [{ folder: OTHER, id: 'DNA-3' }] });
    expect(pb.th.asked.confirm).toHaveLength(1);
    expect(pb.th.asked.confirm[0]).toEqual({
      message: `DNA-3 of the experiment 002_Other has this partbank item, kept at '${KEPT}'. Write that storage location for this sample too?`,
      opts: { confirmLabel: 'Use this location' },
    });
    expect(await newLocation()).toBe(KEPT);
  });

  it('leaves the location empty when declined', async () => {
    await upsertSampleRecord(fs(), OTHER, 'DNA', 'DNA-3', { alias: 'sfGFP', description: null, location: KEPT, source });
    pb.th.answer.confirm(false);

    await registerPartbankItem(pb.env, client(), ITEM, { folder: LOCAL, type: 'DNA' });

    expect(await newLocation()).toBeNull();
  });

  it('does not ask when partbank gave a location', async () => {
    setup({ [STOCKS]: { items: [{ is_owner: true, storage: { name: 'Freezer A' } }] } });
    await upsertSampleRecord(fs(), OTHER, 'DNA', 'DNA-3', { alias: 'sfGFP', description: null, location: KEPT, source });

    const result = await registerPartbankItem(pb.env, client(), ITEM, { folder: LOCAL, type: 'DNA' });

    expect(pb.th.asked.confirm).toEqual([]);
    expect(await newLocation()).toBe('Freezer A');
    expect(result?.elsewhere).toEqual([{ folder: OTHER, id: 'DNA-3' }]);
  });

  it('does not ask when the others disagree on the location', async () => {
    await upsertSampleRecord(fs(), OTHER, 'DNA', 'DNA-3', { alias: 'sfGFP', description: null, location: KEPT, source });
    await upsertSampleRecord(fs(), THIRD, 'DNA', 'DNA-5', { alias: 'sfGFP', description: null, location: 'Freezer C', source });
    const result = await registerPartbankItem(pb.env, client(), ITEM, { folder: LOCAL, type: 'DNA' });
    expect(pb.th.asked.confirm).toEqual([]);
    expect(result?.elsewhere).toHaveLength(2);
  });

  it('does not ask when only discarded ones have it', async () => {
    await upsertSampleRecord(fs(), OTHER, 'DNA', 'DNA-3', { alias: 'sfGFP', description: null, location: KEPT, source });
    await setSampleDiscarded(fs(), OTHER, 'DNA', 'DNA-3', '2026-10-01');
    await registerPartbankItem(pb.env, client(), ITEM, { folder: LOCAL, type: 'DNA' });
    expect(pb.th.asked.confirm).toEqual([]);
  });

  it('says nothing of samples for other items, or of this experiment and Global', async () => {
    await upsertSampleRecord(fs(), OTHER, 'DNA', 'DNA-3', {
      alias: 'other',
      description: null,
      location: KEPT,
      source: { ...source, id: '507f1f77bcf86cd799439099' },
    });
    const result = await registerPartbankItem(pb.env, client(), ITEM, { folder: GLOBAL, type: 'DNA', lookIn: OTHER });
    expect(result?.elsewhere).toBeUndefined();
    expect(pb.th.asked.confirm).toEqual([]);
  });
});

describe('strains', () => {
  const STRAIN = { type: 'strain' as const, id: '507f1f77bcf86cd799439012', kid: 'KBs_1', name: 'DH5a' };

  it('a strain with no Strain type asks to add it', async () => {
    const update = vi.spyOn(pb.th.ctx, 'updateSettings');
    expect(strainTypeOf(pb.env)).toBeUndefined();
    pb.th.answer.confirm(true);

    expect(await resolveSampleType(pb.env, STRAIN)).toBe('Strain');

    expect(pb.th.asked.confirm[0]).toEqual({
      message: coreT('partbank keeps strains, but this vault has no sample type for them. Add the custom sample type "{0}"?', 'Strain'),
      opts: { confirmLabel: coreT('Add {0}', 'Strain') },
    });
    expect(update).toHaveBeenCalledWith({ customSampleTypes: ['Strain'] });
    expect(pb.th.ctx.settings.customSampleTypes).toEqual(['Strain']);
    expect(strainTypeOf(pb.env)).toBe('Strain');
    expect(events).toContainEqual(undefined);
  });

  it('a declined or silent strain prompt leaves the settings alone', async () => {
    const update = vi.spyOn(pb.th.ctx, 'updateSettings');
    pb.th.answer.confirm(false);
    expect(await resolveSampleType(pb.env, STRAIN)).toBeUndefined();
    expect(await resolveSampleType(pb.env, STRAIN, { silent: true })).toBeUndefined();
    expect(pb.th.asked.confirm).toHaveLength(1);
    expect(update).not.toHaveBeenCalled();
  });

  it('an existing strain type is used without asking, and addStrainType does not add it twice', async () => {
    setup(undefined, { customSampleTypes: ['strain'] });
    const update = vi.spyOn(pb.th.ctx, 'updateSettings');
    expect(await resolveSampleType(pb.env, STRAIN)).toBe(strainTypeOf(pb.env));
    expect(pb.th.asked.confirm).toEqual([]);
    await addStrainType(pb.env);
    expect(update).not.toHaveBeenCalled();
    expect(events).toContainEqual(undefined);
  });
});

describe('pickPartbankReference', () => {
  const MOL = '507f1f77bcf86cd799439013';
  const molHit: PartbankSearchHit = { type: 'molecule', id: MOL, kid: 'KBm_1', name: 'Cas9', ownedByMe: true, sharingLevel: 'private' };

  it('pickPartbankReference refetches the item so molecule_type decides the type', async () => {
    setup({
      [`/molecules/${MOL}`]: { id: MOL, kid: 'KBm_1', name: 'Cas9', molecule_type: 'protein' },
      [`/stock-box/by-resource/molecule/${MOL}`]: { items: [] },
    });
    search.mockResolvedValueOnce(molHit);

    const ref = await pickPartbankReference(pb.env, pb.feature, { type: null, initialQuery: 'Cas' });

    expect(search).toHaveBeenCalledOnce();
    expect(search.mock.calls[0][0]).toMatchObject({ type: null, initialQuery: 'Cas', client: pb.client });
    expect(search.mock.calls[0][0].entities).toContain('molecule');
    const records = await loadSamplesByType(fs(), LOCAL, 'Protein');
    const [id] = Object.keys(records);
    expect(id).toMatch(/^Protein-/);
    expect(ref).toBe(`${id};Cas9`);
    expect(messages()).toEqual([`Sample added: ${id}`]);
  });

  it('a failed refetch of a molecule for @sample reports it and stops', async () => {
    setup({});
    search.mockResolvedValueOnce(molHit);
    expect(await pickPartbankReference(pb.env, pb.feature, { type: null, initialQuery: '' })).toBeUndefined();
    expect(pb.th.notes.map((n) => n.kind)).toEqual(['error']);
    expect(messages().join(' ')).not.toContain('raw-rust-text');
    expect(await loadSamplesByType(fs(), LOCAL, 'Reagent')).toEqual({});
  });

  it('a failed refetch with a typed type still registers the search row', async () => {
    setup({ [`/stock-box/by-resource/part/${OID1}`]: { items: [] } });
    search.mockResolvedValueOnce({ ...ITEM, ownedByMe: true, sharingLevel: 'private' });
    const ref = await pickPartbankReference(pb.env, pb.feature, { type: 'DNA', initialQuery: 'sf' });
    expect(ref).toMatch(/^DNA-.*;sfGFP$/);
  });

  it('search errors go through the feature', async () => {
    search.mockImplementationOnce(async (opts) => {
      opts.onError({ kind: 'unauthorized-ish' });
      return undefined;
    });
    await pickPartbankReference(pb.env, pb.feature, { type: 'DNA', initialQuery: '' });
    expect(pb.th.notes.map((n) => n.kind)).toEqual(['error']);
  });

  it('warns when the alias clashes', async () => {
    setup({ [`/parts/${OID1}`]: { id: OID1, kid: ITEM.kid, name: 'sfGFP' }, [STOCKS]: { items: [] } });
    await upsertSampleRecord(fs(), GLOBAL, 'DNA', 'DNA-8', { alias: 'sfGFP', description: null, source: null });
    search.mockResolvedValueOnce({ ...ITEM, ownedByMe: true, sharingLevel: 'private' });

    const ref = await pickPartbankReference(pb.env, pb.feature, { type: 'DNA', initialQuery: 'sf' });

    const [id] = Object.keys(await loadSamplesByType(fs(), LOCAL, 'DNA'));
    expect(ref).toBe(`${id};sfGFP`);
    expect(pb.th.notes).toEqual([
      { kind: 'warn', message: coreT('"{0}" is already the alias of {1}.', 'sfGFP', 'DNA-8') },
      { kind: 'info', message: coreT('Sample added: {0}', id) },
    ]);
  });

  it('a reused catalog sample says saving the note copies it', async () => {
    setup({ [`/parts/${OID1}`]: { id: OID1, kid: ITEM.kid, name: 'sfGFP' } }, { sampleTracking: true });
    const record = { type: 'DNA', alias: 'sfGFP', descriptions: [], sources: [], location: null, source };
    await fs().write(`${GLOBAL}/DNA_partbank-web.json`, JSON.stringify({ 'DNA-7': record }));
    search.mockResolvedValueOnce({ ...ITEM, ownedByMe: true, sharingLevel: 'private' });

    expect(await pickPartbankReference(pb.env, pb.feature, { type: 'DNA', initialQuery: '' })).toBe('DNA-7;sfGFP');
    expect(messages()).toEqual([
      `Used DNA-7 from the partbank catalog (${GLOBAL}). Saving the note adds it to this experiment's samples as well.`,
    ]);
  });

  it('returns undefined and writes nothing when the search is cancelled', async () => {
    search.mockResolvedValueOnce(undefined);
    expect(await pickPartbankReference(pb.env, pb.feature, { type: 'DNA', initialQuery: 'x' })).toBeUndefined();
    expect(pb.th.vault.log.some((l) => l.cmd.startsWith('vault_write'))).toBe(false);
    expect(pb.calls.filter((c) => c[0] === 'partbank_request')).toEqual([]);
    expect(pb.th.notes).toEqual([]);
  });

  it('without a configured connection it says to set one up and does not search', async () => {
    pb.th.cleanup();
    pb = pbEnv({ [NOTE]: '' }, { status: secretStatusOf({}) });
    expect(await pickPartbankReference(pb.env, pb.feature, { type: 'DNA', initialQuery: '' })).toBeUndefined();
    expect(search).not.toHaveBeenCalled();
    expect(pb.th.notes.map((n) => n.kind)).toEqual(['info']);
  });
});

describe('noticeForRegistration (#270)', () => {
  const result = (folder: string, reused: boolean): RegisteredPartbankSample => ({
    type: 'DNA',
    id: 'DNA-1',
    alias: 'sfGFP',
    referenceText: 'DNA-1;sfGFP',
    folder,
    reused,
  });

  it('says where a reused sample is when another folder was chosen', () => {
    noticeForRegistration(pb.env, result(LOCAL, true), GLOBAL);
    expect(messages()).toEqual([
      `DNA-1 in ${LOCAL} already stands for this partbank item, so it was used instead of registering a second one.`,
    ]);
  });

  // #295: a catalog sample read as if nothing had happened.
  it('names the catalog a reused sample came from, and a Global one without a choice', () => {
    noticeForRegistration(pb.env, { ...result(GLOBAL, true), foundIn: 'catalog' }, undefined, 'SEED');
    noticeForRegistration(pb.env, { ...result(GLOBAL, true), foundIn: 'global' });
    noticeForRegistration(pb.env, { ...result(LOCAL, true), foundIn: 'local' });
    expect(messages()).toEqual([
      `Used DNA-1 from the partbank catalog (${GLOBAL}). SEED`,
      `DNA-1 in ${GLOBAL} already stands for this partbank item, so it was used instead of registering a second one.`,
      'DNA-1 already stands for this partbank item.',
    ]);
  });

  it('a reused alias sibling says the existing sample is used', () => {
    noticeForRegistration(pb.env, { ...result(LOCAL, true), sameAlias: true, foundIn: 'local' });
    expect(messages()).toEqual(['Using the existing sample DNA-1 instead of creating one.']);
  });

  // #301
  it('says when the reused sample has another type than the one asked for', () => {
    noticeForRegistration(pb.env, { ...result(LOCAL, true), foundIn: 'local', type: 'Other', id: 'Other-1', requestedType: 'DNA' });
    expect(messages()).toEqual(['Other-1 already stands for this partbank item. It is registered as Other, not DNA.']);
  });

  it('says a reused sample was marked discarded', () => {
    noticeForRegistration(pb.env, { ...result(LOCAL, true), foundIn: 'local', discarded: '2026-10-01' });
    expect(messages()).toEqual(['DNA-1 already stands for this partbank item. DNA-1 was marked discarded on 2026-10-01.']);
  });

  it('tells a chosen Global apart from Global by default', () => {
    noticeForRegistration(pb.env, result(GLOBAL, false), GLOBAL);
    noticeForRegistration(pb.env, result(GLOBAL, false));
    expect(messages()).toEqual([
      'Sample added to Global samples: DNA-1',
      'DNA-1 was added to Global samples because this note is outside an experiment folder.',
    ]);
  });

  // #446
  it('names the other experiments with the same partbank item, before the extra', () => {
    const elsewhere = [
      { folder: 'labnote/002_Other/resources/labsamples', id: 'DNA-3' },
      { folder: 'labnote/003_Third/resources/labsamples', id: 'DNA-5' },
    ];
    noticeForRegistration(pb.env, { ...result(LOCAL, false), elsewhere }, undefined, 'EXTRA');
    expect(messages()).toEqual([
      'Sample added: DNA-1 Other experiments have this partbank item too: DNA-3 (002_Other), DNA-5 (003_Third). EXTRA',
    ]);
  });

  it('is said in Korean when the app is', () => {
    setLang('ko');
    noticeForRegistration(pb.env, { ...result(LOCAL, true), foundIn: 'local' });
    expect(messages()).toEqual([coreT('{0} already stands for this partbank item.', 'DNA-1')]);
    expect(messages()[0]).not.toBe('DNA-1 already stands for this partbank item.');
  });
});

describe('catalogSeedNote (#295)', () => {
  const fromCatalog: RegisteredPartbankSample = {
    type: 'DNA',
    id: 'DNA-7',
    alias: 'sfGFP',
    referenceText: 'DNA-7;sfGFP',
    folder: GLOBAL,
    reused: true,
    foundIn: 'catalog',
  };

  it('says saving copies a catalog sample into the experiment, once its reference is in a note there', () => {
    setup(undefined, { sampleTracking: true });
    expect(catalogSeedNote(pb.env, fromCatalog, NOTE)).toBe("Saving the note adds it to this experiment's samples as well.");
  });

  it('says nothing without a note, outside an experiment, untracked, or not from a catalog', () => {
    setup(undefined, { sampleTracking: true });
    expect(catalogSeedNote(pb.env, fromCatalog, undefined)).toBe('');
    expect(catalogSeedNote(pb.env, fromCatalog, 'notes/loose.md')).toBe('');
    expect(catalogSeedNote(pb.env, { ...fromCatalog, foundIn: 'local' }, NOTE)).toBe('');
    expect(catalogSeedNote({ ...pb.env, trackingFor: () => false }, fromCatalog, NOTE)).toBe('');
  });
});

it('the client in the fixture is the web connection', () => {
  expect(pb.client).toBeInstanceOf(PartbankClient);
  expect([pb.client?.kind, pb.client?.origin]).toEqual(['web', WEB]);
});
