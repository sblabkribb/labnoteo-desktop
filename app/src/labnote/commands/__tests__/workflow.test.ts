// @vitest-environment jsdom
import { act } from '@testing-library/react';
import type { PickItem, WorkflowItem } from '@labnoteo/core';
import { getSeoulDateString } from '@labnoteo/core/lib/dateUtils';
import type { EditorHandle } from '../../../editor/Editor';
import { setLang } from '../../../i18n/lang';
import { openNote, registerOpenNote } from '../../openNotes';
import { runCommand } from '../runCommand';
import { createTestHost, type TestHost } from '../../__tests__/testHost';
import { rankPickItems } from '../../port/rankPickItems';
import { ALIAS_BACK } from '../../host/dialogStore';
import { clearCommandsForTest, commandById } from '../registry';
import { registerAllCommands } from '../registerAll';
import { createWorkflow, insertWorkflowOnReadme, isExperimentReadme } from '../workflow';

const DIR = 'labnote/001_단백질_발현';
const README_PATH = `${DIR}/README.labnote.md`;
const TODAY = getSeoulDateString();

/** 실험 README. `section` 이 false 면 Related Workflows 구역이 없다. */
function readme(checklist = '', section = true): string {
  return [
    '---',
    'title: 단백질 발현',
    "author: '김연구'",
    'status: in-progress',
    'created_date: 2026-01-01',
    'last_updated_date: 2026-01-01',
    '---',
    '',
    ...(section ? ['## 🗂️ Related Workflows', '', checklist] : []),
    '## Summary and Discussion',
    '',
  ].join('\n');
}

const byId = (id: string) => (items: PickItem<unknown>[]) => (items.find((i) => (i.value as WorkflowItem).id === id) as PickItem<WorkflowItem>).value;

let h: TestHost;

beforeEach(() => setLang('ko'));

afterEach(() => {
  // 한국어 화면에서는 모든 알림이 한국어다
  for (const n of h?.notes ?? []) expect(n.message).toMatch(/[가-힣]/);
  h?.cleanup();
});

describe('create-workflow', () => {
  it("the first create-workflow seeds resources/workflows/*.json and the picker is non-empty (the '' root guard)", async () => {
    h = createTestHost({ [README_PATH]: readme() });
    h.setActive(README_PATH);
    await createWorkflow(h.ctx); // 고르기를 닫는다
    const files = Object.keys(h.vault.files()).filter((p) => p.startsWith('resources/workflows/'));
    expect(files.sort()).toEqual(
      ['resources/workflows/unitoperations_hw_en.json', 'resources/workflows/unitoperations_sw_en.json', 'resources/workflows/workflows_en.json'].sort(),
    );
    expect(h.asked.pick).toHaveLength(1);
    expect(h.asked.pick[0].items.length).toBeGreaterThan(10);
    expect(h.asked.pick[0].opts?.title).toBe('Workflow 추가') // the header button's name (one vocabulary);
    // 처음 채우는 것은 조용하다
    expect(h.notes).toEqual([]);
  });

  it('the picker shows the Korean name and finds an item by Korean keyword in ko', async () => {
    h = createTestHost({ [README_PATH]: readme() });
    h.setActive(README_PATH);
    await createWorkflow(h.ctx);
    const items = h.asked.pick[0].items;
    const wd030 = items.find((i) => (i.value as WorkflowItem).id === 'WD030')!;
    expect(wd030.label).toBe('WD030: Growth Media Design');
    expect(wd030.description).toBe('배지 설계 · Design');
    expect((rankPickItems(items, '배지 설계')[0].value as WorkflowItem).id).toBe('WD030');
    expect((rankPickItems(items, '크리스퍼')[0].value as WorkflowItem).id).toBe('WD090');
  });

  it("create-workflow writes NNN_ID_Name_alias.labnote.md with the README experimenter, adds '- [ ] [ID Name alias](./file)' to Related Workflows, stamps the README, opens the note", async () => {
    h = createTestHost({ [README_PATH]: readme() });
    h.setActive(README_PATH);
    h.answer.pick(byId('WD030'));
    h.answer.alias('1차');
    await createWorkflow(h.ctx);
    const fileName = '001_WD030_Growth_Media_Design_1차.labnote.md';
    const path = `${DIR}/${fileName}`;
    const note = h.vault.files()[path];
    expect(note).toBeDefined();
    expect(note).toContain('김연구');
    const text = h.vault.files()[README_PATH];
    expect(text).toContain(`- [ ] [WD030 Growth Media Design 1차](./${fileName})`);
    expect(text).toContain(`last_updated_date: ${TODAY}`);
    expect(h.opened).toEqual([path]);
    expect(h.refreshes()).toBe(1);
    expect(h.notes).toEqual([{ kind: 'info', message: `Workflow가 생성되었습니다: ${fileName}` }]);
    // 별칭 대화상자: 카탈로그 머리와 한국어 안내
    expect(h.asked.alias[0]).toMatchObject({ id: 'WD030', catalogName: 'Growth Media Design', back: true });
    // 제목은 대화상자의 "별칭 (선택)"(UI 재설계 Task 11)
    expect(h.asked.alias[0].title).toBeUndefined();
  });

  it('create-workflow with the README open and dirty registers the entry in the buffer and keeps the unsaved typing', async () => {
    const before = readme();
    h = createTestHost({ [README_PATH]: before }, { autoUpdateLastUpdated: false });
    const m = await h.mount(README_PATH);
    await m.type('저장 안 한 메모\n');
    expect(h.vault.files()[README_PATH]).toBe(before);
    h.answer.pick(byId('WD010'));
    h.answer.alias('');
    await act(() => createWorkflow(h.ctx));
    const buffer = m.view().state.doc.toString();
    expect(buffer).toContain('- [ ] [WD010 General Design of Experiment](./001_WD010_General_Design_of_Experiment.labnote.md)');
    expect(buffer.endsWith('저장 안 한 메모\n')).toBe(true);
    expect(h.vault.files()[README_PATH]).toBe(buffer);
  });

  it("README without the section warns 'noSection' and still creates the file; the README is unchanged on disk", async () => {
    const before = readme('', false);
    h = createTestHost({ [README_PATH]: before });
    h.setActive(README_PATH);
    h.answer.pick(byId('WD010'));
    h.answer.alias('');
    await createWorkflow(h.ctx);
    expect(h.vault.files()[`${DIR}/001_WD010_General_Design_of_Experiment.labnote.md`]).toBeDefined();
    expect(h.vault.files()[README_PATH]).toBe(before);
    expect(h.vault.log.filter((c) => c.cmd === 'vault_modify' && c.args.path === README_PATH)).toEqual([]);
    expect(h.notes.map((n) => n.kind)).toEqual(['info', 'warn']);
    expect(h.notes[1].message).toContain('Related Workflows');
    expect(h.notes[1].message).toContain('폴더와 Workflow 체크리스트 맞추기');
  });

  it('README open and busy: the note is still created, refreshed, opened and announced, with a warning that the README checklist was not updated', async () => {
    const before = readme();
    h = createTestHost({ [README_PATH]: before });
    h.setActive(README_PATH);
    const off = registerOpenNote(README_PATH, { busy: () => true, view: () => undefined, rawText: () => before } as unknown as EditorHandle);
    try {
      h.answer.pick(byId('WD010'));
      h.answer.alias('');
      await runCommand(h.ctx, () => createWorkflow(h.ctx));
    } finally {
      off();
    }
    const path = `${DIR}/001_WD010_General_Design_of_Experiment.labnote.md`;
    expect(h.vault.files()[path]).toBeDefined();
    expect(h.vault.files()[README_PATH]).toBe(before);
    expect(h.refreshes()).toBe(1);
    expect(h.opened).toEqual([path]);
    expect(h.notes.map((n) => n.kind)).toEqual(['info', 'warn']);
    expect(h.notes[0].message).toContain('001_WD010_General_Design_of_Experiment.labnote.md');
    expect(h.notes[1].message).toContain('폴더와 Workflow 체크리스트 맞추기');
    expect(h.notes[1].message).not.toContain('바꾸지 않았습니다');
  });

  it('README open but its save fails: the note is created, refreshed, opened and announced with the same warning', async () => {
    h = createTestHost({ [README_PATH]: readme() });
    await h.mount(README_PATH);
    const real = openNote(README_PATH)!;
    const handle = { ...real, flush: () => Promise.resolve(false) } as EditorHandle;
    const off = registerOpenNote(README_PATH, handle);
    try {
      h.answer.pick(byId('WD010'));
      h.answer.alias('');
      await act(() => runCommand(h.ctx, () => createWorkflow(h.ctx)));
    } finally {
      off();
    }
    const path = `${DIR}/001_WD010_General_Design_of_Experiment.labnote.md`;
    expect(h.vault.files()[path]).toBeDefined();
    expect(h.refreshes()).toBe(1);
    expect(h.opened).toEqual([path]);
    expect(h.notes.map((n) => n.kind)).toEqual(['info', 'warn']);
    expect(h.notes[1].message).toContain('폴더와 Workflow 체크리스트 맞추기');
  });

  it('the alias hint flags a same-alias twin', async () => {
    const twin = '001_WD010_General_Design_of_Experiment_A.labnote.md';
    h = createTestHost({
      [README_PATH]: readme(`- [ ] [[${twin.slice(0, -'.md'.length)}|WD010 General Design of Experiment A]]\n`),
      [`${DIR}/${twin}`]: 'x\n',
    });
    h.setActive(README_PATH);
    h.answer.pick(byId('WD010'));
    let hint: { text: string; warn?: boolean } | undefined;
    let other: { text: string; warn?: boolean } | undefined;
    h.answer.alias((opts) => {
      hint = opts.hint?.('A');
      other = opts.hint?.('B');
      return undefined;
    });
    await createWorkflow(h.ctx);
    expect(hint?.warn).toBe(true);
    expect(hint?.text).toContain(twin);
    expect(other?.text ?? '').not.toContain(twin);
    expect(Object.keys(h.vault.files()).filter((p) => p.startsWith(`${DIR}/`))).toHaveLength(2); // 닫았으니 만들지 않았다
  });

  it('the character counter shows only within 10 characters of the file-name budget', async () => {
    h = createTestHost({ [README_PATH]: readme() });
    h.setActive(README_PATH);
    h.answer.pick(byId('WD030'));
    let short: { text: string; warn?: boolean } | undefined;
    let near: { text: string; warn?: boolean } | undefined;
    h.answer.alias((opts) => {
      short = opts.hint?.('A');
      near = opts.hint?.('x'.repeat(200));
      return undefined;
    });
    await createWorkflow(h.ctx);
    expect(short).toBeUndefined();
    expect(near?.warn).toBe(true);
    expect(near?.text).toMatch(/\d+\/\d+/);
  });

  it('Back on the alias step reopens the picker with the previous query; a pick from the catalog has no Back', async () => {
    h = createTestHost({ [README_PATH]: readme() });
    h.setActive(README_PATH);
    h.answer.pick((items, opts) => {
      opts?.onQuery?.('배지');
      return byId('WD030')(items);
    }, byId('WD010'));
    h.answer.alias(ALIAS_BACK, '');
    await createWorkflow(h.ctx);
    expect(h.asked.pick).toHaveLength(2);
    expect(h.asked.pick[0].opts).toMatchObject({ catalog: true, recentKey: 'workflow', query: '' });
    expect(h.asked.pick[1].opts?.query).toBe('배지');
    expect(h.asked.alias.map((a) => a.id)).toEqual(['WD030', 'WD010']);
    expect(Object.keys(h.vault.files()).some((p) => p.includes('_WD010_'))).toBe(true);
    expect(Object.keys(h.vault.files()).some((p) => p.includes('_WD030_'))).toBe(false);
  });

  it("'#' in the alias is refused by validate", async () => {
    h = createTestHost({ [README_PATH]: readme() });
    h.setActive(README_PATH);
    h.answer.pick(byId('WD010'));
    let refusal: string | null | undefined;
    let fine: string | null | undefined;
    h.answer.alias((opts) => {
      refusal = opts.validate?.('A#1');
      fine = opts.validate?.('A1');
      return undefined;
    });
    await createWorkflow(h.ctx);
    expect(refusal).toMatch(/[가-힣]/);
    expect(refusal).toContain('#');
    expect(fine).toBeNull();
  });

  it('with a target, the workflow goes into that experiment, not the open note', async () => {
    const OTHER = 'labnote/002_다른_실험';
    h = createTestHost({ [README_PATH]: readme(), [`${OTHER}/README.labnote.md`]: readme() });
    h.setActive(`${OTHER}/README.labnote.md`);
    h.answer.pick(byId('WD030'));
    h.answer.alias('');
    await createWorkflow(h.ctx, undefined, { experimentDir: DIR });
    expect(h.vault.files()[`${DIR}/001_WD030_Growth_Media_Design.labnote.md`]).toBeDefined();
    expect(Object.keys(h.vault.files()).filter((p) => p.startsWith(OTHER))).toEqual([`${OTHER}/README.labnote.md`]);
  });

  it("outside an experiment: 'Open a lab note first.'", async () => {
    h = createTestHost({ 'notes/a.md': 'x\n' });
    h.setActive('notes/a.md');
    await createWorkflow(h.ctx);
    expect(h.asked.pick).toEqual([]);
    expect(h.notes).toEqual([{ kind: 'warn', message: h.host.t('Open a lab note first.') }]);
    expect(h.notes[0].message).not.toBe('Open a lab note first.');
  });
});

describe('Insert workflow (README editor menu)', () => {
  it('Insert workflow on the README creates and registers, and inserts nothing at the cursor', async () => {
    const before = readme();
    h = createTestHost({ [README_PATH]: before }, { autoUpdateLastUpdated: false });
    const m = await h.mount(README_PATH);
    // 커서를 본문 맨 앞에 둔다
    act(() => m.view().dispatch({ selection: { anchor: before.indexOf('## Summary') } }));
    h.answer.pick(byId('WD010'));
    h.answer.alias('');
    await act(() => insertWorkflowOnReadme(h.ctx));
    const link = '[WD010 General Design of Experiment](./001_WD010_General_Design_of_Experiment.labnote.md)';
    const buffer = m.view().state.doc.toString();
    expect(buffer.split(link)).toHaveLength(2); // 체크리스트 항목 하나뿐
    expect(buffer).toContain(`- [ ] ${link}`);
    expect(buffer.slice(buffer.indexOf('## Summary'))).toBe(before.slice(before.indexOf('## Summary')));
    expect(h.vault.files()[README_PATH]).toBe(buffer);
    expect(h.vault.files()[`${DIR}/001_WD010_General_Design_of_Experiment.labnote.md`]).toBeDefined();
    expect(h.opened).toEqual([]); // README 에 머문다
    expect(h.notes[0]).toEqual({ kind: 'info', message: 'Workflow가 생성되었습니다: 001_WD010_General_Design_of_Experiment.labnote.md' });
  });

  it('isExperimentReadme is true only for an experiment folder README', () => {
    h = createTestHost();
    expect(isExperimentReadme(README_PATH)).toBe(true);
    expect(isExperimentReadme(`${DIR}/001_WD010_x.labnote.md`)).toBe(false);
    expect(isExperimentReadme('notes/README.labnote.md')).toBe(false);
    expect(isExperimentReadme(undefined)).toBe(false);
  });

  it('isExperimentReadme folds case like NTFS', () => {
    h = createTestHost();
    expect(isExperimentReadme(`${DIR}/readme.LABNOTE.md`)).toBe(true);
  });
});

describe('registration', () => {
  it('registerAllCommands registers create-workflow, sync-workflow-checklist and update-catalogs with the plugin names', () => {
    h = createTestHost();
    clearCommandsForTest();
    registerAllCommands();
    expect(['create-workflow', 'sync-workflow-checklist', 'update-catalogs'].map((id) => commandById(id)?.nameKey)).toEqual([
      'Create workflow',
      'Sync workflow checklist with folder',
      'Update catalogs',
    ]);
    clearCommandsForTest();
  });
});
