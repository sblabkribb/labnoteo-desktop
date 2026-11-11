import { describe, expect, it } from 'vitest';
import { MemFileSystem, previewTool, runTool, type LabnoteFs, type ToolDef } from '@labnoteo/core';
import { setLang } from '../../../i18n/lang';
import type { SearchResults } from '../../../search/indexApi';
import { appTools, scopeErrorText } from '../appTools';
import { contextTools, type ScopedToolContext } from '../contextTools';
import { scopeGate, type Scope } from '../scope';
import { PLANNING_RULES } from '../planningPrompt';
import { KOREAN_TERMS_INSTRUCTION } from '../../port/aiCommon';
import { PLANNING_SECTIONS_HW } from '../chain';
import {
  buildFixtureVault,
  EXP_A,
  EXP_AB,
  EXP_MAIN,
  EXP_OTHER,
  EXP_STRESS,
  FIXTURE_EXPERIMENTS,
  GLOBAL_SAMPLE_FOLDER,
  LEAK_SAMPLE_ID,
  LEAK_TEXT,
  MAIN_FILES,
  TITLE_MAIN,
  TITLE_OTHER,
} from './fixtures';

const scopeOf = (folder: string): Scope => ({ folder, explicit: false, named: [] });

/** `fs` with every path passed to read recorded. */
function spyFs(inner: LabnoteFs): { fs: LabnoteFs; reads: string[] } {
  const reads: string[] = [];
  const fs = new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === 'read' && typeof value === 'function') {
        return (path: string) => {
          reads.push(path);
          return value.call(target, path);
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { fs, reads };
}

async function ctxOf(opts: Partial<ScopedToolContext> & { files?: LabnoteFs } = {}): Promise<ScopedToolContext> {
  const { files, ...rest } = opts;
  return {
    fs: files ?? (await buildFixtureVault()),
    workspaceRoot: '.',
    globalSampleFolder: GLOBAL_SAMPLE_FOLDER,
    experiments: async () => FIXTURE_EXPERIMENTS.map(e => ({ ...e })),
    ...rest,
  };
}

const tools = contextTools();
const run = (ctx: ScopedToolContext, name: string, args: Record<string, unknown>) => runTool(tools, name, ctx, args);
const dataOf = (res: { ok: boolean; data?: unknown; error?: string }) => {
  expect(res.error).toBeUndefined();
  expect(res.ok).toBe(true);
  return res.data as Record<string, any>;
};

describe('contextTools', () => {
  it('are list_experiment, search_experiment, read_note and the two context tools, all read-only', () => {
    expect(tools.map(t => t.name)).toEqual([
      'list_experiment',
      'search_experiment',
      'read_note',
      'get_experiment_context',
      'get_unit_operation_context',
    ]);
    for (const t of tools) expect(t.mutates).toBe(false);
    for (const t of appTools({ scope: scopeOf(EXP_MAIN) }).filter(t => tools.some(c => c.name === t.name))) {
      expect(t.mutates).toBe(false);
    }
  });

  it('have the §9 schemas', () => {
    const byName = Object.fromEntries(tools.map(t => [t.name, t.inputSchema]));
    expect(Object.keys(byName.list_experiment.properties)).toEqual(['experiment', 'depth']);
    expect(byName.search_experiment.required).toEqual(['query']);
    expect(Object.keys(byName.search_experiment.properties)).toEqual(['query', 'experiment', 'limit']);
    expect(byName.read_note.required).toEqual(['path']);
    expect(Object.keys(byName.read_note.properties)).toEqual(['path', 'unitOp', 'section', 'experiment']);
  });
});

describe('list_experiment', () => {
  it('without a scope or an experiment names the experiments only', async () => {
    const ctx = await ctxOf();
    const data = dataOf(await run(ctx, 'list_experiment', {}));
    expect(Object.keys(data)).toEqual(['experiments']);
    expect(data.experiments).toEqual(FIXTURE_EXPERIMENTS.map(e => ({ folder: e.folder, title: e.title })));
  });

  it('with a scope lists workflows, unit ops and issues of that folder only', async () => {
    const ctx = await ctxOf({ scope: scopeOf(EXP_MAIN) });
    const data = dataOf(await run(ctx, 'list_experiment', {}));
    expect(data.folder).toBe(EXP_MAIN);
    expect(data.title).toBe(TITLE_MAIN);
    expect(data.goalExcerpt).toContain('GFP 발현 균주');
    expect(data.workflows[0]).toMatchObject({ path: MAIN_FILES.cloning, listed: true, done: true, legacy: false });
    expect(data.workflows[0].unitOps[0]).toEqual({
      index: 0,
      heading: '### [UHW010 PCR] 증폭',
      opId: 'UHW010',
      inputIds: ['DNA-1'],
      outputIds: ['DNA-2'],
    });
    expect(data.issues).toContainEqual(expect.objectContaining({ code: 'brokenLink' }));
    const json = JSON.stringify(data);
    expect(json).not.toContain(EXP_OTHER);
    expect(json).not.toContain(LEAK_TEXT);
  });

  it('depth "workflows" leaves the unit ops out', async () => {
    const ctx = await ctxOf({ scope: scopeOf(EXP_MAIN) });
    const data = dataOf(await run(ctx, 'list_experiment', { depth: 'workflows' }));
    expect(data.workflows[0].unitOps).toBeUndefined();
    expect(data.workflows[0].path).toBe(MAIN_FILES.cloning);
  });

  it('refuses an experiment the user did not name', async () => {
    const ctx = await ctxOf({ scope: scopeOf(EXP_MAIN), allowedFolders: new Set() });
    const res = await run(ctx, 'list_experiment', { experiment: '003' });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('outOfScope');
    expect(res.params).toEqual(['003', EXP_MAIN]);
  });

  it('accepts an experiment named in the user message', async () => {
    const allowedFolders = scopeGate(`${TITLE_OTHER} 실험과 비교해 줘`, FIXTURE_EXPERIMENTS);
    const ctx = await ctxOf({ scope: scopeOf(EXP_MAIN), allowedFolders });
    const data = dataOf(await run(ctx, 'list_experiment', { experiment: '003' }));
    expect(data.folder).toBe(EXP_OTHER);
    expect(data.title).toBe(TITLE_OTHER);
  });

  it('accepts its own experiment by name', async () => {
    const ctx = await ctxOf({ scope: scopeOf(EXP_MAIN), allowedFolders: new Set() });
    expect(dataOf(await run(ctx, 'list_experiment', { experiment: TITLE_MAIN })).folder).toBe(EXP_MAIN);
  });

  it('reports an unknown experiment with its code', async () => {
    const ctx = await ctxOf();
    const res = await run(ctx, 'list_experiment', { experiment: '없는 실험' });
    expect(res).toMatchObject({ ok: false, code: 'unknownExperiment', params: ['없는 실험'] });
  });

  it('without allowedFolders (MCP) any named experiment is explicit', async () => {
    const ctx = await ctxOf();
    expect(dataOf(await run(ctx, 'list_experiment', { experiment: 'Alpha' })).folder).toBe(EXP_A);
  });
});

describe('search_experiment', () => {
  const hit = (path: string) => ({ path, title: path.split('/').pop()!, snippet: 'DNA-10' });

  it('passes the folder prefix and drops hits outside the scope', async () => {
    const calls: Array<[string, string, number]> = [];
    const searchIn = async (query: string, prefix: string, limit: number): Promise<SearchResults> => {
      calls.push([query, prefix, limit]);
      return {
        hits: [hit(`${EXP_A}/001_WD010_Design.labnote.md`), hit(`${EXP_AB}/001_WD010_Design.labnote.md`), hit(`${EXP_OTHER}/x.md`)],
        truncated: false,
      };
    };
    const ctx = await ctxOf({ scope: scopeOf(EXP_A), searchIn });
    const data = dataOf(await run(ctx, 'search_experiment', { query: 'DNA-10' }));
    expect(calls).toEqual([['DNA-10', EXP_A, 20]]);
    expect(data.hits.map((h: { path: string }) => h.path)).toEqual([`${EXP_A}/001_WD010_Design.labnote.md`]);
    expect(data.hits[0].heading).toBe('Output');
    expect(data.truncated).toBe(false);
  });

  it('clamps the limit and needs a two-character query', async () => {
    const calls: number[] = [];
    const searchIn = async (_q: string, _p: string, limit: number): Promise<SearchResults> => {
      calls.push(limit);
      return { hits: [], truncated: false };
    };
    const ctx = await ctxOf({ scope: scopeOf(EXP_A), searchIn });
    await run(ctx, 'search_experiment', { query: 'DNA', limit: 500 });
    expect(calls).toEqual([50]);
    expect((await run(ctx, 'search_experiment', { query: ' D ' })).ok).toBe(false);
  });

  it('falls back to a substring scan of the folder when the index rejects', async () => {
    const searchIn = async (): Promise<SearchResults> => {
      throw new Error('no index');
    };
    const ctx = await ctxOf({ scope: scopeOf(EXP_MAIN), searchIn });
    const data = dataOf(await run(ctx, 'search_experiment', { query: LEAK_TEXT.toLowerCase() }));
    expect(data.hits.map((h: { path: string }) => h.path)).toEqual([MAIN_FILES.cloning]);
    expect(data.hits[0].heading).toBe('Results & Discussions');
    expect(data.hits[0].snippet).toContain(LEAK_TEXT);

    const a = await ctxOf({ scope: scopeOf(EXP_A) });
    const aData = dataOf(await run(a, 'search_experiment', { query: 'DNA-10' }));
    expect(aData.hits.map((h: { path: string }) => h.path)).toEqual([`${EXP_A}/001_WD010_Design.labnote.md`]);
  });

  it('caps the fallback scan at 200 files and skips files over 2 MB', async () => {
    const files: Record<string, string> = { [`${EXP_A}/README.labnote.md`]: '# A\n' };
    for (let i = 0; i < 250; i++) files[`${EXP_A}/notes/n${String(i).padStart(3, '0')}.md`] = `needle ${i}\n`;
    files[`${EXP_A}/big.md`] = `needle\n${'x'.repeat(2 * 1024 * 1024 + 10)}`;
    const { fs, reads } = spyFs(new MemFileSystem(files));
    const ctx = await ctxOf({ files: fs, scope: scopeOf(EXP_A) });
    const data = dataOf(await run(ctx, 'search_experiment', { query: 'needle', limit: 50 }));
    expect(reads.length).toBeLessThanOrEqual(200);
    expect(data.hits.length).toBe(50);
    expect(data.truncated).toBe(true);
    expect(data.hits.some((h: { path: string }) => h.path.endsWith('big.md'))).toBe(false);
  });

  it('needs a scope or an experiment', async () => {
    const ctx = await ctxOf();
    const res = await run(ctx, 'search_experiment', { query: 'DNA' });
    expect(res).toMatchObject({ ok: false, code: 'scopeRequired' });
    expect(res.params).toEqual(FIXTURE_EXPERIMENTS.map(e => e.folder));
  });
});

describe('read_note', () => {
  it('rejects a path outside the scope with outOfScope', async () => {
    const { fs, reads } = spyFs(await buildFixtureVault());
    const ctx = await ctxOf({ files: fs, scope: scopeOf(EXP_MAIN) });
    const other = `${EXP_OTHER}/001_WB010_Cloning.labnote.md`;
    for (const path of [other, `${EXP_MAIN}/../003_정제/001_WB010_Cloning.labnote.md`, `${EXP_A}B/001_WD010_Design.labnote.md`]) {
      const res = await run(ctx, 'read_note', { path });
      expect(res).toMatchObject({ ok: false, code: 'outOfScope', params: [path, EXP_MAIN] });
    }
    expect(reads.filter(p => !p.startsWith(EXP_MAIN))).toEqual([]);
  });

  it('reads a unit-op section, Korean headings included', async () => {
    const ctx = await ctxOf({ scope: scopeOf(EXP_MAIN) });
    const data = dataOf(await run(ctx, 'read_note', { path: MAIN_FILES.cloning, unitOp: 'UHW020', section: 'Input' }));
    expect(data).toMatchObject({ path: MAIN_FILES.cloning, unitOp: '### [UHW020 Gel Purification]', section: '입력', truncated: false });
    expect(data.content.trim()).toBe('- DNA-2');

    const byHeading = dataOf(await run(ctx, 'read_note', { path: MAIN_FILES.cloning, unitOp: '[UHW010 PCR] 증폭', section: 'Output' }));
    expect(byHeading.content.trim()).toBe('- DNA-2 ; PCR product');
  });

  it('reads a whole unit op, or a whole note with its headings', async () => {
    const ctx = await ctxOf({ scope: scopeOf(EXP_MAIN) });
    const uo = dataOf(await run(ctx, 'read_note', { path: MAIN_FILES.expression, unitOp: 'UHW030' }));
    expect(uo.content.startsWith('### [UHW030 Induction]')).toBe(true);
    expect(uo.content).not.toContain('USW010');
    const note = dataOf(await run(ctx, 'read_note', { path: MAIN_FILES.check }));
    expect(note.headings).toContain('### [UHW040 SDS-PAGE]');
    expect(note.content).toContain('Protein-1');
  });

  it('reports a missing unit op or section', async () => {
    const ctx = await ctxOf({ scope: scopeOf(EXP_MAIN) });
    expect((await run(ctx, 'read_note', { path: MAIN_FILES.cloning, unitOp: 'UHW999' })).ok).toBe(false);
    expect((await run(ctx, 'read_note', { path: MAIN_FILES.cloning, unitOp: 'UHW010', section: 'Environment' })).ok).toBe(false);
    expect((await run(ctx, 'read_note', { path: `${EXP_MAIN}/nope.md` })).ok).toBe(false);
  });

  it('truncates at 20000 characters', async () => {
    const vault = await buildFixtureVault();
    await vault.write(`${EXP_MAIN}/long.md`, 'x'.repeat(30000));
    const ctx = await ctxOf({ files: vault, scope: scopeOf(EXP_MAIN) });
    const data = dataOf(await run(ctx, 'read_note', { path: `${EXP_MAIN}/long.md` }));
    expect(data.content.length).toBe(20000);
    expect(data.truncated).toBe(true);
  });

  it('reads a folder the user named, and only that one', async () => {
    const other = `${EXP_OTHER}/001_WB010_Cloning.labnote.md`;
    const ctx = await ctxOf({ scope: scopeOf(EXP_MAIN), allowedFolders: new Set([EXP_OTHER]) });
    expect(dataOf(await run(ctx, 'read_note', { path: other })).content).toContain(LEAK_SAMPLE_ID);
    expect(dataOf(await run(ctx, 'read_note', { path: other, experiment: '003' })).content).toContain(LEAK_SAMPLE_ID);
    const res = await run(ctx, 'read_note', { path: `${EXP_A}/001_WD010_Design.labnote.md` });
    expect(res.code).toBe('outOfScope');
  });
});

describe('appTools', () => {
  const otherNote = `${EXP_OTHER}/001_WB010_Cloning.labnote.md`;
  const find = (list: ToolDef[], name: string) => list.find(t => t.name === name)!;

  it('is the core tools plus the context tools', () => {
    const names = appTools().map(t => t.name);
    expect(names).toContain('update_section');
    expect(names.slice(-5)).toEqual([
      'list_experiment',
      'search_experiment',
      'read_note',
      'get_experiment_context',
      'get_unit_operation_context',
    ]);
  });

  it('scoped, refuses a core documentPath in another experiment before preview or approval', async () => {
    const { fs, reads } = spyFs(await buildFixtureVault());
    const ctx = await ctxOf({ files: fs });
    const list = appTools({ scope: scopeOf(EXP_MAIN) });
    const read = await runTool(list, 'read_section', ctx, { documentPath: otherNote });
    expect(read).toMatchObject({ ok: false, code: 'outOfScope', params: [otherNote, EXP_MAIN] });

    const args = { documentPath: otherNote, heading: 'Input', content: '- x' };
    const preview = await previewTool(find(list, 'update_section'), ctx, args);
    expect(preview).toMatchObject({ code: 'outOfScope', params: [otherNote, EXP_MAIN] });
    const write = await runTool(list, 'update_section', ctx, args);
    expect(write.code).toBe('outOfScope');
    expect(reads.filter(p => p.startsWith(EXP_OTHER))).toEqual([]);

    // A folder documentPath (create_workflow) is checked as a folder.
    const wf = await previewTool(find(list, 'create_workflow'), ctx, { documentPath: EXP_OTHER, workflowId: 'WD010' });
    expect(wf).toMatchObject({ code: 'outOfScope' });

    // In scope: the core tool runs.
    expect((await runTool(list, 'read_section', ctx, { documentPath: MAIN_FILES.check })).ok).toBe(true);
  });

  it('scoped, admits a documentPath in a folder the user named', async () => {
    const ctx = await ctxOf();
    const list = appTools({ scope: scopeOf(EXP_MAIN), allowedFolders: new Set([EXP_OTHER]) });
    expect((await runTool(list, 'read_section', ctx, { documentPath: otherNote })).ok).toBe(true);
  });

  it('scoped, keeps sample lookups to the experiment and the global registry', async () => {
    const ctx = await ctxOf();
    const list = appTools({ scope: scopeOf(EXP_MAIN) });
    const got = dataOf(await runTool(list, 'get_sample', ctx, { type: 'DNA', id: LEAK_SAMPLE_ID }));
    expect(got.alias).toBe('PCR product');
    const listed = dataOf(await runTool(list, 'list_samples', ctx, { type: 'DNA' }));
    expect(JSON.stringify(listed)).not.toContain('LEAKED');
    const searched = dataOf(await runTool(list, 'search_samples', ctx, { query: 'LEAKED' }));
    expect(searched.matches).toEqual([]);
    const global = dataOf(await runTool(list, 'search_samples', ctx, { query: 'IPTG' }));
    expect(global.matches).toHaveLength(1);
  });

  it('unscoped, leaves the core tools untouched', async () => {
    const ctx = await ctxOf();
    const list = appTools();
    expect((await runTool(list, 'read_section', ctx, { documentPath: otherNote })).ok).toBe(true);
    const searched = dataOf(await runTool(list, 'search_samples', ctx, { query: 'LEAKED' }));
    expect(searched.matches).toHaveLength(1);
  });
});

describe('scopeErrorText', () => {
  it('words the five scope codes in the interface language', () => {
    setLang('en');
    expect(scopeErrorText('outOfScope', ['a/b.md', EXP_MAIN])).toContain('a/b.md');
    expect(scopeErrorText('outOfScope', ['a/b.md', EXP_MAIN])).toContain(EXP_MAIN);
    for (const code of ['scopeRequired', 'noExperiment', 'unknownExperiment', 'ambiguousExperiment']) {
      expect(scopeErrorText(code, ['x', 'y'])).toBeTruthy();
    }
    expect(scopeErrorText('section_not_found', ['x'])).toBeUndefined();
    const en = scopeErrorText('unknownExperiment', ['없음']);
    setLang('ko');
    const ko = scopeErrorText('unknownExperiment', ['없음']);
    setLang('en');
    expect(ko).toContain('없음');
    expect(ko).not.toBe(en);
  });
});

describe('get_experiment_context and get_unit_operation_context (MCP, spec §10.1)', () => {
  const props = (name: string) => tools.find(t => t.name === name)!.inputSchema as { required?: string[]; properties: Record<string, any> };
  const mcpCtx = (opts: Partial<ScopedToolContext> = {}) => ctxOf(opts);
  const ids = (data: Record<string, any>) => data.sources.map((s: { id: string }) => s.id);

  it('have the §10.1 schemas', () => {
    const exp = props('get_experiment_context');
    expect(exp.required).toBeUndefined();
    expect(Object.keys(exp.properties)).toEqual(['experiment', 'notePath', 'named', 'maxTokens', 'includeResults']);
    expect(exp.properties.named).toMatchObject({ type: 'array', items: { type: 'string' } });
    expect(exp.properties.maxTokens).toMatchObject({ type: 'integer', minimum: 1024, maximum: 200000, default: 16000 });
    expect(exp.properties.includeResults).toMatchObject({ type: 'boolean', default: false });
    const uo = props('get_unit_operation_context');
    expect(uo.required).toEqual(['notePath']);
    expect(Object.keys(uo.properties)).toEqual(['notePath', 'unitOp', 'maxTokens', 'includeResults', 'exclude']);
    expect(uo.properties.maxTokens).toMatchObject({ type: 'integer', minimum: 1024, maximum: 200000, default: 16000 });
    expect(uo.properties.exclude).toMatchObject({ type: 'array', items: { type: 'string' } });
  });

  it('without experiment or notePath gives scopeRequired with the experiments', async () => {
    const ctx = await mcpCtx();
    const res = await run(ctx, 'get_experiment_context', {});
    expect(res).toMatchObject({ ok: false, code: 'scopeRequired' });
    expect(res.params).toEqual(FIXTURE_EXPERIMENTS.map(e => e.folder));
    expect(await run(ctx, 'get_unit_operation_context', {})).toMatchObject({ ok: false, code: 'scopeRequired' });
  });

  it('a notePath outside any experiment gives noExperiment', async () => {
    const ctx = await mcpCtx();
    expect(await run(ctx, 'get_experiment_context', { notePath: 'notes/loose.md' })).toMatchObject({ ok: false, code: 'noExperiment' });
    expect(await run(ctx, 'get_unit_operation_context', { notePath: 'notes/loose.md' })).toMatchObject({ ok: false, code: 'noExperiment' });
    const sneaky = `${EXP_MAIN}/../003_정제/001_WB010_Cloning.labnote.md`;
    expect(await run(ctx, 'get_unit_operation_context', { notePath: sneaky })).toMatchObject({ ok: false });
  });

  it('an experiment and a notePath of different experiments are refused', async () => {
    const ctx = await mcpCtx();
    const res = await run(ctx, 'get_experiment_context', { experiment: '003', notePath: MAIN_FILES.cloning });
    expect(res).toMatchObject({ ok: false, code: 'ambiguousExperiment' });
  });

  it('returns the experiment context: scope, sources, text, tokens, issues and the planning rules', async () => {
    const ctx = await mcpCtx();
    const data = dataOf(await run(ctx, 'get_experiment_context', { experiment: TITLE_MAIN }));
    expect(data.scope).toEqual({ folder: EXP_MAIN, named: [] });
    expect(data.rules).toBe(`${PLANNING_RULES} ${KOREAN_TERMS_INSTRUCTION}`);
    expect(ids(data)).toContain('readme:goal');
    expect(ids(data)).toContain(`wf:${MAIN_FILES.cloning}`);
    for (const s of data.sources) {
      expect(Object.keys(s)).toEqual(expect.arrayContaining(['id', 'kind', 'label', 'mode', 'tokens', 'included']));
      expect(s.text).toBeUndefined();
    }
    expect(data.text).toContain('<<source id="readme:goal"');
    expect(data.text).not.toContain('LEAKED');
    expect(data.text).not.toContain(EXP_OTHER);
    expect(data.issues.length).toBeGreaterThan(0);
    expect(typeof data.totalTokens).toBe('number');
    expect(data.trimmed).toEqual([]);
  });

  it('the same folder by notePath', async () => {
    const ctx = await mcpCtx();
    const data = dataOf(await run(ctx, 'get_experiment_context', { notePath: MAIN_FILES.expression }));
    expect(data.scope.folder).toBe(EXP_MAIN);
  });

  it('named adds outlines of the named experiments only, never their samples', async () => {
    const ctx = await mcpCtx();
    const data = dataOf(await run(ctx, 'get_experiment_context', { experiment: '002', named: [TITLE_OTHER] }));
    expect(data.scope).toEqual({ folder: EXP_MAIN, named: [EXP_OTHER] });
    const named = data.sources.filter((s: { kind: string }) => s.kind === 'named');
    expect(named.map((s: { id: string }) => s.id)).toEqual([`named:${EXP_OTHER}`]);
    expect(data.text).not.toContain('LEAKED');
    const a = dataOf(await run(ctx, 'get_experiment_context', { experiment: '002', named: [EXP_A] }));
    expect(a.sources.filter((s: { kind: string }) => s.kind === 'named').map((s: { id: string }) => s.id)).toEqual([`named:${EXP_A}`]);
    expect(await run(ctx, 'get_experiment_context', { experiment: '002', named: ['nope'] })).toMatchObject({
      ok: false,
      code: 'unknownExperiment',
    });
  });

  it('in-app, a named experiment the user did not name is refused', async () => {
    const ctx = await mcpCtx({ scope: scopeOf(EXP_MAIN), allowedFolders: new Set<string>() });
    expect(await run(ctx, 'get_experiment_context', { named: [TITLE_OTHER] })).toMatchObject({ ok: false, code: 'outOfScope' });
    expect(await run(ctx, 'get_unit_operation_context', { notePath: `${EXP_OTHER}/001_WB010_Cloning.labnote.md` })).toMatchObject({
      ok: false,
      code: 'outOfScope',
    });
    expect(dataOf(await run(ctx, 'get_experiment_context', {})).scope.folder).toBe(EXP_MAIN);
  });

  it('maxTokens is the budget', async () => {
    const ctx = await mcpCtx();
    const notePath = `${EXP_STRESS}/004_WB040_Stage 4.labnote.md`;
    const small = dataOf(await run(ctx, 'get_unit_operation_context', { notePath, maxTokens: 1024 }));
    expect(small.budget).toBe(1024);
    expect(small.trimmed.length).toBeGreaterThan(0);
    if (!small.overBudget) expect(small.totalTokens).toBeLessThanOrEqual(1024);
    const big = dataOf(await run(ctx, 'get_unit_operation_context', { notePath, maxTokens: 200000 }));
    expect(big.budget).toBe(200000);
    expect(big.trimmed).toEqual([]);
    expect(dataOf(await run(ctx, 'get_experiment_context', { experiment: '005', maxTokens: 10 })).budget).toBe(1024);
    expect(dataOf(await run(ctx, 'get_experiment_context', { experiment: '005', maxTokens: 10_000_000 })).budget).toBe(200000);
    expect(dataOf(await run(ctx, 'get_experiment_context', { experiment: '005' })).budget).toBe(16000);
  });

  it('the unit op defaults to the last one of the note', async () => {
    const ctx = await mcpCtx();
    const data = dataOf(await run(ctx, 'get_unit_operation_context', { notePath: MAIN_FILES.expression }));
    expect(data.rules).toBe(`${PLANNING_RULES} ${KOREAN_TERMS_INSTRUCTION}`);
    expect(data.target).toMatchObject({
      path: MAIN_FILES.expression,
      unitOpIndex: 1,
      heading: '### [UHW030 Induction]',
      opId: 'UHW030',
      kind: 'hw',
    });
    expect(data.draftableSections).toEqual([...PLANNING_SECTIONS_HW]);
    expect(data.prefill).toEqual({
      ids: ['DNA-4'],
      lines: ['- DNA-4'],
      from: { path: MAIN_FILES.expression, heading: '### [USW010 Codon Check] 코돈 확인' },
    });
    expect(data.sources.at(-1)).toMatchObject({ id: 'target', kind: 'target', included: true });
    expect(data.text).toContain('<<source id="target"');
  });

  it('unitOp takes heading text, an opId or a 1-based number', async () => {
    const ctx = await mcpCtx();
    const at = async (unitOp: unknown) =>
      dataOf(await run(ctx, 'get_unit_operation_context', { notePath: MAIN_FILES.expression, unitOp })).target.unitOpIndex;
    expect(await at('USW010')).toBe(0);
    expect(await at('usw010')).toBe(0);
    expect(await at('1')).toBe(0);
    expect(await at(2)).toBe(1);
    expect(await at('[USW010 Codon Check] 코돈 확인')).toBe(0);
    expect(await at('### [UHW030 Induction]')).toBe(1);
    expect(await run(ctx, 'get_unit_operation_context', { notePath: MAIN_FILES.expression, unitOp: '9' })).toMatchObject({ ok: false });
    expect(await run(ctx, 'get_unit_operation_context', { notePath: MAIN_FILES.expression, unitOp: 'UHW999' })).toMatchObject({ ok: false });
    expect(await run(ctx, 'get_unit_operation_context', { notePath: MAIN_FILES.analysis })).toMatchObject({ ok: false });
    expect(await run(ctx, 'get_unit_operation_context', { notePath: `${EXP_MAIN}/README.labnote.md` })).toMatchObject({ ok: false });
  });

  it('prefill crosses the workflow boundary with registry names, or gives a reason', async () => {
    const ctx = await mcpCtx();
    const first = dataOf(await run(ctx, 'get_unit_operation_context', { notePath: MAIN_FILES.expression, unitOp: '1' }));
    expect(first.prefill).toEqual({
      ids: ['DNA-3'],
      lines: ['- DNA-3 — insert'],
      from: { path: MAIN_FILES.cloning, heading: '### [UHW020 Gel Purification]' },
    });
    const none = dataOf(await run(ctx, 'get_unit_operation_context', { notePath: MAIN_FILES.cloning, unitOp: '1' }));
    expect(none.prefill).toEqual({ reason: 'noPrevious' });
  });

  it('results are offered unticked unless includeResults; exclude unticks a source', async () => {
    const ctx = await mcpCtx();
    const resultsId = `uo:${MAIN_FILES.cloning}#1:results`;
    const off = dataOf(await run(ctx, 'get_unit_operation_context', { notePath: MAIN_FILES.expression, unitOp: '1' }));
    expect(off.sources.find((s: { id: string }) => s.id === resultsId)).toMatchObject({ included: false, reason: 'default' });
    expect(off.text).not.toContain('깨끗한 밴드');
    const on = dataOf(
      await run(ctx, 'get_unit_operation_context', {
        notePath: MAIN_FILES.expression,
        unitOp: '1',
        includeResults: true,
        exclude: ['readme:goal', 'target'],
      })
    );
    expect(on.sources.find((s: { id: string }) => s.id === resultsId)).toMatchObject({ included: true });
    expect(on.text).toContain('깨끗한 밴드');
    expect(on.sources.find((s: { id: string }) => s.id === 'readme:goal')).toMatchObject({ included: false, reason: 'user' });
    expect(on.sources.find((s: { id: string }) => s.id === 'target')).toMatchObject({ included: true });
  });

  it('the old tools take a notePath for their experiment (MCP)', async () => {
    const ctx = await mcpCtx();
    const data = dataOf(await run(ctx, 'list_experiment', { notePath: MAIN_FILES.cloning }));
    expect(data.folder).toBe(EXP_MAIN);
  });
});
