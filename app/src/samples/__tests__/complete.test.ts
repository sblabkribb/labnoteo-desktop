// @vitest-environment jsdom
/**
 * Task 13: `@` 샘플 완성 소스. 쓰고 있는 샘플 → 동작 → 폐기된 샘플, 표 칸의 파이프, 코드·추적 꺼짐·모르는 종류,
 * 그리고 동작 결과가 늦게 올 때(트리거가 바뀌었거나, 노트가 바뀌었거나, 위에서 목록 표가 고쳐졌을 때).
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { CompletionContext, type Completion, type CompletionResult } from '@codemirror/autocomplete';
import { labnoteMarkdown } from '../../editor/markdownSyntax';
import { coreT } from '../../labnote/i18n';
import { t } from '../../i18n/t';
import { createTestHost, type TestHost } from '../../labnote/__tests__/testHost';
import { pendingSampleInsert, sampleCompletionSource, sampleOptionClass, type SampleCompletionDeps } from '../complete';
import type { SampleEditorConfig } from '../editorConfig';
import { createSampleEnv, type SampleEnv } from '../env';
import { clearSampleSourceCaches, registerSampleSources, sampleActionRunners } from '../sources';
import { LOCAL, NOTE, SAMPLE_VAULT } from './fixtures';

type Matcher = string | { asymmetricMatch(v: unknown): boolean };

let hosts: TestHost[] = [];
let views: EditorView[] = [];
let notePath = NOTE;
let writeText: ReturnType<typeof vi.fn>;
const savedClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

beforeEach(() => {
  registerSampleSources();
  notePath = NOTE;
  writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});
afterEach(() => {
  for (const v of views) v.destroy();
  views = [];
  for (const th of hosts) th.cleanup();
  hosts = [];
  clearSampleSourceCaches();
  delete sampleActionRunners.catalog;
  delete sampleActionRunners.generate;
  delete sampleActionRunners.manual;
  if (savedClipboard) Object.defineProperty(navigator, 'clipboard', savedClipboard);
  else delete (navigator as unknown as { clipboard?: unknown }).clipboard;
});

function setup(vault: Record<string, string> = SAMPLE_VAULT, cfgOver: Partial<SampleEditorConfig> = {}) {
  const th = createTestHost(vault);
  hosts.push(th);
  const env: SampleEnv = createSampleEnv(th.ctx);
  const cfg: SampleEditorConfig = { enabled: () => true, types: env.types(), known: () => undefined, version: 0, ...cfgOver };
  const deps: SampleCompletionDeps = { notePath: () => notePath, config: () => cfg, env: () => env };
  return { th, env, source: sampleCompletionSource(deps) };
}

async function complete(
  doc: string,
  pos = doc.length,
  composing = false,
  cfgOver: Partial<SampleEditorConfig> = {},
): Promise<CompletionResult | null> {
  const { source } = setup(SAMPLE_VAULT, cfgOver);
  const state = EditorState.create({ doc, extensions: [labnoteMarkdown()] });
  const ctx = new CompletionContext(state, pos, false, { composing } as unknown as EditorView);
  return (await source(ctx)) as CompletionResult | null;
}

const matches = (label: string, m: Matcher) => (typeof m === 'string' ? label === m : m.asymmetricMatch(label));

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

/** 실제 편집기 위에서 `label` 줄을 받아들인다. 동작 줄이면 run 이 끝나기 전의 편집기를 돌려준다. */
async function startApply(doc: string, label: Matcher, pos = doc.length, vault: Record<string, string> = SAMPLE_VAULT) {
  const { th, source } = setup(vault);
  const view = new EditorView({
    state: EditorState.create({ doc, selection: { anchor: pos }, extensions: [labnoteMarkdown(), pendingSampleInsert] }),
    parent: document.body,
  });
  views.push(view);
  const r = (await source(new CompletionContext(view.state, pos, false, view))) as CompletionResult;
  const option = r.options.find((o) => matches(o.label, label));
  if (!option) throw new Error(`no option ${String(label)} in ${r.options.map((o) => o.label).join(', ')}`);
  (option.apply as (v: EditorView, c: Completion, f: number, t: number) => void)(view, option, r.from, pos);
  return Object.assign(view, { notes: th.notes });
}

async function applied(doc: string, label: Matcher, pos = doc.length, vault: Record<string, string> = SAMPLE_VAULT) {
  const v = await startApply(doc, label, pos, vault);
  await flush();
  return { doc: v.state.doc.toString(), notes: v.notes };
}

it('lists DNA samples then the actions', async () => {
  const r = (await complete('Out: @DNA;'))!;
  expect(r.from).toBe(5);
  expect(r.filter).toBe(false);
  expect(r.options.map((o) => o.label)).toEqual(['DNA-1 (pUC) - miniprep', coreT('Generate new {0} ID', 'DNA'), coreT('Enter info')]);
  expect(r.options[0].detail).toBe(coreT('Local {0} sample', 'DNA'));
  expect(r.options[1].detail).toBe(coreT('Automatically generate a new sample ID'));
  expect(r.options.every((o) => sampleOptionClass(o).split(' ').includes('lno-sample-option'))).toBe(true);
  expect(sampleOptionClass({ label: 'Home' })).toBe('');
  expect(r.options.every((o) => o.section === undefined && o.boost === undefined)).toBe(true);
});

it('catalog action leads the actions; a discarded sample comes after them', async () => {
  const r = (await complete('@Reagent;'))!;
  expect(r.options.map((o) => o.label)).toEqual([
    coreT('Search {0} catalog', 'Reagent'),
    coreT('Generate new {0} ID', 'Reagent'),
    coreT('Enter info'),
    expect.stringContaining('Reagent-7'),
  ]);
  expect(sampleOptionClass(r.options.at(-1)!)).toBe('lno-sample-option lno-sample-option-discarded');
  expect(r.options.at(-1)!.detail).toBe(`${coreT('Global {0} sample', 'Reagent')} · ${coreT('Discarded')}`);
});

it('existing apply inserts ID;alias', async () => {
  expect((await applied('x @DNA;pu', 'DNA-1 (pUC) - miniprep')).doc).toBe('x DNA-1;pUC');
});

it('existing apply does nothing while composing', async () => {
  const { source } = setup();
  const view = new EditorView({ state: EditorState.create({ doc: '@DNA;', selection: { anchor: 5 }, extensions: [labnoteMarkdown()] }), parent: document.body });
  views.push(view);
  const r = (await source(new CompletionContext(view.state, 5, false, view))) as CompletionResult;
  (view as unknown as { inputState: { composing: number } }).inputState.composing = 1;
  (r.options[0].apply as (v: EditorView, c: Completion, f: number, t: number) => void)(view, r.options[0], r.from, 5);
  (view as unknown as { inputState: { composing: number } }).inputState.composing = -1;
  expect(view.state.doc.toString()).toBe('@DNA;');
});

it('a discarded pick notes the discard date', async () => {
  const r = await applied('@Reagent;', expect.stringContaining('Reagent-7'));
  expect(r.doc).toBe('Reagent-7;Taq');
  expect(r.notes).toEqual([{ kind: 'info', message: coreT('{0} was marked discarded on {1}.', 'Reagent-7', '2026-10-01') }]);
});

it('inside a table row the reference is pipe-escaped', async () => {
  const vault = { ...SAMPLE_VAULT, [`${LOCAL}/DNA.json`]: '{"DNA-1":{"type":"DNA","alias":"a|b","descriptions":[],"sources":[]}}' };
  // 19 = just after `@DNA;` on the third line
  const r = await applied('| a |\n|---|\n| @DNA; |', 'DNA-1 (a|b)', 19, vault);
  expect(r.doc).toBe('| a |\n|---|\n| DNA-1;a\\|b |');
  expect(r.doc.split('\n')[2].split(/(?<!\\)\|/).length).toBe(3);
});

it('no completion in code, with tracking off, or for an unknown type', async () => {
  expect(await complete('`@DNA;')).toBeNull();
  expect(await complete('@DNA;', undefined, false, { enabled: () => false })).toBeNull();
  expect(await complete('@DNA;', undefined, false, { types: [] })).toBeNull();
  expect(await complete('@Foo;')).toBeNull();
});

it('keeps filtering while composing @DNA;p', async () => {
  expect((await complete('@DNA;p', undefined, true))!.options.length).toBeGreaterThan(0);
});

it('action result replaces the trigger when nothing changed', async () => {
  sampleActionRunners.generate = async () => 'DNA-7;new';
  expect((await applied('x @DNA;', coreT('Generate new {0} ID', 'DNA'))).doc).toBe('x DNA-7;new');
});

it('an action that resolves nothing leaves the trigger and the pending list empty', async () => {
  const v = await startApply('x @DNA;', coreT('Enter info'));
  await flush();
  expect(v.state.doc.toString()).toBe('x @DNA;');
  expect(v.state.field(pendingSampleInsert)).toEqual([]);
  expect(v.notes).toEqual([]);
});

it('action result is dropped when the trigger text changed or the note switched', async () => {
  let release!: (v: string) => void;
  sampleActionRunners.generate = () => new Promise((r) => (release = r));
  const v = await startApply('x @DNA;', coreT('Generate new {0} ID', 'DNA'));
  expect(v.state.field(pendingSampleInsert)).toHaveLength(1);
  v.dispatch({ changes: { from: 3, to: 7, insert: 'RNA;' } }); // the user edits the trigger (3..7 = 'DNA;')
  release('DNA-7;new');
  await flush();
  expect(v.state.doc.toString()).toBe('x @RNA;');
  expect(v.state.field(pendingSampleInsert)).toEqual([]);

  const w = await startApply('x @DNA;', coreT('Generate new {0} ID', 'DNA'));
  notePath = 'labnote/061_PCR/002_other.labnote.md'; // another note is open now
  release('DNA-7;new');
  await flush();
  expect(w.state.doc.toString()).toBe('x @DNA;');
});

it('a list-table rewrite above the trigger shifts the insert', async () => {
  let release!: (v: string) => void;
  sampleActionRunners.generate = () => new Promise((r) => (release = r));
  const v = await startApply('| ID |\n|---|\n\nOut: @DNA;', coreT('Generate new {0} ID', 'DNA'));
  v.dispatch({ changes: { from: 13, insert: '| DNA-7 |\n' } }); // what updateSampleListTables does through processNote
  release('DNA-7;new');
  await flush();
  expect(v.state.doc.toString()).toBe('| ID |\n|---|\n| DNA-7 |\n\nOut: DNA-7;new');
});

it('a dropped result is copied and announced', async () => {
  let release!: (v: string) => void;
  sampleActionRunners.generate = () => new Promise((r) => (release = r));
  const v = await startApply('x @DNA;', coreT('Generate new {0} ID', 'DNA'));
  v.dispatch({ changes: { from: 3, to: 6, insert: 'RNA' } });
  release('DNA-7;new');
  await flush();
  expect(writeText).toHaveBeenCalledWith('DNA-7;new');
  expect(v.notes).toContainEqual({ kind: 'warn', message: t('samples.insertDropped', 'DNA-7;new') });
});
