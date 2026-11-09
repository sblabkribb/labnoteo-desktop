// @vitest-environment jsdom
/**
 * 앱 데이터의 PartBank 카탈로그 덧씌우기(D15, Task 20). 내려받은 `{Type}_partbank-*.json` 은 보관함이 아니라 앱 데이터에 있고,
 * 샘플 흐름의 fs 는 그것을 Global 폴더 안의 파일처럼 읽는다. 저장소가 고장 나면 보관함 파일만으로 돌아간다.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { AppFs } from '../../fs/tauriLabnoteFs';
import { fakeInvoke } from '../../integrations/__tests__/fakeNet';
import { createTestHost, type TestHost } from '../../labnote/__tests__/testHost';
import { loadCatalogSamples } from '../../labnote/port/sampleScope';
import { fromPluginData, type AppSettings } from '../../labnote/settings';
import { createSampleEnv, sampleEvents } from '../../samples/env';
import { GLOBAL, SAMPLE_VAULT } from '../../samples/__tests__/fixtures';
import { samples } from '../../samples/sampleStore';
import { useSampleStoreWiring } from '../../samples/useSampleStore';
import {
  currentCatalogStore,
  emptyCatalogStore,
  setPartbankCatalogStore,
  tauriCatalogStore,
  withPartbankCatalogs,
  type PartbankCatalogStore,
} from '../catalogOverlay';
import { pbEnv } from './pbFixture';

const DNA_CATALOG = JSON.stringify({
  'dna-1': {
    type: 'DNA',
    alias: 'pUC ori',
    descriptions: ['origin'],
    sources: [],
    source: { system: 'partbank', origin: 'https://partbank.kbiofoundry.kr', type: 'plasmids', id: '0123456789abcdef01234567' },
  },
});

const WRITE_CMDS = ['vault_write', 'vault_modify', 'vault_remove', 'vault_rename', 'vault_trash'];

/** 메모리 위의 카탈로그 저장소. */
function memoryStore(files: Record<string, string>): PartbankCatalogStore & { fire(): void } {
  const subs = new Set<() => void>();
  const fire = () => {
    for (const s of [...subs]) s();
  };
  return {
    names: async () => Object.keys(files),
    read: async (n) => files[n],
    async write(n, c) {
      files[n] = c;
      fire();
    },
    subscribe(fn) {
      subs.add(fn);
      return () => void subs.delete(fn);
    },
    fire,
  };
}

const failingStore: PartbankCatalogStore = {
  names: () => Promise.reject(new Error('app data broken')),
  read: () => Promise.reject(new Error('app data broken')),
  write: () => Promise.reject(new Error('app data broken')),
  subscribe: () => () => undefined,
};

const SETTINGS = { ...fromPluginData(undefined), globalSampleFolder: GLOBAL, sampleTracking: true } as AppSettings;

let hosts: TestHost[] = [];
const host = (files: Record<string, string> = SAMPLE_VAULT) => {
  const th = createTestHost(files);
  hosts.push(th);
  return th;
};
afterEach(() => {
  for (const th of hosts) th.cleanup();
  hosts = [];
  setPartbankCatalogStore(undefined);
  samples.resetForTest();
});

function overlay(th: TestHost, store: PartbankCatalogStore, folder = () => GLOBAL): AppFs {
  return withPartbankCatalogs(th.host.fs, folder, store);
}

it('list of the Global folder adds the app-data catalog names', async () => {
  const th = host();
  const fs = overlay(th, memoryStore({ 'DNA_partbank-web.json': DNA_CATALOG }));
  const inner = await th.host.fs.list(GLOBAL);
  const listed = await fs.list(GLOBAL);
  expect(listed).toEqual(expect.arrayContaining([...inner, 'DNA_partbank-web.json']));
  expect(listed).toHaveLength(inner.length + 1);
  // 다른 폴더의 목록에는 더하지 않는다
  expect(await fs.list('labnote/061_PCR/resources/labsamples')).not.toContain('DNA_partbank-web.json');
});

it('read and exists of a catalog path come from the store', async () => {
  const th = host();
  const fs = overlay(th, memoryStore({ 'DNA_partbank-web.json': DNA_CATALOG }));
  expect(await fs.exists(`${GLOBAL}/DNA_partbank-web.json`)).toBe(true);
  expect(await fs.read(`${GLOBAL}/DNA_partbank-web.json`)).toBe(DNA_CATALOG);
  expect(await th.host.fs.exists(`${GLOBAL}/DNA_partbank-web.json`)).toBe(false);
  // 코어 로더가 만들 수 있는 './' 와 '\' 모양의 경로도 같다
  expect(await fs.read(String.raw`.\resources\labsamples\DNA_partbank-web.json`)).toBe(DNA_CATALOG);
  expect(await fs.read('./resources//labsamples/DNA_partbank-web.json')).toBe(DNA_CATALOG);
});

it('the Global folder exists when only app-data catalogs are there', async () => {
  const th = host({});
  const fs = overlay(th, memoryStore({ 'DNA_partbank-web.json': DNA_CATALOG }));
  expect(await fs.exists(GLOBAL)).toBe(true);
  expect(await fs.list(GLOBAL)).toEqual(['DNA_partbank-web.json']);
});

it('an app-data catalog shadows a vault file of the same name', async () => {
  const th = host({ ...SAMPLE_VAULT, [`${GLOBAL}/DNA_partbank-web.json`]: '{"old":{"type":"DNA"}}' });
  const fs = overlay(th, memoryStore({ 'DNA_partbank-web.json': DNA_CATALOG }));
  expect(await fs.read(`${GLOBAL}/DNA_partbank-web.json`)).toBe(DNA_CATALOG);
  expect((await fs.list(GLOBAL)).filter((n) => n === 'DNA_partbank-web.json')).toHaveLength(1);
});

it('writes to a catalog path throw read-only', async () => {
  const th = host();
  const fs = overlay(th, memoryStore({ 'DNA_partbank-web.json': DNA_CATALOG }));
  const p = 'resources/labsamples/DNA_partbank-web.json';
  await expect(fs.write(p, '{}')).rejects.toThrow('read-only partbank catalog');
  await expect(fs.modify(p, () => '{}')).rejects.toThrow('read-only partbank catalog');
  await expect(fs.remove(p)).rejects.toThrow('read-only partbank catalog');
  await expect(fs.trash(p)).rejects.toThrow('read-only partbank catalog');
  await expect(fs.rename(p, `${GLOBAL}/x.json`)).rejects.toThrow('read-only partbank catalog');
  await expect(fs.rename(`${GLOBAL}/Reagent.json`, p)).rejects.toThrow('read-only partbank catalog');
  expect(th.vault.log.filter((l) => WRITE_CMDS.includes(l.cmd))).toEqual([]);
});

it('other paths pass through untouched', async () => {
  const th = host();
  const fs = overlay(th, memoryStore({ 'DNA_partbank-web.json': DNA_CATALOG }));
  expect(await fs.read(`${GLOBAL}/Reagent.json`)).toBe(SAMPLE_VAULT[`${GLOBAL}/Reagent.json`]);
  await fs.write(`${GLOBAL}/Plasmid.json`, '{}');
  expect(await th.host.fs.read(`${GLOBAL}/Plasmid.json`)).toBe('{}');
  await fs.modify(`${GLOBAL}/Plasmid.json`, () => '{"a":1}');
  expect(await th.host.fs.read(`${GLOBAL}/Plasmid.json`)).toBe('{"a":1}');
  // 다른 폴더의 같은 이름은 저장소가 아니라 보관함이다
  expect(await fs.exists('labnote/061_PCR/resources/labsamples/DNA_partbank-web.json')).toBe(false);
});

it('follows a Global folder change', async () => {
  const th = host({ ...SAMPLE_VAULT, 'samples/x.json': '{}' });
  let folder = GLOBAL;
  const fs = overlay(th, memoryStore({ 'DNA_partbank-web.json': DNA_CATALOG }), () => folder);
  expect(await fs.list(GLOBAL)).toContain('DNA_partbank-web.json');
  folder = 'samples';
  expect(await fs.list('samples')).toEqual(expect.arrayContaining(['x.json', 'DNA_partbank-web.json']));
  expect(await fs.list(GLOBAL)).not.toContain('DNA_partbank-web.json');
  expect(await fs.read('samples/DNA_partbank-web.json')).toBe(DNA_CATALOG);
});

it('a failing store degrades to the vault files only', async () => {
  const vaultText = '{"old":{"type":"DNA"}}';
  const th = host({ ...SAMPLE_VAULT, [`${GLOBAL}/DNA_partbank-web.json`]: vaultText });
  const fs = overlay(th, failingStore);
  expect(await fs.list(GLOBAL)).toEqual(await th.host.fs.list(GLOBAL));
  expect(await fs.read(`${GLOBAL}/DNA_partbank-web.json`)).toBe(vaultText);
  expect(await fs.exists(`${GLOBAL}/DNA_partbank-web.json`)).toBe(true);
});

it('a listed name the store cannot read falls back to the vault', async () => {
  const th = host({ ...SAMPLE_VAULT, [`${GLOBAL}/DNA_partbank-web.json`]: '{}' });
  const store = memoryStore({});
  store.names = async () => ['DNA_partbank-web.json'];
  const fs = overlay(th, store);
  expect(await fs.read(`${GLOBAL}/DNA_partbank-web.json`)).toBe('{}');
});

it('createSampleEnv without a store behaves exactly as before', async () => {
  const th = host();
  const before = th.vault.log.length;
  const env = createSampleEnv(th.ctx);
  expect(currentCatalogStore()).toBe(emptyCatalogStore);
  expect(await env.fs.list(GLOBAL)).toEqual(await th.host.fs.list(GLOBAL));
  expect(await env.fs.exists(`${GLOBAL}/Reagent.json`)).toBe(true);
  expect(await env.fs.read(`${GLOBAL}/Reagent.json`)).toBe(SAMPLE_VAULT[`${GLOBAL}/Reagent.json`]);
  // 가짜 보관함 커맨드만 갔다(앱 데이터 커맨드는 없다)
  expect(th.vault.log.slice(before).every((l) => l.cmd.startsWith('vault_'))).toBe(true);
});

it('createSampleEnv uses the installed store by default and opts.catalogs over it', async () => {
  const th = host();
  setPartbankCatalogStore(memoryStore({ 'DNA_partbank-web.json': DNA_CATALOG }));
  expect(await createSampleEnv(th.ctx).fs.list(GLOBAL)).toContain('DNA_partbank-web.json');
  const other = memoryStore({ 'Strain_partbank-desktop.json': '{}' });
  const listed = await createSampleEnv(th.ctx, { catalogs: other }).fs.list(GLOBAL);
  expect(listed).toContain('Strain_partbank-desktop.json');
  expect(listed).not.toContain('DNA_partbank-web.json');
  // 대장 쓰기의 겹 방어(safeRegistryFs)보다 먼저 읽기 전용이 거절한다
  await expect(createSampleEnv(th.ctx).fs.write(`${GLOBAL}/DNA_partbank-web.json`, '{}')).rejects.toThrow(
    'read-only partbank catalog',
  );
  setPartbankCatalogStore(undefined);
  expect(currentCatalogStore()).toBe(emptyCatalogStore);
});

it('@DNA; Search catalog finds an app-data catalog item with no network', async () => {
  const pb = pbEnv(SAMPLE_VAULT, { catalogs: memoryStore({ 'DNA_partbank-web.json': DNA_CATALOG }) });
  hosts.push(pb.th);
  const found = await loadCatalogSamples(pb.env, GLOBAL, 'DNA');
  expect(found).toHaveProperty('dna-1');
  expect(found['dna-1']?.alias).toBe('pUC ori');
  expect(pb.calls.some(([cmd]) => cmd === 'partbank_request')).toBe(false);
});

it('the empty store answers nothing and refuses writes', async () => {
  expect(await emptyCatalogStore.names()).toEqual([]);
  expect(await emptyCatalogStore.read('DNA_partbank-web.json')).toBeUndefined();
  await expect(emptyCatalogStore.write('DNA_partbank-web.json', '{}')).rejects.toThrow();
});

describe('tauriCatalogStore', () => {
  it('caches names; write invalidates and notifies', async () => {
    let names = ['DNA_partbank-web.json'];
    const f = fakeInvoke({
      partbank_catalog_list: () => names,
      partbank_catalog_read: (a) => (a.name === 'DNA_partbank-web.json' ? DNA_CATALOG : null),
      partbank_catalog_write: () => {
        names = [...names, 'Plasmid_partbank-web.json'];
        return null;
      },
    });
    const store = tauriCatalogStore(f.invoke);
    const heard = vi.fn();
    const off = store.subscribe(heard);
    expect(await store.names()).toEqual(['DNA_partbank-web.json']);
    expect(await store.names()).toEqual(['DNA_partbank-web.json']);
    expect(f.calls.filter(([c]) => c === 'partbank_catalog_list')).toHaveLength(1);
    expect(await store.read('DNA_partbank-web.json')).toBe(DNA_CATALOG);
    expect(await store.read('Strain_partbank-web.json')).toBeUndefined();
    await store.write('Plasmid_partbank-web.json', '{}');
    expect(f.calls).toContainEqual(['partbank_catalog_write', { name: 'Plasmid_partbank-web.json', content: '{}' }]);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(await store.names()).toEqual(['DNA_partbank-web.json', 'Plasmid_partbank-web.json']);
    expect(f.calls.filter(([c]) => c === 'partbank_catalog_list')).toHaveLength(2);
    off();
    await store.write('Plasmid_partbank-web.json', '{}');
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('a rejected list is not cached', async () => {
    let fail = true;
    const f = fakeInvoke({
      partbank_catalog_list: () => {
        if (fail) throw { kind: 'notConfigured', message: 'raw-rust-text' };
        return ['DNA_partbank-web.json'];
      },
    });
    const store = tauriCatalogStore(f.invoke);
    await expect(store.names()).rejects.toBeTruthy();
    fail = false;
    expect(await store.names()).toEqual(['DNA_partbank-web.json']);
  });
});

describe('store changes reach the sample store', () => {
  it('a store change emits sampleEvents for the Global folder, re-subscribing when the store is swapped', () => {
    const th = host();
    const heard: Array<readonly string[] | undefined> = [];
    const off = sampleEvents.subscribe((p) => heard.push(p));
    const a = memoryStore({});
    setPartbankCatalogStore(a);
    const { unmount } = renderHook(() => useSampleStoreWiring(th.host.fs, SETTINGS));
    heard.length = 0;
    a.fire();
    expect(heard).toEqual([[GLOBAL]]);
    const b = memoryStore({});
    heard.length = 0;
    setPartbankCatalogStore(b);
    expect(heard).toEqual([[GLOBAL]]); // 저장소가 바뀐 것도 카탈로그가 바뀐 것이다
    heard.length = 0;
    a.fire();
    expect(heard).toEqual([]);
    b.fire();
    expect(heard).toEqual([[GLOBAL]]);
    unmount();
    heard.length = 0;
    b.fire();
    setPartbankCatalogStore(undefined);
    expect(heard).toEqual([]);
    off();
  });

  it('the wired sample store reads app-data catalogs', async () => {
    const th = host();
    const configure = vi.spyOn(samples, 'configure');
    setPartbankCatalogStore(memoryStore({ 'DNA_partbank-web.json': DNA_CATALOG }));
    const { unmount } = renderHook(() => useSampleStoreWiring(th.host.fs, SETTINGS));
    const boundFs = configure.mock.calls[0]?.[0];
    expect(boundFs).toBeDefined();
    expect(await boundFs!.list(GLOBAL)).toContain('DNA_partbank-web.json');
    expect(await boundFs!.read(`${GLOBAL}/DNA_partbank-web.json`)).toBe(DNA_CATALOG);
    unmount();
    expect(samples.configured).toBe(false);
    configure.mockRestore();
  });
});
