// @vitest-environment jsdom
// Draft-planning and prefill orchestration (plan Task 10, spec §6.4, §7).
// A fake LlmProvider, a fake pickSources and a fake showDraft; the vault is the
// test host's fake vault, the note is open in a real editor.
import { setLang } from '../../../i18n/lang';
import { catalogs, t } from '../../../i18n/t';
import { createAiEnv, type AiEnv } from '../../../ai/aiEnv';
import { NetError } from '../../../integrations/netIpc';
import { appCommands, clearAppCommandsForTest, registerAllAppCommands } from '../../../editor/commands/appCommands';
import { closeAllDialogs } from '../../host/dialogStore';
import { cleanupDialogs } from '../../host/__tests__/harness';
import { createTestHost, type TestHost } from '../../__tests__/testHost';
import { openNote } from '../../openNotes';
import { aiDraftRanges } from '../../../editor/live/aiDraftReview';
import type { ChatMessage, ChatOptions, ChatResult, LlmProvider } from '../../port/llmProvider';
import { toggleSource } from '../budget';
import type { BuiltContext } from '../contextBuilder';
import { draftPlanningCommand, prefillInputCommand, type DraftDeps } from '../draftPlanning';
import type { ContextSource } from '../types';

const EXP = 'labnote/001_Exp';
const OTHER = 'labnote/002_Other';
const WF1 = `${EXP}/001_WD010_Clone.labnote.md`;
const WF2 = `${EXP}/002_WB030_Express.labnote.md`;
const GOAL = 'Make a GFP expression plasmid.';
const RESULT_LINE = '- researcher result R1';

const README = [
  '---',
  'title: Exp',
  '---',
  '',
  '## Goal',
  '',
  GOAL,
  '',
  '## Related Workflows',
  '',
  '- [x] [WD010 Clone](./001_WD010_Clone.labnote.md)',
  '- [ ] [WB030 Express](./002_WB030_Express.labnote.md)',
  '',
].join('\n');

const clone = (output: string) =>
  [
    '## [WD010 Clone]',
    '',
    '### [UHW010 PCR]',
    '',
    '#### Input',
    '- DNA-1',
    '',
    '#### Method',
    '- 98C 30s, 30 cycles',
    '',
    '#### Output',
    output,
    '',
    '#### Results & Discussions',
    '- PCR band seen',
    '',
  ].join('\n');

const EXPRESS = [
  '## [WB030 Express]',
  '',
  '### [UHW030 Induction]',
  '',
  '#### Input',
  '',
  '#### Method',
  '',
  '#### Output',
  '',
  '#### Results & Discussions',
  RESULT_LINE,
  '',
].join('\n');

const record = (alias: string) => ({ type: 'DNA', alias, descriptions: [alias], sources: [WF1] });

function vault(opts: { output?: string } = {}): Record<string, string> {
  return {
    [`${EXP}/README.labnote.md`]: README,
    [WF1]: clone(opts.output ?? '- DNA-2'),
    [WF2]: EXPRESS,
    [`${EXP}/resources/labsamples/DNA.json`]: JSON.stringify({ 'DNA-1': record('template'), 'DNA-2': record('PCR product') }),
    [`${OTHER}/README.labnote.md`]: README.replace('title: Exp', 'title: Other').replace(GOAL, 'LEAK goal'),
    [`${OTHER}/001_WD010_Clone.labnote.md`]: clone('- DNA-2 LEAK'),
    [`${OTHER}/resources/labsamples/DNA.json`]: JSON.stringify({ 'DNA-2': record('LEAKED') }),
    'notes/loose.md': ['# Loose', '', '### [UHW010 PCR]', '', '#### Method', '', ''].join('\n'),
  };
}

const SETTINGS = { llmProvider: 'openai', llmEndpointOpenai: 'https://llm.example.test', llmModel: 'fake-model', llmContextWindow: 16384 } as const;

interface FakeProvider extends LlmProvider {
  calls: { messages: ChatMessage[]; opts?: ChatOptions }[];
}

function fakeProvider(reply: string | (() => Promise<ChatResult>)): FakeProvider {
  const calls: FakeProvider['calls'] = [];
  return {
    name: 'openai',
    label: 'Fake',
    model: 'fake-model',
    calls,
    async chat(messages, opts) {
      calls.push({ messages, opts });
      if (typeof reply === 'function') return reply();
      return { content: reply, toolCalls: [] };
    },
  };
}

const PLANNING_REPLY = [
  '#### Input',
  '- DNA-2',
  '',
  '#### Method',
  '- Add IPTG to 0.5 mM (assumed)',
  '',
  '#### Results & Discussions',
  '- Strong band at 27 kDa',
  '',
  '#### QC Metrics',
  '- yield 5 mg/L',
].join('\n');

let hosts: TestHost[] = [];

async function setup(files: Record<string, string>, path: string, caret: number, settings: Record<string, unknown> = SETTINGS) {
  const th = createTestHost(files, settings);
  hosts.push(th);
  const reads: string[] = [];
  const fs = th.host.fs;
  const read = fs.read.bind(fs);
  const list = fs.list.bind(fs);
  vi.spyOn(fs, 'read').mockImplementation(async (p: string) => {
    reads.push(p);
    return read(p);
  });
  vi.spyOn(fs, 'list').mockImplementation(async (p: string) => {
    reads.push(p);
    return list(p);
  });
  await th.mount(path);
  openNote(path)!.view()!.dispatch({ selection: { anchor: caret } });
  return { th, reads };
}

const docOf = (path: string) => openNote(path)!.view()!.state.doc.toString();

function envWith(th: TestHost, provider: LlmProvider | null): AiEnv {
  return { ...createAiEnv(th.ctx), provider };
}

interface Recorded {
  picked: { model: BuiltContext; window: number }[];
  shown: { draft: { sections: Map<string, string>; dropped: string[] }; insert: () => Promise<boolean> }[];
}

function deps(
  env: AiEnv,
  pick: (model: BuiltContext, window: number) => { sources: ContextSource[]; window: number } | null = (m, w) => ({ sources: m.sources, window: w })
): DraftDeps & Recorded {
  const picked: Recorded['picked'] = [];
  const shown: Recorded['shown'] = [];
  return {
    env,
    picked,
    shown,
    async pickSources(model, window) {
      picked.push({ model, window });
      return pick(model, window);
    },
    async showDraft(draft, insert) {
      shown.push({ draft, insert });
    },
  };
}

const IN_TARGET = EXPRESS.indexOf('#### Method');
const userText = (p: FakeProvider) => p.calls.flatMap(c => c.messages.map(m => m.content)).join('\n');

beforeEach(() => setLang('en'));
afterEach(() => {
  for (const th of hosts) th.cleanup();
  hosts = [];
  closeAllDialogs();
  cleanupDialogs();
  vi.restoreAllMocks();
});

describe('draftPlanningCommand', () => {
  it('without a provider gives the configure-first notice and calls nothing else', async () => {
    const { th } = await setup(vault(), WF2, IN_TARGET);
    const d = deps(envWith(th, null));
    await draftPlanningCommand(d);
    expect(th.notes).toEqual([{ kind: 'info', message: t('ai.configureFirst') }]);
    expect(d.picked).toHaveLength(0);
    expect(d.shown).toHaveLength(0);
  });

  it('gives a notice for a cursor outside a unit op', async () => {
    const { th } = await setup(vault(), WF2, 0);
    const p = fakeProvider(PLANNING_REPLY);
    const d = deps(envWith(th, p));
    await draftPlanningCommand(d);
    expect(th.notes).toEqual([{ kind: 'info', message: t('aiCtx.notInUnitOp') }]);
    expect(d.picked).toHaveLength(0);
    expect(p.calls).toHaveLength(0);
  });

  it('gives a notice for a note outside an experiment', async () => {
    const { th } = await setup(vault(), 'notes/loose.md', vault()['notes/loose.md'].indexOf('#### Method'));
    const p = fakeProvider(PLANNING_REPLY);
    const d = deps(envWith(th, p));
    await draftPlanningCommand(d);
    expect(th.notes).toEqual([{ kind: 'info', message: t('aiCtx.err.noExperiment') }]);
    expect(d.picked).toHaveLength(0);
    expect(p.calls).toHaveLength(0);
  });

  it('Cancel in pickSources sends nothing', async () => {
    const { th } = await setup(vault(), WF2, IN_TARGET);
    const p = fakeProvider(PLANNING_REPLY);
    const d = deps(envWith(th, p), () => null);
    await draftPlanningCommand(d);
    expect(d.picked).toHaveLength(1);
    expect(p.calls).toHaveLength(0);
    expect(d.shown).toHaveLength(0);
    expect(docOf(WF2)).toBe(EXPRESS);
  });

  it('leaves unticked sources out of the messages', async () => {
    const { th } = await setup(vault(), WF2, IN_TARGET);
    const p = fakeProvider(PLANNING_REPLY);
    const d = deps(envWith(th, p), (m, w) => ({ sources: toggleSource(m.sources, 'readme:goal', false), window: w }));
    await draftPlanningCommand(d);
    const ids = d.picked[0].model.sources.map(s => s.id);
    expect(ids).toContain('readme:goal');
    expect(ids).toContain('target');
    expect(p.calls).toHaveLength(1);
    expect(userText(p)).not.toContain(GOAL);
    expect(userText(p)).toContain('[UHW030 Induction]');
  });

  it('passes the window from settings to pickSources and the picked window to provider.chat', async () => {
    const { th } = await setup(vault(), WF2, IN_TARGET);
    const p = fakeProvider(PLANNING_REPLY);
    const d = deps(envWith(th, p), m => ({ sources: m.sources, window: 4096 }));
    await draftPlanningCommand(d);
    expect(d.picked[0].window).toBe(16384);
    expect(d.picked[0].model.budget).toBeGreaterThan(0);
    expect(p.calls[0].opts?.contextWindow).toBe(4096);
  });

  it('streams the request when the provider can (progress while the model writes)', async () => {
    const { th } = await setup(vault(), WF2, IN_TARGET);
    const p = fakeProvider(PLANNING_REPLY);
    const streamed: ChatOptions[] = [];
    p.chatStream = async (_messages, opts, onDelta) => {
      streamed.push(opts!);
      onDelta(PLANNING_REPLY);
      return { content: PLANNING_REPLY, toolCalls: [] };
    };
    const d = deps(envWith(th, p), m => ({ sources: m.sources, window: 4096 }));
    await draftPlanningCommand(d);
    expect(p.calls).toHaveLength(0);
    expect(streamed).toHaveLength(1);
    expect(streamed[0].contextWindow).toBe(4096);
    expect(d.shown).toHaveLength(1);
  });

  it('drops Results text from the reply and leaves the Results bytes alone on Insert', async () => {
    const { th } = await setup(vault(), WF2, IN_TARGET);
    const p = fakeProvider(PLANNING_REPLY);
    const d = deps(envWith(th, p));
    await draftPlanningCommand(d);
    expect(d.shown).toHaveLength(1);
    const { draft, insert } = d.shown[0];
    expect(draft.dropped).toEqual(expect.arrayContaining(['Results & Discussions', 'QC Metrics']));
    expect([...draft.sections.keys()]).toEqual(['Input', 'Method']);
    // Nothing is written before Insert.
    expect(docOf(WF2)).toBe(EXPRESS);

    await expect(insert()).resolves.toBe(true);
    const doc = docOf(WF2);
    const results = (md: string) => md.slice(md.indexOf('#### Results & Discussions'));
    expect(results(doc)).toBe(results(EXPRESS));
    expect(doc).toContain('Add IPTG to 0.5 mM (assumed)');
    expect(doc).not.toContain('Strong band');
    expect(doc).not.toContain('yield 5 mg/L');
    expect(th.notes).toContainEqual({ kind: 'info', message: t('aiCtx.draftInserted', '002_WB030_Express.labnote.md') });
  });

  it('writes the draft as plain section content and highlights it in the editor only (2026-11-11)', async () => {
    const { th } = await setup(vault(), WF2, IN_TARGET);
    const p = fakeProvider('#### Method\n- Add IPTG (assumed)');
    const d = deps(envWith(th, p), (m, w) => ({ sources: toggleSource(m.sources, 'target:input-prefill', false), window: w }));
    await draftPlanningCommand(d);
    await expect(d.shown[0].insert()).resolves.toBe(true);
    const doc = docOf(WF2);
    expect(doc).toContain('- Add IPTG (assumed)');
    expect(doc).not.toContain('[!note]');
    expect(doc).not.toContain('AI draft');
    const state = openNote(WF2)!.view()!.state;
    expect(aiDraftRanges(state).map(r => state.sliceDoc(r.from, r.to))).toEqual(['- Add IPTG (assumed)']);
  });

  it('with "Keep an AI-draft note in the file" on, writes the old marker line over the draft', async () => {
    const { th } = await setup(vault(), WF2, IN_TARGET, { ...SETTINGS, aiDraftNoteInFile: true });
    const p = fakeProvider('#### Method\n- Add IPTG (assumed)');
    const d = deps(envWith(th, p));
    await draftPlanningCommand(d);
    await expect(d.shown[0].insert()).resolves.toBe(true);
    expect(docOf(WF2)).toMatch(/> \[!note\] AI draft \([^)]*\) — review it, then delete this line\n\n- Add IPTG \(assumed\)/);
  });

  it('writes nothing when Insert comes after the note changed at that unit op', async () => {
    const { th } = await setup(vault(), WF2, IN_TARGET);
    const p = fakeProvider(PLANNING_REPLY);
    const d = deps(envWith(th, p));
    await draftPlanningCommand(d);
    const view = openNote(WF2)!.view()!;
    const at = EXPRESS.indexOf('Induction');
    view.dispatch({ changes: { from: at, to: at + 'Induction'.length, insert: 'Expression' } });
    const edited = docOf(WF2);
    await expect(d.shown[0].insert()).resolves.toBe(false);
    expect(docOf(WF2)).toBe(edited);
    expect(th.notes).toContainEqual({ kind: 'info', message: t('aiCtx.draftMoved') });
  });

  it('offers the prefill as the target:input-prefill source and writes it on Insert', async () => {
    const { th } = await setup(vault(), WF2, IN_TARGET);
    const p = fakeProvider('#### Method\n- Add IPTG (assumed)');
    const d = deps(envWith(th, p));
    await draftPlanningCommand(d);
    const prefill = d.picked[0].model.sources.find(s => s.id === 'target:input-prefill');
    expect(prefill?.text).toContain('- DNA-2 — PCR product');
    expect(userText(p)).toContain('- DNA-2 — PCR product');
    expect(docOf(WF2)).toBe(EXPRESS);
    await expect(d.shown[0].insert()).resolves.toBe(true);
    expect(docOf(WF2)).toMatch(/#### Input\n- DNA-2 — PCR product\n/);
  });

  it('does not write the prefill when the user unticked it', async () => {
    const { th } = await setup(vault(), WF2, IN_TARGET);
    const p = fakeProvider('#### Method\n- Add IPTG (assumed)');
    const d = deps(envWith(th, p), (m, w) => ({ sources: toggleSource(m.sources, 'target:input-prefill', false), window: w }));
    await draftPlanningCommand(d);
    expect(userText(p)).not.toContain('- DNA-2 — PCR product');
    await expect(d.shown[0].insert()).resolves.toBe(true);
    expect(docOf(WF2)).not.toContain('PCR product');
  });

  it('is silent for a cancelled request', async () => {
    const { th } = await setup(vault(), WF2, IN_TARGET);
    const p = fakeProvider(async () => {
      throw new NetError('cancelled', 'cancelled');
    });
    const d = deps(envWith(th, p));
    await draftPlanningCommand(d);
    expect(p.calls).toHaveLength(1);
    expect(th.notes).toEqual([]);
    expect(d.shown).toHaveLength(0);
    expect(docOf(WF2)).toBe(EXPRESS);
  });

  it('reads nothing in another experiment', async () => {
    const { th, reads } = await setup(vault(), WF2, IN_TARGET);
    const p = fakeProvider(PLANNING_REPLY);
    const d = deps(envWith(th, p));
    await draftPlanningCommand(d);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.filter(r => r.normalize('NFC').toLowerCase().startsWith(`${OTHER.toLowerCase()}/`) || r === OTHER)).toEqual([]);
    expect(userText(p)).not.toContain('LEAK');
    expect(JSON.stringify(d.picked[0].model.sources)).not.toContain('LEAK');
  });
});

describe('prefillInputCommand', () => {
  it("writes the previous Output's IDs into the Input and names the source unit op", async () => {
    const { th } = await setup(vault(), WF2, IN_TARGET);
    await prefillInputCommand(envWith(th, null));
    expect(docOf(WF2)).toMatch(/#### Input\n- DNA-2 — PCR product\n/);
    expect(th.notes).toEqual([
      { kind: 'info', message: t('aiCtx.prefillDone', '[UHW010 PCR]', '001_WD010_Clone.labnote.md') },
    ]);
  });

  it('says so when there is nothing to add', async () => {
    const files = vault();
    files[WF2] = EXPRESS.replace('#### Input\n', '#### Input\n- DNA-2\n');
    const { th } = await setup(files, WF2, files[WF2].indexOf('#### Method'));
    await prefillInputCommand(envWith(th, null));
    expect(docOf(WF2)).toBe(files[WF2]);
    expect(th.notes).toEqual([{ kind: 'info', message: t('aiCtx.prefillNothing') }]);
  });

  it('gives the noPrevious notice at the first unit op', async () => {
    const files = vault();
    const { th } = await setup(files, WF1, files[WF1].indexOf('#### Method'));
    await prefillInputCommand(envWith(th, null));
    expect(docOf(WF1)).toBe(files[WF1]);
    expect(th.notes).toEqual([{ kind: 'info', message: t('aiCtx.prefillNoPrevious') }]);
  });

  it('gives the noOutput notice when the previous Output names no sample', async () => {
    const files = vault({ output: '' });
    const { th } = await setup(files, WF2, IN_TARGET);
    await prefillInputCommand(envWith(th, null));
    expect(docOf(WF2)).toBe(EXPRESS);
    expect(th.notes).toEqual([{ kind: 'info', message: t('aiCtx.prefillNoOutput', '[UHW010 PCR]') }]);
  });

  it('gives a notice for a cursor outside a unit op', async () => {
    const { th } = await setup(vault(), WF2, 0);
    await prefillInputCommand(envWith(th, null));
    expect(docOf(WF2)).toBe(EXPRESS);
    expect(th.notes).toEqual([{ kind: 'info', message: t('aiCtx.notInUnitOp') }]);
  });
});

describe('ai-prefill-input registration', () => {
  afterEach(() => clearAppCommandsForTest());

  it('is registered by registerAllAppCommands with ko and en names', () => {
    registerAllAppCommands();
    const c = appCommands().find(x => x.id === 'ai-prefill-input');
    expect(c).toBeTruthy();
    expect(catalogs.ko[c!.nameKey]).toBeTruthy();
    expect(catalogs.en[c!.nameKey]).toBeTruthy();
  });
});
