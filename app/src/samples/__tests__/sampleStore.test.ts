// @vitest-environment jsdom
/** 계획 Task 7: 샘플 저장소(색인, README 캐시, 판 번호)와 편집기 설정 훅. */
import { act, renderHook, waitFor as rtlWaitFor } from '@testing-library/react';
import { createTestHost, type TestHost } from '../../labnote/__tests__/testHost';
import { SampleIdIndex } from '../../labnote/port/sampleIdIndex';
import { fromPluginData, type AppSettings } from '../../labnote/settings';
import { createSampleEnv, sampleEvents } from '../env';
import { SAMPLE_FOCUS_REREAD_MS, sameKnown, samples } from '../sampleStore';
import { useSampleEditorConfig, useSampleStoreWiring, useSamplesVersion } from '../useSampleStore';
import { GLOBAL, KNOWN, KNOWN_WITH_DNA9, LOCAL, NOTE, SAMPLE_VAULT } from './fixtures';

vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));

const waitFor = vi.waitFor;
const DEFAULT_SETTINGS: AppSettings = fromPluginData(undefined);
const S = { sampleTracking: true, customSampleTypes: [], globalSampleFolder: GLOBAL };
const RUN = 'labnote/062_Gel/001_run.labnote.md';
const DNA2 = '{"DNA-2":{"type":"DNA","alias":"","descriptions":[],"sources":[]}}';

let hosts: TestHost[] = [];
function setup(): TestHost {
  const th = createTestHost(SAMPLE_VAULT);
  hosts.push(th);
  samples.resetForTest();
  samples.configure(th.host.fs, S);
  return th;
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  samples.resetForTest();
  for (const th of hosts) th.cleanup();
  hosts = [];
});

async function knownReady() {
  samples.known(NOTE);
  await waitFor(() => expect(samples.known(NOTE)?.ids.has('dna-1')).toBe(true));
}

it('a registry write bumps the version and refreshes known IDs', async () => {
  const th = setup();
  await knownReady();
  const v = samples.version;
  await th.host.fs.write(`${LOCAL}/DNA.json`, DNA2);
  samples.vaultChanged([`${LOCAL}/DNA.json`]);
  await waitFor(() => expect(samples.known(NOTE)?.ids.has('dna-2')).toBe(true));
  expect(samples.version).toBe(v + 1);
});

it('a re-read with the same IDs, aliases and discards does not bump', async () => {
  const th = setup();
  await knownReady();
  const v = samples.version;
  const read = vi.spyOn(SampleIdIndex.prototype as unknown as { read(f: string): Promise<void> }, 'read');
  await th.host.fs.write(
    `${LOCAL}/DNA.json`,
    '{"DNA-1":{"type":"DNA","alias":"pUC","descriptions":["miniprep","again"],"sources":["001_clone"],"location":"Freezer A / B3"}}',
  );
  samples.registryChanged([`${LOCAL}/DNA.json`]);
  await waitFor(() => expect(read).toHaveBeenCalled());
  await new Promise((r) => setTimeout(r, 20));
  expect(samples.version).toBe(v);
});

it('sampleEvents from a command invalidate the same way', async () => {
  const th = setup();
  await knownReady();
  const v = samples.version;
  await th.host.fs.write(`${LOCAL}/DNA.json`, DNA2);
  sampleEvents.emit([LOCAL]);
  await waitFor(() => expect(samples.known(NOTE)?.ids.has('dna-2')).toBe(true));
  expect(samples.version).toBe(v + 1);
});

it('a README change bumps the version (tracking re-evaluated)', async () => {
  setup();
  const fn = vi.fn();
  const off = samples.subscribe(fn);
  samples.trackingFor(RUN);
  await waitFor(() => expect(samples.trackingFor(RUN)).toBe(false));
  fn.mockClear();
  samples.vaultChanged(['labnote/062_Gel/README.labnote.md']);
  expect(fn).toHaveBeenCalledTimes(1);
  off();
});

it('the first README read that turns a note off bumps the version', async () => {
  setup();
  const v = samples.version;
  expect(samples.trackingFor(RUN)).toBe(true); // setting alone, before the README is read
  await waitFor(() => expect(samples.version).toBe(v + 1));
  expect(samples.trackingFor(RUN)).toBe(false);
  expect(await samples.ready(RUN)).toBe(false);
  expect(await samples.ready(NOTE)).toBe(true);
});

it('sameKnown compares ids, aliases and discards, not the version', () => {
  expect(sameKnown(KNOWN, { ...KNOWN, version: 9 })).toBe(true);
  expect(sameKnown(KNOWN, KNOWN_WITH_DNA9)).toBe(false);
  expect(sameKnown(KNOWN, { ...KNOWN, aliases: new Map([['dna-1', 'x']]) })).toBe(false);
  expect(sameKnown(KNOWN, { ...KNOWN, discarded: new Map() })).toBe(false);
  expect(sameKnown(undefined, undefined)).toBe(true);
  expect(sameKnown(KNOWN, undefined)).toBe(false);
});

it('editor config is null when sampleTracking is off and stable while the version is', () => {
  setup();
  const { result, rerender } = renderHook(({ s }) => useSampleEditorConfig(s), {
    initialProps: { s: { ...DEFAULT_SETTINGS, ...S } as AppSettings },
  });
  const first = result.current;
  expect(first).not.toBeNull();
  expect(first?.types).toContain('DNA');
  rerender({ s: { ...DEFAULT_SETTINGS, ...S } });
  expect(result.current).toBe(first);
  rerender({ s: { ...DEFAULT_SETTINGS, ...S, sampleTracking: false } });
  expect(result.current).toBeNull();
});

it('editor config follows the store version', async () => {
  setup();
  const { result } = renderHook(() => ({ v: useSamplesVersion(), c: useSampleEditorConfig({ ...DEFAULT_SETTINGS, ...S }) }));
  const first = result.current.c;
  act(() => samples.known(NOTE));
  await rtlWaitFor(() => expect(result.current.c?.known(NOTE)?.ids.has('dna-1')).toBe(true));
  expect(result.current.c).not.toBe(first);
  expect(result.current.c?.version).toBe(samples.version);
  expect(result.current.v).toBe(samples.version);
});

it('window focus re-reads every registry at most once per 5 s', () => {
  vi.useFakeTimers();
  const th = createTestHost(SAMPLE_VAULT);
  hosts.push(th);
  samples.resetForTest();
  const invalidate = vi.spyOn(SampleIdIndex.prototype, 'invalidate');
  const settings = { ...DEFAULT_SETTINGS, ...S } as AppSettings;
  const { unmount } = renderHook(() => useSampleStoreWiring(th.host.fs, settings));
  invalidate.mockClear();
  window.dispatchEvent(new Event('focus'));
  vi.advanceTimersByTime(1000);
  window.dispatchEvent(new Event('focus'));
  expect(invalidate).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(SAMPLE_FOCUS_REREAD_MS);
  window.dispatchEvent(new Event('focus'));
  expect(invalidate).toHaveBeenCalledTimes(2);
  unmount();
});

it('SampleEnv.trackingFor follows the store once it is configured', async () => {
  const th = setup();
  const env = createSampleEnv(th.ctx);
  env.trackingFor(RUN);
  await waitFor(() => expect(env.trackingFor(RUN)).toBe(false));
  expect(env.trackingFor(NOTE)).toBe(true);
});
