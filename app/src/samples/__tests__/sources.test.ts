// @vitest-environment jsdom
import type { SampleCompletionEntry } from '@labnoteo/core';
import { coreT } from '../../labnote/i18n';
import { createTestHost, type TestHost } from '../../labnote/__tests__/testHost';
import { createSampleEnv, sampleEvents } from '../env';
import {
  clearSampleSourceCaches,
  localActionsSource,
  orderRows,
  registerSampleSource,
  registerSampleSources,
  registrySource,
  sampleActionRunners,
  sampleQueryAt,
  sampleSources,
  type SampleActionRow,
  type SampleExistingRow,
} from '../sources';
import { sampleTypesFor } from '../types';
import { GLOBAL, LOCAL, NOTE, SAMPLE_VAULT } from './fixtures';

let hosts: TestHost[] = [];
const host = (...a: Parameters<typeof createTestHost>) => {
  const th = createTestHost(...a);
  hosts.push(th);
  return th;
};
afterEach(() => {
  for (const th of hosts) th.cleanup();
  hosts = [];
  clearSampleSourceCaches();
  delete sampleActionRunners.catalog;
  delete sampleActionRunners.generate;
  delete sampleActionRunners.manual;
});

it('parses the query and the #142 prefill', () => {
  const types = sampleTypesFor({ customSampleTypes: ['배지'] });
  expect(sampleQueryAt('see @DNA;pU', NOTE, types)).toMatchObject({
    notePath: NOTE,
    typed: 'pU',
    trigger: { searchTerm: 'pu', typesToSearch: ['DNA'], startCol: 4 },
  });
  expect(sampleQueryAt('@배지', NOTE, types)?.typed).toBeUndefined();
  expect(sampleQueryAt('@배지:a b', NOTE, types)?.typed).toBe('a b');
  expect(sampleQueryAt('@dna;A;b;', NOTE, types)).toBeUndefined(); // a definition is being typed (#171)
  expect(sampleQueryAt('no trigger', NOTE, types)).toBeUndefined();
});

it('existing rows: Local wins over Global', async () => {
  const env = createSampleEnv(
    host({ ...SAMPLE_VAULT, [`${GLOBAL}/DNA.json`]: '{"DNA-1":{"type":"DNA","alias":"global","descriptions":[],"sources":[]}}' }).ctx,
  );
  const rows = await registrySource.rows(sampleQueryAt('@DNA;', NOTE, env.types())!, env);
  expect(rows).toEqual([
    { kind: 'existing', entry: expect.objectContaining({ id: 'DNA-1', scope: 'local', insertText: 'DNA-1;pUC' }) },
  ]);
});

it('existing rows: a discarded Global sample is listed with its date', async () => {
  const env = createSampleEnv(host(SAMPLE_VAULT).ctx);
  const rows = (await registrySource.rows(sampleQueryAt('@Reagent;', NOTE, env.types())!, env)) as SampleExistingRow[];
  expect(rows.map((r) => [r.entry.id, r.entry.scope, r.entry.discarded])).toEqual([['Reagent-7', 'global', '2026-10-01']]);
});

it('orderRows: existing → actions by order → discarded', () => {
  const a = (order: number, source: string): SampleActionRow => ({
    kind: 'action',
    source,
    type: 'DNA',
    label: source,
    detail: '',
    order,
    run: async () => undefined,
  });
  const e = (id: string, discarded?: string): SampleExistingRow => ({
    kind: 'existing',
    entry: { type: 'DNA', id, label: id, insertText: id, discarded } as SampleCompletionEntry,
  });
  expect(
    orderRows([e('X', '2026-01-01'), a(100, 'remote'), a(20, 'generate'), e('A'), a(10, 'catalog')]).map((r) =>
      r.kind === 'action' ? r.source : r.entry.id,
    ),
  ).toEqual(['A', 'catalog', 'generate', 'remote', 'X']);
});

it('localActionsSource offers catalog only when a catalog exists, labelled like the plugin', async () => {
  const env = createSampleEnv(host(SAMPLE_VAULT).ctx);
  const rows = async (line: string) => (await localActionsSource.rows(sampleQueryAt(line, NOTE, env.types())!, env)) as SampleActionRow[];
  const labels = async (line: string) => (await rows(line)).map((r) => r.label);
  expect(await labels('@Reagent;')).toEqual([
    coreT('Search {0} catalog', 'Reagent'),
    coreT('Generate new {0} ID', 'Reagent'),
    coreT('Enter info'),
  ]);
  expect(await labels('@DNA;')).toEqual([coreT('Generate new {0} ID', 'DNA'), coreT('Enter info')]);
  expect((await rows('@DNA;')).map((r) => [r.source, r.order, r.type, r.detail])).toEqual([
    ['generate', 20, 'DNA', coreT('Automatically generate a new sample ID')],
    ['manual', 30, 'DNA', coreT('Manually enter sample ID, alias, and description')],
  ]);
  expect(await labels('@sample;')).toEqual([]); // @sample expands to every type: no actions
});

it('action rows run through sampleActionRunners', async () => {
  sampleActionRunners.generate = async (_env, q, type) => `${type}-7;${q.typed}`;
  const env = createSampleEnv(host(SAMPLE_VAULT).ctx);
  const q = sampleQueryAt('@DNA;pU', NOTE, env.types())!;
  const gen = (await localActionsSource.rows(q, env)).find((r) => (r as SampleActionRow).source === 'generate') as SampleActionRow;
  expect(await gen.run(q)).toBe('DNA-7;pU');
  delete sampleActionRunners.generate;
  expect(await gen.run(q)).toBeUndefined();
});

it('a registered source is consulted and unregisters', () => {
  const off = registerSampleSource({ id: 'fake', rows: async () => [] });
  expect(sampleSources().map((s) => s.id)).toContain('fake');
  off();
  expect(sampleSources().map((s) => s.id)).not.toContain('fake');
});

it('registerSampleSources is idempotent: registry then local actions', () => {
  registerSampleSources();
  registerSampleSources();
  const ids = sampleSources().map((s) => s.id);
  expect(ids.filter((id) => id === 'registry')).toHaveLength(1);
  expect(ids.filter((id) => id === 'local-actions')).toHaveLength(1);
  expect(ids.indexOf('registry')).toBeLessThan(ids.indexOf('local-actions'));
});

it('cache: a second call within 1.5 s does not re-read; sampleEvents clears it', async () => {
  const th = host(SAMPLE_VAULT);
  const env = createSampleEnv(th.ctx);
  const reads = () => th.vault.log.filter((l) => l.cmd === 'vault_read' && l.args.path === `${LOCAL}/DNA.json`).length;
  const q = sampleQueryAt('@DNA;', NOTE, env.types())!;
  await registrySource.rows(q, env);
  await registrySource.rows(q, env);
  expect(reads()).toBe(1);
  sampleEvents.emit([LOCAL]);
  await registrySource.rows(q, env);
  expect(reads()).toBe(2);
});
