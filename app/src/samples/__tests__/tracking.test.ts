// @vitest-environment jsdom
import { createTestHost, type TestHost } from '../../labnote/__tests__/testHost';
import { SampleTracking } from '../tracking';
import { NOTE, README, SAMPLE_VAULT } from './fixtures';

const waitFor = vi.waitFor;
const RUN = 'labnote/062_Gel/001_run.labnote.md';

let hosts: TestHost[] = [];
const host = (...a: Parameters<typeof createTestHost>) => {
  const th = createTestHost(...a);
  hosts.push(th);
  return th;
};
afterEach(() => {
  for (const th of hosts) th.cleanup();
  hosts = [];
});

it('README sample_tracking: no turns one experiment off, live', async () => {
  const th = host(SAMPLE_VAULT);
  let changes = 0;
  const tr = new SampleTracking(th.host.fs, () => changes++);
  expect(tr.on(true, RUN)).toBe(true); // not read yet
  await waitFor(() => expect(tr.on(true, RUN)).toBe(false));
  expect(tr.on(true, NOTE)).toBe(true);
  expect(tr.on(false, NOTE)).toBe(false);
  expect(tr.on(true, 'Home.md')).toBe(true); // outside experiments: setting alone
  await th.host.fs.write('labnote/062_Gel/README.labnote.md', README.replace('061 PCR', '062 Gel'));
  tr.invalidate(['labnote/062_Gel/README.labnote.md']);
  expect(changes).toBe(1);
  await waitFor(() => expect(tr.on(true, RUN)).toBe(true));
});

it('ready() waits for the README on a cold cache', async () => {
  const tr = new SampleTracking(host(SAMPLE_VAULT).host.fs, () => {});
  expect(await tr.ready(true, RUN)).toBe(false);
  expect(await tr.ready(true, NOTE)).toBe(true);
  expect(await tr.ready(false, NOTE)).toBe(false);
});

it.each(['false', 'off', 'no'])('YAML %s is off', async (v) => {
  const th = host({ ...SAMPLE_VAULT, 'labnote/062_Gel/README.labnote.md': `---\nsample_tracking: ${v}\n---\n` });
  expect(await new SampleTracking(th.host.fs, () => {}).ready(true, RUN)).toBe(false);
});

it('an unreadable README counts as on', async () => {
  const vault = { ...SAMPLE_VAULT };
  delete vault['labnote/062_Gel/README.labnote.md'];
  expect(await new SampleTracking(host(vault).host.fs, () => {}).ready(true, RUN)).toBe(true);
});

it('a BOM and CRLF README is read', async () => {
  const th = host({ ...SAMPLE_VAULT, 'labnote/062_Gel/README.labnote.md': '\ufeff---\r\nsample_tracking: no\r\n---\r\n' });
  expect(await new SampleTracking(th.host.fs, () => {}).ready(true, RUN)).toBe(false);
});

it('invalidate drops entries under a folder, ignores unrelated paths, and a stale read does not repopulate', async () => {
  const th = host(SAMPLE_VAULT);
  let changes = 0;
  const tr = new SampleTracking(th.host.fs, () => changes++);
  expect(await tr.ready(true, RUN)).toBe(false);
  tr.invalidate([NOTE, 'Home.md']);
  expect(changes).toBe(0);
  expect(tr.on(true, RUN)).toBe(false);
  tr.invalidate(['labnote']);
  expect(changes).toBe(1);
  // a read in flight when the cache is dropped must not put the old answer back
  const pending = tr.ready(true, RUN);
  await th.host.fs.write('labnote/062_Gel/README.labnote.md', README);
  tr.invalidate('all');
  expect(changes).toBe(2);
  await pending;
  expect(await tr.ready(true, RUN)).toBe(true);
  expect(tr.on(true, RUN)).toBe(true);
  tr.invalidate('all');
  tr.invalidate('all');
  expect(changes).toBe(3); // nothing cached the second time
});
