// @vitest-environment jsdom
import type { PickItem, WorkflowItem } from '@labnoteo/core';
import { setLang } from '../../../i18n/lang';
import { createTestHost, type TestHost } from '../../__tests__/testHost';
import { deleteWorkflow, insertWorkflowAfter, moveWorkflow } from '../workflowOrder';

const DIR = 'labnote/001_단백질_발현';
const A = '001_WD090_Design.labnote.md';
const B = '002_WB010_Oligo.labnote.md';
const C = '003_WB020_Clone.labnote.md';
const D = '004_WT010_Test.labnote.md';

const readme = (lines: string[], eol = '\n') =>
  [
    '---',
    'title: 단백질 발현',
    'status: in-progress',
    'last_updated_date: 2026-01-01',
    '---',
    '',
    '## 🗂️ Related Workflows',
    '',
    ...lines,
    '',
    '## Summary and Discussion',
    '',
  ].join(eol);
const MD_EXT = /(\.labnote)?\.md$/;
const entry = (name: string, done = false) => `- [${done ? 'x' : ' '}] [${name.slice(4, 9)} ${name.slice(10).replace(MD_EXT, '')}](./${name})`;
const note = (id: string) => `---\ntitle: ${id}\n---\n\n## [${id} Name] alias\n\n본문 ${id}\n`;
const files = () => (h ? h.vault.files() : {});
const names = () =>
  Object.keys(files())
    .filter((p) => p.startsWith(`${DIR}/`) && !p.slice(DIR.length + 1).includes('/'))
    .map((p) => p.slice(DIR.length + 1))
    .sort();

let h: TestHost;

beforeEach(() => setLang('ko'));
afterEach(() => {
  for (const n of h?.notes ?? []) expect(n.message).toMatch(/[가-힣]/);
  h?.cleanup();
});

function modern(extra: Record<string, string> = {}) {
  return createTestHost({
    [`${DIR}/README.labnote.md`]: readme([entry(A, true), entry(B), entry(C, true)]),
    [`${DIR}/${A}`]: note('WD090'),
    [`${DIR}/${B}`]: note('WB010'),
    [`${DIR}/${C}`]: note('WB020'),
    'notes/memo.md': `[[002_WB010_Oligo.labnote|올리고]] 그리고 [클론](../${DIR}/${C})\n`,
    ...extra,
  });
}

describe('move up / down', () => {
  it('swapping 002 and 003 renames both, rewrites links in other notes, reorders the README and keeps ticks and contents', async () => {
    h = modern();
    const moved = await moveWorkflow(h.ctx, `${DIR}/${B}`, 'down');
    expect(moved).toBe(`${DIR}/003_WB010_Oligo.labnote.md`);
    expect(names()).toEqual([A, '002_WB020_Clone.labnote.md', '003_WB010_Oligo.labnote.md', 'README.labnote.md']);
    expect(files()[`${DIR}/003_WB010_Oligo.labnote.md`]).toBe(note('WB010'));
    expect(files()[`${DIR}/002_WB020_Clone.labnote.md`]).toBe(note('WB020'));
    const text = files()[`${DIR}/README.labnote.md`];
    const lines = text.split('\n').filter((l) => l.startsWith('- ['));
    expect(lines).toEqual([
      '- [x] [WD090 Design](./001_WD090_Design.labnote.md)',
      '- [x] [WB020 Clone](./002_WB020_Clone.labnote.md)',
      '- [ ] [WB010 Oligo](./003_WB010_Oligo.labnote.md)',
    ]);
    expect(files()['notes/memo.md']).toBe(`[[003_WB010_Oligo.labnote|올리고]] 그리고 [클론](../${DIR}/002_WB020_Clone.labnote.md)\n`);
    expect(h.asked.confirm).toEqual([]);
    expect(h.notes.at(-1)!.kind).toBe('info');
    expect(h.noteOpts.at(-1)!.action).toBeDefined();
  });

  it('the toast undo moves it back to the exact original files and README', async () => {
    h = modern();
    const before = { ...files() };
    await moveWorkflow(h.ctx, `${DIR}/${B}`, 'down');
    h.noteOpts.at(-1)!.action!.run();
    await vi.waitFor(() => expect(names()).toEqual([A, B, C, 'README.labnote.md']));
    await vi.waitFor(() => expect(files()['notes/memo.md']).toBe(before['notes/memo.md']));
    const strip = (s: string) => s.replace(/last_updated_date: .*/, '');
    expect(strip(files()[`${DIR}/README.labnote.md`])).toBe(strip(before[`${DIR}/README.labnote.md`]));
  });

  it('moving more than two files asks first with the rename list; No changes nothing', async () => {
    h = createTestHost({
      [`${DIR}/README.labnote.md`]: readme([entry(A), entry(B), entry(C), entry(D)]),
      [`${DIR}/${A}`]: note('WD090'),
      [`${DIR}/${B}`]: note('WB010'),
      [`${DIR}/${C}`]: note('WB020'),
      [`${DIR}/${D}`]: note('WT010'),
    });
    const before = { ...files() };
    expect(await moveWorkflow(h.ctx, `${DIR}/${A}`, 3)).toBeUndefined();
    expect(h.asked.confirm).toHaveLength(1);
    expect(h.asked.confirm[0].message).toContain(`${A} → 004_WD090_Design.labnote.md`);
    expect(files()).toEqual(before);
    h.answer.confirm(true);
    await moveWorkflow(h.ctx, `${DIR}/${A}`, 3);
    expect(names()).toEqual(['001_WB010_Oligo.labnote.md', '002_WB020_Clone.labnote.md', '003_WT010_Test.labnote.md', '004_WD090_Design.labnote.md', 'README.labnote.md']);
    const lines = files()[`${DIR}/README.labnote.md`].split('\n').filter((l) => l.startsWith('- ['));
    expect(lines.map((l) => l.slice(l.indexOf('(./') + 3, -1))).toEqual(names().slice(0, 4));
  });

  it('works in a legacy experiment: README.md, NNN_Wxxx_*.md, bare lines, NNN labels, CRLF', async () => {
    const a = '001_WD090_Design.md';
    const b = '002_WB010_Oligo.md';
    h = createTestHost({
      [`${DIR}/README.md`]: readme([`[x] [001 WD090 Design](./${a})`, '  - 메모', `[ ] [002 WB010 Oligo](./${b})`], '\r\n'),
      [`${DIR}/${a}`]: note('WD090'),
      [`${DIR}/${b}`]: note('WB010'),
    });
    await moveWorkflow(h.ctx, `${DIR}/${b}`, 'up');
    expect(names()).toEqual(['001_WB010_Oligo.md', '002_WD090_Design.md', 'README.md']);
    const text = files()[`${DIR}/README.md`];
    expect(text).toContain('\r\n');
    expect(text).not.toMatch(/[^\r]\n/);
    const lines = text.split('\r\n');
    const i = lines.findIndex((l) => l.includes('WB010'));
    expect(lines.slice(i, i + 3)).toEqual(['[ ] [001 WB010 Oligo](./001_WB010_Oligo.md)', '[x] [002 WD090 Design](./002_WD090_Design.md)', '  - 메모']);
  });

  it('refuses with the sync suggestion when the folder and the checklist disagree, and changes nothing', async () => {
    h = modern({ [`${DIR}/004_WT010_Test.labnote.md`]: note('WT010') });
    const before = { ...files() };
    expect(await moveWorkflow(h.ctx, `${DIR}/${B}`, 'down')).toBeUndefined();
    expect(files()).toEqual(before);
    expect(h.notes.at(-1)!.kind).toBe('warn');
    expect(h.notes.at(-1)!.message).toContain('004_WT010_Test.labnote.md');
    expect(h.noteOpts.at(-1)!.action?.label).toBe(h.host.t('Sync workflow checklist with folder'));
  });

  it('refuses when the checklist order differs from the number order', async () => {
    h = createTestHost({
      [`${DIR}/README.labnote.md`]: readme([entry(B), entry(A)]),
      [`${DIR}/${A}`]: note('WD090'),
      [`${DIR}/${B}`]: note('WB010'),
    });
    await moveWorkflow(h.ctx, `${DIR}/${A}`, 'down');
    expect(names()).toEqual([A, B, 'README.labnote.md']);
    expect(h.notes.at(-1)!.kind).toBe('warn');
  });

  it('the first row cannot move up', async () => {
    h = modern();
    const before = { ...files() };
    expect(await moveWorkflow(h.ctx, `${DIR}/${A}`, 'up')).toBeUndefined();
    expect(files()).toEqual(before);
  });

  it('table CSVs follow their notes', async () => {
    h = modern({ [`${DIR}/002_WB010_Oligo.labnote_table1.csv`]: 'a,b\n', [`${DIR}/003_WB020_Clone.labnote_table1.csv`]: 'c,d\n' });
    await moveWorkflow(h.ctx, `${DIR}/${B}`, 'down');
    expect(files()[`${DIR}/003_WB010_Oligo.labnote_table1.csv`]).toBe('a,b\n');
    expect(files()[`${DIR}/002_WB020_Clone.labnote_table1.csv`]).toBe('c,d\n');
  });
});

const byId = (id: string) => (items: PickItem<unknown>[]) => (items.find((i) => (i.value as WorkflowItem).id === id) as PickItem<WorkflowItem>).value;

describe('add after this', () => {
  it('shifts the following Workflows and creates the new one right after the row, then opens it', async () => {
    h = modern();
    h.answer.pick(byId('WD030'));
    h.answer.alias('새것');
    const path = await insertWorkflowAfter(h.ctx, `${DIR}/${A}`);
    expect(path).toMatch(new RegExp(`^${DIR}/002_WD030_.*새것\\.labnote\\.md$`));
    const created = path!.slice(DIR.length + 1);
    expect(names()).toEqual([A, created, '003_WB010_Oligo.labnote.md', '004_WB020_Clone.labnote.md', 'README.labnote.md']);
    const lines = files()[`${DIR}/README.labnote.md`].split('\n').filter((l) => l.startsWith('- ['));
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe('- [x] [WD090 Design](./001_WD090_Design.labnote.md)');
    expect(lines[1]).toContain(`(./${created})`);
    expect(lines[1].startsWith('- [ ] [WD030 ')).toBe(true);
    expect(lines[2]).toBe('- [ ] [WB010 Oligo](./003_WB010_Oligo.labnote.md)');
    expect(lines[3]).toBe('- [x] [WB020 Clone](./004_WB020_Clone.labnote.md)');
    expect(files()['notes/memo.md']).toBe(`[[003_WB010_Oligo.labnote|올리고]] 그리고 [클론](../${DIR}/004_WB020_Clone.labnote.md)\n`);
    expect(h.opened.at(-1)).toBe(path);
  });

  it('when more than two notes would be renumbered it asks first with the list (No: no picker, nothing changes)', async () => {
    h = createTestHost({
      [`${DIR}/README.labnote.md`]: readme([entry(A), entry(B), entry(C), entry(D)]),
      [`${DIR}/${A}`]: note('WD090'),
      [`${DIR}/${B}`]: note('WB010'),
      [`${DIR}/${C}`]: note('WB020'),
      [`${DIR}/${D}`]: note('WT010'),
    });
    const before = { ...files() };
    expect(await insertWorkflowAfter(h.ctx, `${DIR}/${A}`)).toBeUndefined();
    expect(h.asked.confirm).toHaveLength(1);
    expect(h.asked.confirm[0].message).toContain(`${B} → 003_WB010_Oligo.labnote.md`);
    expect(h.asked.confirm[0].message).toContain(`${D} → 005_WT010_Test.labnote.md`);
    expect(h.asked.pick).toHaveLength(0);
    expect(files()).toEqual(before);
    h.answer.confirm(true);
    h.answer.pick(byId('WD030'));
    h.answer.alias('');
    const path = await insertWorkflowAfter(h.ctx, `${DIR}/${A}`);
    expect(path).toMatch(new RegExp(`^${DIR}/002_WD030_`));
    expect(names()).toContain('005_WT010_Test.labnote.md');
  });

  it('closing the picker changes nothing', async () => {
    h = modern();
    const before = { ...files() };
    expect(await insertWorkflowAfter(h.ctx, `${DIR}/${A}`)).toBeUndefined();
    const after = files();
    for (const k of Object.keys(before)) expect(after[k]).toBe(before[k]);
    expect(names()).toEqual([A, B, C, 'README.labnote.md']);
  });

  it('the plain "+ Workflow 추가" no longer reuses 001 in a legacy experiment', async () => {
    const { createWorkflow } = await import('../workflow');
    h = createTestHost({
      [`${DIR}/README.md`]: readme(['[ ] [001 WD090 Design](./001_WD090_Design.md)']),
      [`${DIR}/001_WD090_Design.md`]: note('WD090'),
    });
    h.answer.pick(byId('WD030'));
    h.answer.alias('');
    await createWorkflow(h.ctx, undefined, { experimentDir: DIR });
    expect(names().some((n) => n.startsWith('002_WD030_'))).toBe(true);
  });

  it('the plain add puts the new line after the last legacy line (not at the top), numbered, bare and CRLF like it', async () => {
    const { createWorkflow } = await import('../workflow');
    h = createTestHost({
      [`${DIR}/README.md`]: readme(['[x] [001 WD090 Design](./001_WD090_Design.md)', '[ ] [002 WB010 Oligo](./002_WB010_Oligo.md)'], '\r\n'),
      [`${DIR}/001_WD090_Design.md`]: note('WD090'),
      [`${DIR}/002_WB010_Oligo.md`]: note('WB010'),
    });
    h.answer.pick(byId('WD030'));
    h.answer.alias('');
    await createWorkflow(h.ctx, undefined, { experimentDir: DIR });
    const created = names().find((n) => n.startsWith('003_WD030_'));
    expect(created).toBeDefined();
    const text = files()[`${DIR}/README.md`];
    expect(text).not.toMatch(/[^\r]\n/);
    const lines = text.split('\r\n').filter((l) => /^(- )?\[[ x]\]/.test(l));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('[x] [001 WD090 Design](./001_WD090_Design.md)');
    expect(lines[1]).toBe('[ ] [002 WB010 Oligo](./002_WB010_Oligo.md)');
    expect(lines[2]).toMatch(/^\[ \] \[003 WD030 /);
    expect(lines[2]).toContain(`(./${created!.replace(/ /g, '%20')})`);
  });

  it('add after in a legacy experiment shifts the .md notes, renumbers their labels and inserts a numbered bare CRLF line', async () => {
    const a = '001_WD090_Design.md';
    const b = '002_WB010_Oligo.md';
    h = createTestHost({
      [`${DIR}/README.md`]: readme([`[x] [001 WD090 Design](./${a})`, `[ ] [002 WB010 Oligo](./${b})`], '\r\n'),
      [`${DIR}/${a}`]: note('WD090'),
      [`${DIR}/${b}`]: note('WB010'),
      'notes/memo.md': `[올리고](../${DIR}/${b})\n`,
    });
    h.answer.pick(byId('WD030'));
    h.answer.alias('');
    const path = await insertWorkflowAfter(h.ctx, `${DIR}/${a}`);
    expect(path).toMatch(new RegExp(`^${DIR}/002_WD030_`));
    const created = path!.slice(DIR.length + 1);
    expect(names()).toEqual([a, created, '003_WB010_Oligo.md', 'README.md'].sort());
    const text = files()[`${DIR}/README.md`];
    expect(text).not.toMatch(/[^\r]\n/);
    const lines = text.split('\r\n').filter((l) => l.startsWith('['));
    expect(lines[0]).toBe(`[x] [001 WD090 Design](./${a})`);
    expect(lines[1]).toMatch(/^\[ \] \[002 WD030 /);
    expect(lines[2]).toBe('[ ] [003 WB010 Oligo](./003_WB010_Oligo.md)');
    expect(files()['notes/memo.md']).toBe(`[올리고](../${DIR}/003_WB010_Oligo.md)\n`);
  });
});

describe('delete', () => {
  it('lists the notes linking to it, trashes it, removes only its line and keeps the numbers by default', async () => {
    h = modern();
    h.answer.confirm(true);
    h.answer.choose('keep');
    expect(await deleteWorkflow(h.ctx, `${DIR}/${B}`)).toBe(true);
    expect(h.asked.confirm[0].message).toContain('notes/memo.md');
    expect(h.vault.recycleBin.map((e) => e.path)).toContain(`${DIR}/${B}`);
    expect(names()).toEqual([A, C, 'README.labnote.md']);
    const lines = files()[`${DIR}/README.labnote.md`].split('\n').filter((l) => l.startsWith('- ['));
    expect(lines).toEqual(['- [x] [WD090 Design](./001_WD090_Design.labnote.md)', '- [x] [WB020 Clone](./003_WB020_Clone.labnote.md)']);
    expect(h.asked.choose[0].message).toContain(`${C} → 002_WB020_Clone.labnote.md`);
  });

  it('closes the gap only when chosen', async () => {
    h = modern();
    h.answer.confirm(true);
    h.answer.choose('close');
    await deleteWorkflow(h.ctx, `${DIR}/${A}`);
    expect(names()).toEqual(['001_WB010_Oligo.labnote.md', '002_WB020_Clone.labnote.md', 'README.labnote.md']);
    const lines = files()[`${DIR}/README.labnote.md`].split('\n').filter((l) => l.startsWith('- ['));
    expect(lines).toEqual(['- [ ] [WB010 Oligo](./001_WB010_Oligo.labnote.md)', '- [x] [WB020 Clone](./002_WB020_Clone.labnote.md)']);
    expect(files()['notes/memo.md']).toBe(`[[001_WB010_Oligo.labnote|올리고]] 그리고 [클론](../${DIR}/002_WB020_Clone.labnote.md)\n`);
  });

  it('cancel keeps everything', async () => {
    h = modern();
    const before = { ...files() };
    expect(await deleteWorkflow(h.ctx, `${DIR}/${B}`)).toBe(false);
    expect(files()).toEqual(before);
  });

  it('removes a legacy bare CRLF line from README.md', async () => {
    const a = '001_WD090_Design.md';
    const b = '002_WB010_Oligo.md';
    h = createTestHost({
      [`${DIR}/README.md`]: readme([`[x] [001 WD090 Design](./${a})`, `[ ] [002 WB010 Oligo](./${b})`], '\r\n'),
      [`${DIR}/${a}`]: note('WD090'),
      [`${DIR}/${b}`]: note('WB010'),
    });
    h.answer.confirm(true);
    await deleteWorkflow(h.ctx, `${DIR}/${b}`);
    const text = files()[`${DIR}/README.md`];
    expect(text).not.toContain('WB010');
    expect(text).toContain(`[x] [001 WD090 Design](./${a})\r\n`);
  });

  it('closing the gap in a legacy experiment renumbers the .md files and their NNN labels', async () => {
    const a = '001_WD090_Design.md';
    const b = '002_WB010_Oligo.md';
    const c = '003_WB020_Clone.md';
    h = createTestHost({
      [`${DIR}/README.md`]: readme([`[x] [001 WD090 Design](./${a})`, `[ ] [002 WB010 Oligo](./${b})`, `[x] [003 WB020 Clone](./${c})`], '\r\n'),
      [`${DIR}/${a}`]: note('WD090'),
      [`${DIR}/${b}`]: note('WB010'),
      [`${DIR}/${c}`]: note('WB020'),
    });
    h.answer.confirm(true);
    h.answer.choose('close');
    await deleteWorkflow(h.ctx, `${DIR}/${a}`);
    expect(names()).toEqual(['001_WB010_Oligo.md', '002_WB020_Clone.md', 'README.md']);
    const lines = files()[`${DIR}/README.md`].split('\r\n').filter((l) => l.startsWith('['));
    expect(lines).toEqual(['[ ] [001 WB010 Oligo](./001_WB010_Oligo.md)', '[x] [002 WB020 Clone](./002_WB020_Clone.md)']);
  });
});

describe('sample registry sources', () => {
  const offs: Array<() => void> = [];
  afterEach(() => {
    for (const off of offs.splice(0)) off();
  });

  it('a swap renames the Local registry sources without crossing the two names', async () => {
    const { samples } = await import('../../../samples/sampleStore');
    const { wireSampleFollowUps } = await import('../../../samples/followUps');
    const { createSampleEnv } = await import('../../../samples/env');
    const LOCAL = `${DIR}/resources/labsamples`;
    h = modern({
      [`${DIR}/README.labnote.md`]: readme([entry(A, true), entry(B), entry(C, true)]).replace('status: in-progress', 'status: in-progress\nsample_tracking: yes'),
      [`${LOCAL}/DNA.json`]: JSON.stringify({
        'DNA-1': { type: 'DNA', alias: 'p1', descriptions: ['x'], sources: [B] },
        'DNA-2': { type: 'DNA', alias: 'p2', descriptions: ['y'], sources: [C, A] },
      }),
    });
    samples.resetForTest();
    samples.configure(h.host.fs, h.ctx.settings);
    offs.push(wireSampleFollowUps(() => createSampleEnv(h.ctx)));
    offs.push(() => samples.resetForTest());
    await moveWorkflow(h.ctx, `${DIR}/${B}`, 'down');
    await vi.waitFor(() => expect(JSON.parse(files()[`${LOCAL}/DNA.json`])['DNA-1'].sources).toEqual(['003_WB010_Oligo.labnote.md']));
    await new Promise((r) => setTimeout(r, 50));
    const json = JSON.parse(files()[`${LOCAL}/DNA.json`]);
    expect(json['DNA-1'].sources).toEqual(['003_WB010_Oligo.labnote.md']);
    expect(json['DNA-2'].sources).toEqual(['002_WB020_Clone.labnote.md', A]);
  });
});
