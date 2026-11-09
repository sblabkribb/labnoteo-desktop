// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { createWorkflowContent } from '@labnoteo/core/lib/workflowStructure';
import { hasRecordedResults } from '@labnoteo/core';
import { setLang } from '../../i18n/lang';
import { catalogs, t } from '../../i18n/t';
import { createTestHost, type TestHost } from '../../labnote/__tests__/testHost';
import { closeAllDialogs, currentDialog } from '../../labnote/host/dialogStore';
import { appCommands, clearAppCommandsForTest, registerAllAppCommands } from '../../editor/commands/appCommands';
import { cancelAllRequests, NetError, type ListenFn, type NetError as NetErrorT } from '../../integrations/netIpc';
import { cancelProgress, useProgress } from '../../integrations/progressStore';
import { fakeInvoke, netError } from '../../integrations/__tests__/fakeNet';
import { isFailedNote, runNotesFromDesign, safeTitle } from '../notesFromDesign';

const DIR = 'labnote/001_단백질_발현';
const README_PATH = `${DIR}/README.labnote.md`;

function readme(title = '단백질 발현'): string {
  return [
    '---',
    `title: ${title}`,
    "author: '김연구'",
    'status: in-progress',
    'created_date: 2026-01-01',
    'last_updated_date: 2026-01-01',
    '---',
    '',
    '## 🗂️ Related Workflows',
    '',
    '',
    '## Summary and Discussion',
    '',
  ].join('\n');
}

const checklistLines = (text: string) => text.split('\n').filter((l) => /^\s*- \[[ x]\] /.test(l));

function uoNode(id: string) {
  return {
    id,
    type: 'uo_hardware',
    uo_id: 'UHW010',
    uo_name: 'Liquid Handling',
    label: 'LH',
    catalog_id: 'UHW010',
    data: { input: '', output: '', equipment: '', method_hint: '', note_markdown: 'never-sent' },
  };
}

function serviceNode(id: string, workflowId: string, catalogId: string | null, name: string) {
  return {
    id,
    workflow_id: workflowId,
    catalog_id: catalogId,
    catalog_name: name,
    domain: 'build',
    data: { snapshot: { nodes: [uoNode('s1')], edges: [] } },
  };
}

function design(opts: { saved?: Array<Record<string, unknown>>; n1?: ReturnType<typeof serviceNode> } = {}) {
  const nodes: unknown[] = [opts.n1 ?? serviceNode('n1', 'WB030', 'WB030', 'PCR'), serviceNode('n2', 'WT010', 'WT010', 'Assay')];
  if (opts.saved) nodes.push({ id: 'pipeline-notes', data: { kind: 'note', snapshot: { workflow_notes: opts.saved } } });
  return { nodes, edges: [] };
}

const SERVICES = [{ id: 'svc1', code: 'SVC-1', name: 'Design A', current_version_number: 3, has_draft: false, workflow_count: 2 }];

const wf = (workflow_id: string, workflow_name: string, markdown: string, group_node_id = '') => ({
  group_node_id,
  workflow_id,
  workflow_name,
  markdown,
});

interface Setup {
  th: TestHost;
  net: ReturnType<typeof fakeInvoke>;
  listen: ListenFn;
  root: { value: string };
}

type Emit = (message: string) => void;

function setup(
  opts: {
    files?: Record<string, string>;
    services?: unknown;
    design?: unknown;
    generate?: (args: Record<string, unknown>, emit: Emit, s: Setup) => unknown;
    fail?: NetErrorT;
    active?: string | null;
  } = {},
): Setup {
  const th = createTestHost(opts.files ?? { [README_PATH]: readme() });
  if (opts.active !== null) th.setActive(opts.active ?? README_PATH);
  const root = { value: 'C:/fake-vault' };
  const handlers: Array<(e: { event: string; payload: unknown }) => void> = [];
  const listen = (async (_event: string, handler: (e: { event: string; payload: unknown }) => void) => {
    handlers.push(handler);
    return () => {
      const i = handlers.indexOf(handler);
      if (i >= 0) handlers.splice(i, 1);
    };
  }) as unknown as ListenFn;
  const s = {} as Setup;
  const net = fakeInvoke({
    vault_current: () => ({ root: root.value }),
    net_cancel: () => true,
    bfw_request: (a) => {
      if (a.path === '/api/services') return opts.services ?? SERVICES;
      if (a.path === '/api/services/svc1/current-design') return opts.design ?? design();
      throw netError('forbiddenPath');
    },
    bfw_generate_notes: (a) => {
      if (opts.fail) throw opts.fail;
      const emit: Emit = (message) => {
        for (const h of [...handlers]) h({ event: 'bfworkflow://notes', payload: { requestId: a.requestId, step: 'split', message } });
      };
      return opts.generate ? opts.generate(a, emit, s) : { workflows: [] };
    },
  });
  Object.assign(s, { th, net, listen, root });
  return s;
}

const run = (s: Setup) => runNotesFromDesign(s.th.ctx, s.net.invoke, s.listen);
const files = (s: Setup) => s.th.vault.files();
const cmds = (s: Setup) => s.net.calls.map(([c]) => c);
/** The service pick answers the first service. */
const pickService = (items: Array<{ value: unknown }>) => items[0].value;

beforeEach(() => setLang('en'));
afterEach(() => {
  closeAllDialogs();
  clearAppCommandsForTest();
});

describe('bfworkflow: Create notes from a design', () => {
  it('uses saved notes without calling generation', async () => {
    const s = setup({ design: design({ saved: [wf('WB030', 'PCR', '# saved', 'wf-group-n1')] }) });
    s.th.answer.pick(pickService, 'saved');
    await run(s);
    expect(cmds(s)).not.toContain('bfw_generate_notes');
    expect(s.th.asked.pick[1].items.map((i) => i.label)).toEqual([t('bfw.useSaved'), t('bfw.generate')]);
    expect(files(s)[`${DIR}/001_WB030_PCR.labnote.md`]).toBe('# saved');
    expect(s.th.opened).toEqual([`${DIR}/001_WB030_PCR.labnote.md`]);
    expect(s.th.notes).toContainEqual({ kind: 'info', message: t('bfw.notesWritten', 1, DIR) });
  });

  it('generate streams progress lines and writes one file per workflow', async () => {
    let lines: readonly string[] | undefined;
    const s = setup({
      generate: (_a, emit) => {
        emit('Splitting workflows');
        const spec = currentDialog()?.spec as { kind: string; id: number };
        expect(spec.kind).toBe('progress');
        lines = renderHook(() => useProgress(spec.id)).result.current?.lines;
        return { workflows: [wf('WB030', 'PCR', '# pcr', 'wf-group-n1'), wf('WT010', 'Assay', '# assay', 'wf-group-n2')] };
      },
    });
    s.th.answer.pick(pickService);
    await run(s);
    expect(lines).toEqual(['Splitting workflows']);
    expect(files(s)[`${DIR}/001_WB030_PCR.labnote.md`]).toBe('# pcr');
    expect(files(s)[`${DIR}/002_WT010_Assay.labnote.md`]).toBe('# assay');
    const readmeLines = checklistLines(files(s)[README_PATH]);
    expect(readmeLines).toHaveLength(2);
    expect(readmeLines[0]).toContain('001_WB030_PCR.labnote.md');
    expect(readmeLines[1]).toContain('002_WT010_Assay.labnote.md');
    expect(s.th.refreshes()).toBe(1);
    expect(s.th.opened).toEqual([`${DIR}/001_WB030_PCR.labnote.md`]);
    expect(s.th.notes).toEqual([{ kind: 'info', message: t('bfw.notesWritten', 2, DIR) }]);
  });

  it('an existing workflow note is never overwritten without a destructive confirm', async () => {
    const existing = `${DIR}/001_WB030_PCR.labnote.md`;
    const orig = createWorkflowContent({ id: 'WB030', name: 'PCR', description: '' }, '김연구');
    expect(hasRecordedResults(orig)).toBe(false);
    const gen = () => ({ workflows: [wf('WB030', 'PCR', '# new', 'wf-group-n1')] });
    const filesWith = () => ({ [README_PATH]: readme(), [existing]: orig });

    // replace, then No
    let s = setup({ files: filesWith(), generate: gen });
    s.th.answer.pick(pickService, 'replace');
    await run(s);
    expect(s.th.asked.pick[1].opts?.placeholder).toBe(t('bfw.exists', '001_WB030_PCR.labnote.md'));
    expect(s.th.asked.pick[1].items.map((i) => i.value)).toEqual(['replace', 'new', 'skip']);
    expect(s.th.asked.confirm).toHaveLength(1);
    expect(s.th.asked.confirm[0].message).toBe(t('bfw.replaceConfirm', '001_WB030_PCR.labnote.md'));
    expect(s.th.asked.confirm[0].opts).toMatchObject({ confirmLabel: t('bfw.replace'), destructive: true });
    expect(files(s)[existing]).toBe(orig);
    expect(checklistLines(files(s)[README_PATH])).toHaveLength(0);
    expect(Object.keys(files(s)).some((p) => p.includes('002_WB030'))).toBe(false);

    // replace, then Yes
    s = setup({ files: filesWith(), generate: gen });
    s.th.answer.pick(pickService, 'replace');
    s.th.answer.confirm(true);
    await run(s);
    expect(files(s)[existing]).toBe('# new');
    expect(Object.keys(files(s)).some((p) => p.includes('002_WB030'))).toBe(false);

    // skip
    s = setup({ files: filesWith(), generate: gen });
    s.th.answer.pick(pickService, 'skip');
    await run(s);
    expect(files(s)).toEqual(filesWith());
    expect(s.th.asked.confirm).toHaveLength(0);

    // Escape is skip
    s = setup({ files: filesWith(), generate: gen });
    s.th.answer.pick(pickService);
    await run(s);
    expect(files(s)).toEqual(filesWith());

    // new numbered note
    s = setup({ files: filesWith(), generate: gen });
    s.th.answer.pick(pickService, 'new');
    await run(s);
    expect(files(s)[existing]).toBe(orig);
    expect(files(s)[`${DIR}/002_WB030_PCR.labnote.md`]).toBe('# new');
  });

  it('replace is not offered for a note with recorded results', async () => {
    const existing = `${DIR}/001_WB030_PCR.labnote.md`;
    const s = setup({
      files: { [README_PATH]: readme(), [existing]: 'orig' },
      generate: () => ({ workflows: [wf('WB030', 'PCR', '# new')] }),
    });
    s.th.answer.pick(pickService);
    await run(s);
    expect(s.th.asked.pick[1].items.map((i) => i.value)).toEqual(['new', 'skip']);
    expect(files(s)[existing]).toBe('orig');
  });

  it('two results with the same workflow id never overwrite each other', async () => {
    const s = setup({ generate: () => ({ workflows: [wf('WB030', 'PCR', '# a'), wf('WB030', 'PCR', '# b')] }) });
    s.th.answer.pick(pickService, 'skip');
    await run(s);
    expect(files(s)[`${DIR}/001_WB030_PCR.labnote.md`]).toBe('# a');
    expect(s.th.asked.pick[1].opts?.placeholder).toBe(t('bfw.exists', '001_WB030_PCR.labnote.md'));
    expect(Object.keys(files(s)).filter((p) => p.includes('_WB030_'))).toHaveLength(1);
  });

  it('a failed placeholder entry is skipped and reported', async () => {
    const s = setup({
      generate: () => ({
        workflows: [
          wf('WB030', 'PCR', '# ok'),
          wf('WT010', 'Assay', '> **WT010** (Assay): 노트 생성 중 오류가 발생했습니다. 다시 시도해 주세요.'),
        ],
      }),
    });
    s.th.answer.pick(pickService);
    await run(s);
    expect(Object.keys(files(s)).filter((p) => p.endsWith('.labnote.md') && p !== README_PATH)).toEqual([
      `${DIR}/001_WB030_PCR.labnote.md`,
    ]);
    expect(checklistLines(files(s)[README_PATH])).toHaveLength(1);
    expect(s.th.notes).toContainEqual({ kind: 'warn', message: t('bfw.notesFailed', 'WT010') });
  });

  it('a workflow_id with / or .. is skipped and nothing is written', async () => {
    const s = setup({ generate: () => ({ workflows: [wf('x/../../../Other_exp/001_WB010', 'Evil', '# evil')] }) });
    const write = vi.spyOn(s.th.host.fs, 'write');
    const before = files(s);
    s.th.answer.pick(pickService);
    await run(s);
    expect(write).not.toHaveBeenCalled();
    expect(files(s)).toEqual(before);
    expect(s.th.notes).toEqual([{ kind: 'warn', message: t('bfw.notesUnsafe', 1) }]);
  });

  it('an imported workflow with a UUID id takes the catalog id of its group', async () => {
    const s = setup({
      design: design({ n1: serviceNode('n1', '5f0c2a9e-1111-2222-3333-444455556666', 'WB030', 'PCR') }),
      generate: () => ({ workflows: [wf('5f0c2a9e-1111-2222-3333-444455556666', 'PCR mix', '# x', 'wf-group-n1')] }),
    });
    s.th.answer.pick(pickService);
    await run(s);
    expect(files(s)[`${DIR}/001_WB030_PCR_mix.labnote.md`]).toBe('# x');
  });

  it('a newline in workflow_name does not add README lines', async () => {
    const s = setup({ generate: () => ({ workflows: [wf('WB030', 'PCR\n- [ ] injected', '# x')] }) });
    s.th.answer.pick(pickService);
    await run(s);
    const text = files(s)[README_PATH];
    const lines = checklistLines(text);
    expect(lines).toHaveLength(1);
    expect(text.split('\n').some((l) => l.trim().startsWith('- [ ] injected'))).toBe(false);
    expect(safeTitle('PCR\n- [ ] injected')).toBe('PCR - [ ] injected');
    expect(safeTitle(`${'가'.repeat(250)}`)).toHaveLength(200);
    expect(safeTitle('a\u0000\tb\r\nc')).toBe('a b c');
    const sep = (code: number) => String.fromCharCode(code);
    expect(safeTitle(`a${sep(0x2028)}b${sep(0x2029)}c${sep(0x85)}d`)).toBe('a b c d');
    expect(safeTitle(42)).toBe('');
  });

  it('a vault switch during generation writes nothing', async () => {
    const s = setup({
      generate: (_a, _emit, me) => {
        void cancelAllRequests(me.net.invoke);
        me.root.value = 'C:/other-vault';
        return new Promise(() => undefined);
      },
    });
    const write = vi.spyOn(s.th.host.fs, 'write');
    s.th.answer.pick(pickService);
    await run(s);
    expect(write).not.toHaveBeenCalled();
    expect(s.th.notes).toEqual([]);
  });

  it('cancel stops generation and writes nothing', async () => {
    const s = setup({
      generate: () => {
        const spec = currentDialog()?.spec as { id: number };
        cancelProgress(spec.id);
        return new Promise(() => undefined);
      },
    });
    const write = vi.spyOn(s.th.host.fs, 'write');
    s.th.answer.pick(pickService);
    await run(s);
    const gen = s.net.calls.find(([c]) => c === 'bfw_generate_notes')!;
    await vi.waitFor(() => expect(s.net.calls).toContainEqual(['net_cancel', { requestId: gen[1].requestId }]));
    expect(write).not.toHaveBeenCalled();
    expect(s.th.notes).toEqual([]);
  });

  it('503 llm_key_missing shows the server-key message', async () => {
    const s = setup({ fail: netError('status', { status: 503, body: '{"detail":{"code":"llm_key_missing"}}' }) });
    s.th.answer.pick(pickService);
    await run(s);
    expect(s.th.notes).toEqual([{ kind: 'warn', message: t('bfw.serverNoLlm') }]);
    expect(catalogs.ko['bfw.serverNoLlm']).toBe('bfworkflow 서버에 LLM 키가 없어 노트를 만들 수 없습니다.');
    expect(catalogs.en['bfw.serverNoLlm']).toBe('The bfworkflow server has no LLM key, so it cannot generate notes.');
  });

  it('403 shows the ai-scope message', async () => {
    const s = setup({ fail: netError('status', { status: 403 }) });
    s.th.answer.pick(pickService);
    await run(s);
    expect(s.th.notes).toEqual([{ kind: 'warn', message: t('bfw.noScope', 'ai') }]);
  });

  it('remote and noResult have their own sentences; the raw Rust text never shows', async () => {
    let s = setup({ fail: new NetError('remote', 'LLM failed') });
    s.th.answer.pick(pickService);
    await run(s);
    expect(s.th.notes).toEqual([{ kind: 'warn', message: t('bfw.failed', 'LLM failed') }]);

    s = setup({ fail: netError('noResult') });
    s.th.answer.pick(pickService);
    await run(s);
    expect(s.th.notes).toEqual([{ kind: 'warn', message: t('bfw.noResult') }]);
    expect(catalogs.ko['bfw.noResult']).toBe('노트 생성이 결과 없이 끝났습니다.');

    s = setup({ fail: netError('status', { status: 500 }) });
    s.th.answer.pick(pickService);
    await run(s);
    expect(s.th.notes[0].message).not.toContain('raw-rust-text');
  });

  it('a 403 on the design list names the read scope', async () => {
    const th = createTestHost({ [README_PATH]: readme() });
    th.setActive(README_PATH);
    const net = fakeInvoke({
      vault_current: () => ({ root: 'C:/fake-vault' }),
      bfw_request: () => {
        throw netError('status', { status: 403 });
      },
    });
    await runNotesFromDesign(th.ctx, net.invoke);
    expect(th.notes).toEqual([{ kind: 'warn', message: t('bfw.noScope', 'read') }]);
  });

  it('sends language from the app language and perWorkflow true', async () => {
    setLang('ko');
    const s = setup({ generate: () => ({ workflows: [] }) });
    s.th.answer.pick(pickService);
    await run(s);
    const gen = s.net.calls.find(([c]) => c === 'bfw_generate_notes')![1];
    expect(gen.language).toBe('ko');
    expect(gen.perWorkflow).toBe(true);
    expect(JSON.stringify(gen.design)).not.toContain('note_markdown');
    expect((gen.design as { designType: string }).designType).toBe('service');
  });

  it('with no experiment open it asks for one among the experiment READMEs', async () => {
    const other = 'labnote/002_PCR_실험';
    const s = setup({
      files: { [README_PATH]: readme(), [`${other}/README.labnote.md`]: readme('PCR 실험') },
      active: null,
      generate: () => ({ workflows: [wf('WB030', 'PCR', '# x')] }),
    });
    s.th.answer.pick(pickService, (items: Array<{ value: unknown }>) => items[1].value);
    await run(s);
    const asked = s.th.asked.pick[1];
    expect(asked.items.map((i) => i.value)).toEqual([DIR, other]);
    expect(asked.items.map((i) => i.label)).toEqual(['단백질 발현', 'PCR 실험']);
    expect(files(s)[`${other}/001_WB030_PCR.labnote.md`]).toBe('# x');
    expect(s.th.notes.filter((n) => n.kind === 'warn')).toEqual([]);
  });

  it('with no experiment at all it says to open one and calls no generation', async () => {
    const s = setup({ files: {}, active: null });
    s.th.answer.pick(pickService);
    await run(s);
    expect(cmds(s)).not.toContain('bfw_generate_notes');
    expect(s.th.notes).toEqual([{ kind: 'warn', message: t('bfw.noExperiment') }]);
  });

  it('an unpublished design shows no vnull in the picker', async () => {
    const s = setup({
      services: [
        { id: 'svc1', code: 'code', name: 'Draft design', current_version_number: null, has_draft: true, workflow_count: 2 },
        { id: 'svc2', code: 'C2', name: 'Published', current_version_number: 4, has_draft: false, workflow_count: 1 },
        { id: '../evil', code: 'X', name: 'Evil', current_version_number: 1, workflow_count: 1 },
      ],
    });
    await run(s);
    const items = s.th.asked.pick[0].items;
    expect(items.map((i) => i.label)).toEqual(['Draft design', 'Published']);
    expect(items[0].detail).toBe('code · draft · 2 workflows');
    expect(items[1].detail).toBe('C2 · v4 · 1 workflows');
    expect(s.th.asked.pick[0].opts?.placeholder).toBe(t('bfw.pickDesign'));
    expect(items.every((i) => !String(i.detail).includes('null'))).toBe(true);
  });

  it('the single-note result becomes one entry named after the design', async () => {
    const one = { nodes: [serviceNode('n1', 'WB030', 'WB030', 'PCR')], edges: [] };
    const s = setup({ design: one, generate: () => ({ markdown: '# one' }) });
    s.th.answer.pick(pickService);
    await run(s);
    expect(files(s)[`${DIR}/001_WB030_Design_A.labnote.md`]).toBe('# one');
  });

  it('isFailedNote recognises placeholders only', () => {
    expect(isFailedNote({ workflow_id: 'WT010', markdown: '> **WT010** (Assay): 노트 생성 중 오류가 발생했습니다.\n> 다시' })).toBe(true);
    expect(isFailedNote({ workflow_id: 'WT010', markdown: '> just one quoted line' })).toBe(true);
    expect(isFailedNote({ workflow_id: 'WT010', markdown: '   ' })).toBe(true);
    expect(isFailedNote({ workflow_id: 'WT010', markdown: '# Title\n\n> quote' })).toBe(false);
  });

  it('the command is registered and needs a bfworkflow key', () => {
    registerAllAppCommands();
    const cmd = appCommands().find((c) => c.id === 'app.bfw-notes-from-design')!;
    expect(cmd.nameKey).toBe('cmd.bfwNotesFromDesign');
    expect(catalogs.ko['cmd.bfwNotesFromDesign']).toBe('bfworkflow: 설계에서 노트 만들기');
    expect(catalogs.en['cmd.bfwNotesFromDesign']).toBe('bfworkflow: Create notes from a design');
    expect(cmd.available!(createTestHost().ctx)).toBe(false);
  });

  it('the texts exist in ko and en', () => {
    for (const k of [
      'bfw.pickDesign', 'bfw.draft', 'bfw.workflowCount', 'bfw.useSaved', 'bfw.generate', 'bfw.generating',
      'bfw.noExperiment', 'bfw.pickExperiment', 'bfw.noDesigns', 'bfw.exists', 'bfw.replace', 'bfw.replaceConfirm',
      'bfw.newNumbered', 'bfw.skip', 'bfw.notesWritten', 'bfw.notesFailed', 'bfw.notesUnsafe', 'bfw.serverNoLlm',
      'bfw.noResult',
    ]) {
      expect(catalogs.ko[k], k).toBeTruthy();
      expect(catalogs.en[k], k).toBeTruthy();
    }
  });
});
