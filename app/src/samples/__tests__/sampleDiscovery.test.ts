// @vitest-environment jsdom
/**
 * 설정에 없는 시료 종류의 대장 찾기(코어 0.142.0, 플러그인 sampleDiscovery.ts 의 tests/plugin/sampleDiscovery.test.ts).
 * 읽기만 하고, 고른 종류만 설정에 더한다. pickMany 의 답은 테스트 호스트가 늘 []라서 여기서 고른 값으로 바꿔 끼운다.
 */
import { discoverSampleTypes } from '../../labnote/port/sampleDiscovery';
import { discoverSampleTypesOnOpen } from '../../labnote/commands/sampleDiscovery';
import { createTestHost, type TestHost } from '../../labnote/__tests__/testHost';
import { setLang } from '../../i18n/lang';
import { createSampleEnv } from '../env';

const GLOBAL = 'resources/labsamples';
const rec = (type?: string) => ({ alias: 'a', descriptions: [], sources: [], ...(type ? { type } : {}) });

let hosts: TestHost[] = [];
const host = (files: Record<string, string>, settings: Record<string, unknown> = {}) => {
  const th = createTestHost(files, settings);
  hosts.push(th);
  return th;
};
beforeEach(() => setLang('en'));
afterEach(() => {
  for (const th of hosts) th.cleanup();
  hosts = [];
});

/** An env whose registration question is answered with `pick(items)`. */
function envPicking(th: TestHost, pick: (values: string[]) => string[]) {
  const env = createSampleEnv(th.ctx);
  const asked: Array<{ values: string[]; title?: string }> = [];
  const patched = {
    ...env,
    host: {
      ...env.host,
      pickMany: async (items: Array<{ value: string }>, opts?: { title?: string }) => {
        const values = items.map((i) => i.value);
        asked.push({ values, title: opts?.title });
        return pick(values);
      },
    },
  } as typeof env;
  return { env: patched, asked };
}

describe('discoverSampleTypes', () => {
  it('offers a type found in a registry, and registers only the one picked', async () => {
    const th = host({
      [`${GLOBAL}/Plate.json`]: JSON.stringify({ 'Plate-1': rec('Plate') }),
      [`${GLOBAL}/Rack.json`]: JSON.stringify({ 'Rack-1': rec('Rack') }),
    });
    const { env, asked } = envPicking(th, (values) => values.filter((v) => v === 'Rack'));
    await discoverSampleTypes(env);
    expect(asked).toHaveLength(1);
    expect(asked[0].values.sort()).toEqual(['Plate', 'Rack']);
    expect(asked[0].title).toBe('Register sample types found in this vault');
    expect(th.ctx.settings.customSampleTypes).toEqual(['Rack']);
  });

  it('asks nothing for a built-in type, a catalog of one, or an empty registry, and never writes a ledger', async () => {
    const files = {
      [`${GLOBAL}/DNA.json`]: JSON.stringify({ 'DNA-1': rec('DNA') }),
      [`${GLOBAL}/DNA_partbank-web.json`]: JSON.stringify({ 'DNA-9': rec('DNA') }),
      [`${GLOBAL}/Empty.json`]: '{}',
    };
    const th = host(files);
    const { env, asked } = envPicking(th, (values) => values);
    await discoverSampleTypes(env);
    expect(asked).toEqual([]);
    expect(th.notes).toEqual([]);
    expect(th.vault.files()[`${GLOBAL}/Empty.json`]).toBe('{}');
  });

  it('warns about an unreadable or mismatched registry and does not offer its type', async () => {
    const th = host({
      [`${GLOBAL}/Broken.json`]: '{ not json',
      [`${GLOBAL}/Mixed.json`]: JSON.stringify({ 'Mixed-1': rec('Other') }),
    });
    const { env, asked } = envPicking(th, (values) => values);
    await discoverSampleTypes(env);
    expect(asked).toEqual([]);
    expect(th.notes).toHaveLength(1);
    expect(th.notes[0].kind).toBe('warn');
    expect(th.notes[0].message).toContain(`${GLOBAL}/Broken.json`);
    expect(th.notes[0].message).toContain(`${GLOBAL}/Mixed.json`);
    expect(th.ctx.settings.customSampleTypes).toEqual([]);
  });

  it('registers nothing when the question is closed', async () => {
    const th = host({ [`${GLOBAL}/Plate.json`]: JSON.stringify({ 'Plate-1': rec('Plate') }) });
    const { env } = envPicking(th, () => []);
    await discoverSampleTypes(env);
    expect(th.ctx.settings.customSampleTypes).toEqual([]);
  });
});

describe('discoverSampleTypesOnOpen', () => {
  it('does nothing while sample tracking is off', async () => {
    const th = host({ [`${GLOBAL}/Plate.json`]: JSON.stringify({ 'Plate-1': rec('Plate') }) }, { sampleTracking: false });
    await discoverSampleTypesOnOpen(th.ctx);
    expect(th.notes).toEqual([]);
    expect(th.ctx.settings.customSampleTypes).toEqual([]);
  });
});
