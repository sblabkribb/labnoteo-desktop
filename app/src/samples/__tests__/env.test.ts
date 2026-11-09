// @vitest-environment jsdom
import { act } from '@testing-library/react';
import { activeCellView, focusCell } from '../../editor/table/cellEditor';
import { t } from '../../i18n/t';
import { runCommand } from '../../labnote/commands/runCommand';
import { createTestHost, type TestHost } from '../../labnote/__tests__/testHost';
import { hasLocalScope, localSampleFolder, rememberExperiment } from '../../labnote/port/sampleFolders';
import {
  createSampleEnv,
  isRegistryPath,
  RegistryUnreadableError,
  safeRegistryFs,
  sampleEvents,
  trashingFs,
} from '../env';
import { CONFLICTED, GLOBAL, LOCAL, NOTE, SAMPLE_VAULT } from './fixtures';

let hosts: TestHost[] = [];
const host = (...a: Parameters<typeof createTestHost>) => {
  const th = createTestHost(...a);
  hosts.push(th);
  return th;
};
afterEach(() => {
  for (const th of hosts) th.cleanup();
  hosts = [];
  rememberExperiment(undefined);
});

it('remove goes to the recycle bin, never vault_remove', async () => {
  const th = host(SAMPLE_VAULT);
  const fs = trashingFs(th.host.fs);
  await fs.remove(`${GLOBAL}/Reagent.json`);
  expect(th.vault.recycleBin.map((e) => e.path)).toContain(`${GLOBAL}/Reagent.json`);
  expect(th.vault.log.some((l) => l.cmd === 'vault_remove')).toBe(false);
});

it('safeRegistryFs refuses modify and write over a conflicted registry', async () => {
  const th = host({ ...SAMPLE_VAULT, [`${LOCAL}/DNA.json`]: CONFLICTED });
  const fs = safeRegistryFs(th.host.fs, () => GLOBAL);
  const fn = vi.fn((s: string) => s + 'x');
  await expect(fs.modify(`${LOCAL}/DNA.json`, fn)).rejects.toBeInstanceOf(RegistryUnreadableError);
  await expect(fs.write(`${LOCAL}/DNA.json`, '{}')).rejects.toBeInstanceOf(RegistryUnreadableError);
  expect(fn).not.toHaveBeenCalled();
  expect(th.vault.files()[`${LOCAL}/DNA.json`]).toBe(CONFLICTED);
  await fs.modify(`${LOCAL}/RNA.json`, () => '{}'); // missing file: allowed
  await fs.modify(NOTE, (s) => s); // not a registry: allowed
  await fs.write(`${GLOBAL}/Reagent.json`, '{}'); // parsable: allowed
  expect(th.vault.files()[`${LOCAL}/RNA.json`]).toBe('{}');
  expect(th.vault.files()[`${GLOBAL}/Reagent.json`]).toBe('{}');
  expect(isRegistryPath('shared/samples/DNA.json', 'shared/samples')).toBe(true);
  expect(isRegistryPath('a/Labsamples/DNA.json', GLOBAL)).toBe(true);
  expect(isRegistryPath('a/labsamples/sub/DNA.json', GLOBAL)).toBe(false);
});

it('safeRegistryFs also refuses a registry holding a JSON array or a non-object', async () => {
  const th = host({ ...SAMPLE_VAULT, [`${LOCAL}/DNA.json`]: '[1, 2]', [`${GLOBAL}/Reagent.json`]: 'null' });
  const fs = safeRegistryFs(th.host.fs, () => GLOBAL);
  await expect(fs.modify(`${LOCAL}/DNA.json`, () => '{}')).rejects.toBeInstanceOf(RegistryUnreadableError);
  await expect(fs.write(`${GLOBAL}/Reagent.json`, '{}')).rejects.toBeInstanceOf(RegistryUnreadableError);
  expect(th.vault.files()[`${LOCAL}/DNA.json`]).toBe('[1, 2]');
  expect(th.vault.files()[`${GLOBAL}/Reagent.json`]).toBe('null');
});

it('runCommand turns RegistryUnreadableError into one warn toast', async () => {
  const th = host(SAMPLE_VAULT);
  await runCommand(th.ctx, async () => {
    throw new RegistryUnreadableError(`${LOCAL}/DNA.json`);
  });
  expect(th.notes).toEqual([{ kind: 'warn', message: t('samples.registryUnreadable', `${LOCAL}/DNA.json`) }]);
});

it('updateSettings forwards to ctx', async () => {
  const th = host(SAMPLE_VAULT);
  let release!: () => void;
  const seen: unknown[] = [];
  th.ctx.updateSettings = (p) => {
    seen.push(p);
    return new Promise<void>((r) => (release = r));
  };
  const env = createSampleEnv(th.ctx);
  let done = false;
  const pending = env.updateSettings({ customSampleTypes: ['Strain'] }).then(() => void (done = true));
  expect(seen).toEqual([{ customSampleTypes: ['Strain'] }]);
  await Promise.resolve();
  expect(done).toBe(false); // 저장이 끝나야 풀린다
  release();
  await pending;
  expect(done).toBe(true);
});

it('local folder follows vendor semantics', () => {
  rememberExperiment(undefined);
  expect(localSampleFolder(NOTE, GLOBAL)).toBe(LOCAL);
  expect(hasLocalScope(NOTE)).toBe(true);
  expect(localSampleFolder('Home.md', GLOBAL)).toBe(GLOBAL); // a vault-root note uses Global, even after 061
  expect(localSampleFolder('notes/x.md', GLOBAL)).toBe('notes/resources/labsamples');
  expect(localSampleFolder('labnote/061_PCR/images/a.png', GLOBAL)).toBe(LOCAL); // experiment file: remembered
  expect(localSampleFolder(undefined, GLOBAL)).toBe(LOCAL); // nothing active, 061 remembered
  expect(localSampleFolder('x.pdf', GLOBAL)).toBe(LOCAL); // non-note file: remembered
  expect(hasLocalScope('Home.md')).toBe(true);
  rememberExperiment(undefined);
  expect(hasLocalScope(undefined)).toBe(false);
  expect(localSampleFolder(undefined, GLOBAL)).toBe(GLOBAL);
});

it('env.types and globalFolder read the live settings; changed() emits', () => {
  const th = host(SAMPLE_VAULT, { customSampleTypes: ['배지', 'Cell-Line'], globalSampleFolder: ' shared/labsamples/ ' });
  const env = createSampleEnv(th.ctx);
  expect(env.types().slice(-2)).toEqual(['배지', 'Cell-Line']);
  expect(env.globalFolder()).toBe('shared/labsamples');
  th.ctx.updateSettings({ globalSampleFolder: '\\lab\\samples\\' });
  expect(env.globalFolder()).toBe('lab/samples');
  const seen: unknown[] = [];
  const off = sampleEvents.subscribe((f) => seen.push(f));
  env.changed([LOCAL]);
  off();
  env.changed([GLOBAL]);
  expect(seen).toEqual([[LOCAL]]);
});

it('default settings give the default Global folder', () => {
  expect(createSampleEnv(host(SAMPLE_VAULT).ctx).globalFolder()).toBe('resources/labsamples');
  expect(createSampleEnv(host(SAMPLE_VAULT, { globalSampleFolder: '  / ' }).ctx).globalFolder()).toBe('resources/labsamples');
});

it('env.localFolder and hasLocalScope follow the active note', () => {
  const th = host(SAMPLE_VAULT);
  const env = createSampleEnv(th.ctx);
  expect(env.hasLocalScope()).toBe(false);
  expect(env.localFolder()).toBe(GLOBAL);
  th.setActive(NOTE);
  expect(env.activePath()).toBe(NOTE);
  expect(env.localFolder()).toBe(LOCAL);
  th.setActive(undefined);
  expect(env.hasLocalScope()).toBe(true); // 061 remembered
});

it('env.markdownFiles lists every vault note', async () => {
  const env = createSampleEnv(host(SAMPLE_VAULT).ctx);
  expect((await env.markdownFiles()).slice().sort()).toEqual(
    Object.keys(SAMPLE_VAULT)
      .filter((p) => p.endsWith('.md'))
      .sort(),
  );
});

it('env.fs is safe and trashing', async () => {
  const th = host({ ...SAMPLE_VAULT, [`${LOCAL}/DNA.json`]: CONFLICTED });
  const env = createSampleEnv(th.ctx);
  await expect(env.fs.modify(`${LOCAL}/DNA.json`, () => '{}')).rejects.toBeInstanceOf(RegistryUnreadableError);
  await env.fs.remove(`${GLOBAL}/Reagent.json`);
  expect(th.vault.log.some((l) => l.cmd === 'vault_remove')).toBe(false);
  expect(th.vault.recycleBin.map((e) => e.path)).toContain(`${GLOBAL}/Reagent.json`);
});

it('insertAtCursor is false with no open note', () => {
  expect(createSampleEnv(host(SAMPLE_VAULT).ctx).insertAtCursor('DNA-1')).toBe(false);
});

it('insertAtCursor goes into the active cell, escaped', async () => {
  const th = host({ ...SAMPLE_VAULT, [NOTE]: '| a | b |\n|---|---|\n| x | y |\n' });
  const m = await th.mount(NOTE);
  const outer = m.view();
  act(() => void focusCell(outer, 0, 1, 0, 'end')); // the table tests' way of opening a cell, cursor at the cell end
  expect(activeCellView(outer)?.state.doc.toString()).toBe('x');
  let ok = false;
  act(() => void (ok = createSampleEnv(th.ctx).insertAtCursor('DNA-1;a|b')));
  expect(ok).toBe(true);
  expect(m.view().state.doc.toString()).toBe('| a | b |\n|---|---|\n| xDNA-1;a\\|b | y |\n');
});

it('insertAtCursor outside a cell places the reference as the plugin does', async () => {
  const th = host({ ...SAMPLE_VAULT, [NOTE]: '# clone\n\nUse here\n' });
  const m = await th.mount(NOTE);
  const v = m.view();
  act(() => v.dispatch({ selection: { anchor: '# clone\n\nUse'.length } }));
  let ok = false;
  act(() => void (ok = createSampleEnv(th.ctx).insertAtCursor('DNA-1;pUC')));
  expect(ok).toBe(true);
  expect(m.view().state.doc.toString()).toBe('# clone\n\nUse DNA-1;pUC here\n');
});

describe('insertAtCursor outside a cell in a CRLF note', () => {
  // 한 줄만 LF 인 섞인 CRLF 노트: 에디터가 줄 구분자를 '\r\n' 으로 두는 경우(documentIo.lineSeparatorOf)
  const CRLF = '---\r\ntags: pcr\r\n---\r\n# clone\r\n\r\nUse here\r\nmore\n';

  it('after a heading puts the cursor right after the reference', async () => {
    const th = host({ ...SAMPLE_VAULT, [NOTE]: CRLF });
    const m = await th.mount(NOTE);
    const v = m.view();
    expect(v.state.lineBreak).toBe('\r\n');
    const heading = v.state.doc.line(4);
    act(() => v.dispatch({ selection: { anchor: heading.from + 3 } }));
    let ok = false;
    act(() => void (ok = createSampleEnv(th.ctx).insertAtCursor('DNA-1;pUC')));
    expect(ok).toBe(true);
    const s = m.view().state;
    expect(s.sliceDoc()).toBe('---\r\ntags: pcr\r\n---\r\n# clone\r\nDNA-1;pUC\r\n\r\nUse here\r\nmore\n');
    expect(s.doc.line(5).text).toBe('DNA-1;pUC');
    expect(s.selection.main.head).toBe(s.doc.line(6).from);
  });

  it('from the front matter appends at the end with the cursor after the reference', async () => {
    const th = host({ ...SAMPLE_VAULT, [NOTE]: CRLF });
    const m = await th.mount(NOTE);
    const v = m.view();
    act(() => v.dispatch({ selection: { anchor: v.state.doc.line(2).from + 2 } }));
    let ok = false;
    act(() => void (ok = createSampleEnv(th.ctx).insertAtCursor('DNA-1;pUC')));
    expect(ok).toBe(true);
    const s = m.view().state;
    expect(s.sliceDoc()).toBe(`${CRLF}DNA-1;pUC\r\n`);
    expect(s.selection.main.head).toBe(s.doc.length);
  });
});
