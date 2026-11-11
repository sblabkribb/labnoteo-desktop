// @vitest-environment jsdom
/**
 * 칩 흐름(assistant spec §4.4, plan Task 11B): 칩마다 정해진 도구만 주고, 그 밖의 도구 호출은 아무것도 돌리지 않으며,
 * 쓰기는 늘 미리보기 확인을 거친다. 사용법은 모델을 부르지 않는다. 칩 실행은 "[칩] …" 줄과 답으로 폴더 기록에 남는다.
 * 런타임은 대본대로 답하는 가짜 제공자와 진짜 core 도구(가짜 보관함, 열린 편집기)로 돈다.
 */
import type { ToolDef } from '@labnoteo/core';
import { createAiEnv, type AiEnv } from '../../ai/aiEnv';
import { externalAgentTools } from '../../ai/externalTools';
import { setLang } from '../../i18n/lang';
import { t } from '../../i18n/t';
import { fakeInvoke } from '../../integrations/__tests__/fakeNet';
import { closeAllDialogs } from '../../labnote/host/dialogStore';
import { cleanupDialogs } from '../../labnote/host/__tests__/harness';
import { createTestHost, type TestHost } from '../../labnote/__tests__/testHost';
import { openNote } from '../../labnote/openNotes';
import type { ChatMessage, ChatOptions, ChatResult, LlmProvider } from '../../labnote/port/llmProvider';
import type { Scope } from '../../labnote/context/scope';
import { builtinRuntime } from '../builtinRuntime';
import {
  CHIP_IDS,
  CHIP_TOOL_NAMES,
  CONTEXT_TOOL_NAMES,
  chipGate,
  chipLabel,
  chipRequest,
  chipTools,
  chipUserLine,
  isWorkflowNotePath,
} from '../chips';
import { emptyHistory, type HistoryDoc } from '../history';
import type { AssistantResult, AssistantRuntime, AssistantSink, AssistantTurn, ChipId } from '../runtime';
import { createAssistantSession, type HistoryIo } from '../useAssistantSession';

vi.mock('../../ai/externalTools', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../ai/externalTools')>();
  return { ...actual, externalAgentTools: vi.fn(actual.externalAgentTools) };
});

const DIR = 'labnote/001_Test';
const README = `${DIR}/README.labnote.md`;
const NOTE = `${DIR}/001_WD010_A.labnote.md`;
const BODY = ['## [WD010 A]', '', '### [UHW010 Liquid handling]', '', '#### Method', '', '- pipette', '', '## Notes', '', 'memo', ''].join('\n');
const LLM = { llmProvider: 'openai', llmEndpointOpenai: 'https://llm.example.test', llmModel: 'm' } as const;
const NO_SCHOLAR = { pubmed: false, europepmc: false, crossref: false, biorxiv: false };
const FILES = { [README]: '---\ntitle: Test run\n---\n', [NOTE]: BODY };
const scope: Scope = { folder: DIR, explicit: false, named: [] };

const names = (tools: readonly ToolDef[]) => tools.map((x) => x.name);

beforeEach(() => setLang('ko'));

describe('chip ids, labels and lines', () => {
  it('has the five chips in order with ko and en labels', () => {
    expect(CHIP_IDS).toEqual(['howTo', 'section', 'unitOp', 'workflow', 'chat']);
    expect(CHIP_IDS.map(chipLabel)).toEqual(['사용법', '섹션 만들기', 'Unit Operation 만들기', 'Workflow 만들기', '대화']);
    setLang('en');
    expect(CHIP_IDS.map(chipLabel)).toEqual(['How to use', 'Create section', 'Create unit operation', 'Create workflow', 'Chat']);
  });

  it('a chip run is stored as one short line "[chip] …"', () => {
    expect(chipUserLine('section', '결과 섹션')).toBe('[섹션 만들기] 결과 섹션');
    expect(chipUserLine('unitOp', '  PCR 산물 정제 추가 ')).toBe('[Unit Operation 만들기] PCR 산물 정제 추가');
    expect(chipUserLine('workflow', '')).toBe('[Workflow 만들기]');
  });

  it('knows a workflow note (###_….md, not the README)', () => {
    expect(isWorkflowNotePath(NOTE)).toBe(true);
    expect(isWorkflowNotePath(`${DIR}/002_WD020_세포.md`)).toBe(true);
    expect(isWorkflowNotePath(README)).toBe(false);
    expect(isWorkflowNotePath(`${DIR}/notes.md`)).toBe(false);
  });

  it('the model request carries the chosen target and the researcher text', () => {
    const s = chipRequest('section', { documentPath: NOTE, heading: 'Method', parentHeading: '[UHW010 Liquid handling]', existing: 'yes' }, '희석 비율 포함');
    expect(s).toContain(NOTE);
    expect(s).toContain('"Method"');
    expect(s).toContain('[UHW010 Liquid handling]');
    expect(s).toContain('update_section');
    expect(s).toContain('희석 비율 포함');
    const n = chipRequest('section', { documentPath: NOTE, heading: '배양 조건', existing: 'no' }, '');
    expect(n).toContain('add_section');
    expect(chipRequest('unitOp', { documentPath: NOTE }, 'PCR 산물 정제 추가')).toContain('PCR 산물 정제 추가');
    expect(chipRequest('workflow', { documentPath: README }, '클로닝')).toContain(README);
  });
});

describe('chip gate', () => {
  it('howTo needs nothing; the others need a provider first, then (except chat) an experiment', () => {
    expect(chipGate('howTo', { provider: false, folder: null })).toBe('ok');
    for (const c of ['section', 'unitOp', 'workflow'] as const) {
      expect(chipGate(c, { provider: false, folder: DIR }), c).toBe('noProvider');
      expect(chipGate(c, { provider: false, folder: null }), c).toBe('noProvider');
      expect(chipGate(c, { provider: true, folder: null }), c).toBe('noScope');
      expect(chipGate(c, { provider: true, folder: DIR }), c).toBe('ok');
    }
    expect(chipGate('chat', { provider: false, folder: DIR })).toBe('noProvider');
    expect(chipGate('chat', { provider: true, folder: null })).toBe('ok');
  });
});

describe('chipTools', () => {
  it('section = context tools + read_section + update_section + add_section only', () => {
    expect(new Set(names(chipTools('section', scope)))).toEqual(
      new Set([...CONTEXT_TOOL_NAMES, 'read_section', 'update_section', 'add_section'])
    );
    expect(CHIP_TOOL_NAMES.section).toEqual([...CONTEXT_TOOL_NAMES, 'read_section', 'update_section', 'add_section']);
  });

  it('unitOp = context tools + search_catalog + get_unit_operation + insert_unit_operation only', () => {
    expect(new Set(names(chipTools('unitOp', scope)))).toEqual(
      new Set([...CONTEXT_TOOL_NAMES, 'search_catalog', 'get_unit_operation', 'insert_unit_operation'])
    );
  });

  it('workflow = context tools + search_catalog + create_workflow only', () => {
    expect(new Set(names(chipTools('workflow', scope)))).toEqual(new Set([...CONTEXT_TOOL_NAMES, 'search_catalog', 'create_workflow']));
  });

  it('the context tools are read-only, and every write tool of a chip mutates (so it is confirmed)', () => {
    for (const c of ['section', 'unitOp', 'workflow'] as const) {
      for (const tool of chipTools(c, scope)) {
        if ((CONTEXT_TOOL_NAMES as readonly string[]).includes(tool.name)) expect(tool.mutates, tool.name).toBeFalsy();
        if (['update_section', 'add_section', 'insert_unit_operation', 'create_workflow'].includes(tool.name)) {
          expect(tool.mutates, tool.name).toBe(true);
        }
      }
    }
  });

  it('howTo has no tools; chat has the app tools plus add_section and search_catalog', () => {
    expect(chipTools('howTo', scope)).toEqual([]);
    const chat = names(chipTools('chat', scope));
    for (const n of ['update_section', 'create_sample', 'add_section', 'search_catalog', 'list_experiment']) expect(chat).toContain(n);
    expect(new Set(chat).size).toBe(chat.length);
  });
});

// ---------------------------------------------------------------- runtime (chip mode)

type Step = ChatResult | ((opts?: ChatOptions) => ChatResult | Promise<ChatResult>);

class Script implements LlmProvider {
  readonly name = 'openai' as const;
  readonly label = 'Scripted';
  readonly model = 'scripted';
  readonly seen: ChatMessage[][] = [];
  readonly offered: string[][] = [];
  private turn = 0;
  constructor(private readonly script: Step[]) {}
  async chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResult> {
    this.seen.push([...messages]);
    this.offered.push((opts?.tools ?? []).map((x: ToolDef) => x.name));
    const step = this.script[this.turn++] ?? { content: '끝', toolCalls: [] };
    return typeof step === 'function' ? step(opts) : step;
  }
}

let callNo = 0;
const toolTurn = (name: string, args: Record<string, unknown>): ChatResult => ({
  content: '',
  toolCalls: [{ id: `call_${++callNo}`, name, arguments: args }],
});
const answer = (content: string): ChatResult => ({ content, toolCalls: [] });
const sink = (): AssistantSink => ({ state: () => {}, delta: () => {}, status: () => {}, source: () => {} });
const go = () => new AbortController().signal;

let hosts: TestHost[] = [];
async function setupRt(provider: LlmProvider | null) {
  const th = createTestHost(FILES, { ...LLM, scholarSources: NO_SCHOLAR });
  hosts.push(th);
  await th.mount(NOTE);
  const f = fakeInvoke({ net_cancel: () => null, vault_current: () => ({ root: 'C:/Vault', name: 'Vault' }) });
  const makeEnv = (): AiEnv => ({ ...createAiEnv(th.ctx, f.invoke), provider });
  return { th, rt: builtinRuntime(makeEnv) };
}
const chipTurn = (chip: ChipId, params: Record<string, string>, userText: string, folder: string | null = DIR): AssistantTurn => ({
  folder,
  history: [],
  userText,
  mode: { kind: 'chip', chip, params },
});
const docOf = (path: string) => openNote(path)!.view()!.state.doc.toString();

afterEach(() => {
  for (const th of hosts) th.cleanup();
  hosts = [];
  closeAllDialogs();
  cleanupDialogs();
  vi.mocked(externalAgentTools).mockClear();
  callNo = 0;
});

describe('builtinRuntime in chip mode', () => {
  it('offers only the chip tool set, no external tools, and says what the chip is for in the system prompt', async () => {
    for (const chip of ['section', 'unitOp', 'workflow'] as const) {
      const p = new Script([answer('네')]);
      const { rt } = await setupRt(p);
      await rt.run(chipTurn(chip, { documentPath: NOTE, heading: 'Method', existing: 'yes' }, '해 줘'), sink(), go());
      expect(new Set(p.offered[0]), chip).toEqual(new Set(CHIP_TOOL_NAMES[chip]));
      expect(p.seen[0][0].role).toBe('system');
      expect(p.seen[0][0].content).toContain('chip');
    }
    expect(externalAgentTools).not.toHaveBeenCalled();
  });

  it('the unitOp prompt leaves filling sections to the Create section chip', async () => {
    const p = new Script([answer('네')]);
    const { rt } = await setupRt(p);
    await rt.run(chipTurn('unitOp', { documentPath: NOTE }, 'PCR 산물 정제 추가'), sink(), go());
    expect(p.seen[0][0].content).toContain('Create section chip');
    // The runtime sends the turn's user text as is; the session builds it with chipRequest.
    expect(p.seen[0].at(-1)).toEqual({ role: 'user', content: 'PCR 산물 정제 추가' });
  });

  it('a call to a tool outside the chip set is answered as not available and runs nothing', async () => {
    const p = new Script([toolTurn('update_section', { documentPath: NOTE, heading: 'Notes', content: '바꿈' }), answer('못 했어요')]);
    const { rt, th } = await setupRt(p);
    const r = await rt.run(chipTurn('workflow', { documentPath: NOTE }, '클로닝'), sink(), go());
    expect(th.asked.confirm).toHaveLength(0);
    expect(docOf(NOTE)).toBe(BODY);
    expect(r.executed).toHaveLength(1);
    expect(r.executed[0].outcome).toBe('failed');
    expect(r.executed[0].error).toMatch(/not available|Unknown tool/i);
    const toolMsg = p.seen[1].find((m) => m.role === 'tool');
    expect(toolMsg?.content).toMatch(/update_section/);
  });

  it('a section write shows the preview confirm; denied, the note is unchanged', async () => {
    const p = new Script([toolTurn('update_section', { documentPath: NOTE, heading: 'Notes', content: '새 메모' }), answer('')]);
    const { rt, th } = await setupRt(p);
    th.answer.confirm(false);
    const r = await rt.run(chipTurn('section', { documentPath: NOTE, heading: 'Notes', existing: 'yes' }, ''), sink(), go());
    expect(th.asked.confirm).toHaveLength(1);
    expect(th.asked.confirm[0].message).toContain(NOTE);
    expect(docOf(NOTE)).toBe(BODY);
    expect(r.executed.map((e) => e.outcome)).toEqual(['denied']);
  });

  it('add_section from the section chip asks first; denied, nothing is added; allowed, the section is added', async () => {
    const args = { documentPath: NOTE, heading: '배양 조건', body: '- 37 °C' };
    const p = new Script([toolTurn('add_section', args), answer('')]);
    const { rt, th } = await setupRt(p);
    th.answer.confirm(false);
    await rt.run(chipTurn('section', { documentPath: NOTE, heading: '배양 조건', existing: 'no' }, ''), sink(), go());
    expect(th.asked.confirm).toHaveLength(1);
    expect(docOf(NOTE)).toBe(BODY);

    const p2 = new Script([toolTurn('add_section', args), answer('추가했어요')]);
    const { rt: rt2, th: th2 } = await setupRt(p2);
    th2.answer.confirm(true);
    await rt2.run(chipTurn('section', { documentPath: NOTE, heading: '배양 조건', existing: 'no' }, ''), sink(), go());
    expect(th2.asked.confirm).toHaveLength(1);
    expect(docOf(NOTE)).toContain('## 배양 조건');
  });

  it('howTo never calls the model', async () => {
    const p = new Script([answer('x')]);
    const { rt } = await setupRt(p);
    const r = await rt.run(chipTurn('howTo', {}, ''), sink(), go());
    expect(p.seen).toHaveLength(0);
    expect(r.content).toBe('');
  });

  it('a scoped chip without an experiment folder calls nothing and says to open an experiment note', async () => {
    const p = new Script([answer('x')]);
    const { rt } = await setupRt(p);
    const r = await rt.run(chipTurn('section', { documentPath: NOTE, heading: 'Notes', existing: 'yes' }, '', null), sink(), go());
    expect(p.seen).toHaveLength(0);
    expect(r.error).toBe(t('pet.needExperiment'));
  });
});

// ---------------------------------------------------------------- session (chip runs in the folder history)

function memoryHistory() {
  const docs = new Map<string, HistoryDoc>();
  const writes: HistoryDoc[] = [];
  const io: HistoryIo = {
    read: async (folder) => ({ doc: docs.get(folder) ?? emptyHistory(folder), token: `v:${folder}` }),
    write: async (_folder, _token, doc) => {
      writes.push(doc);
      docs.set(doc.folder, doc);
    },
    clear: async (folder) => void docs.delete(folder),
  };
  return { io, writes };
}

function fakeRt(plan: (turn: AssistantTurn) => Partial<AssistantResult>) {
  const turns: AssistantTurn[] = [];
  const rt: AssistantRuntime = {
    id: 'fake',
    label: () => 'Fake',
    available: async () => ({ ok: true }),
    async run(turn) {
      turns.push(structuredClone(turn));
      return { content: '', sources: [], executed: [], tainted: false, ...plan(turn) };
    },
  };
  return { rt, turns };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('session chip runs', () => {
  it('a chip run sends the chip mode and request, and stores "[chip] …" plus the reply in the folder history', async () => {
    const mem = memoryHistory();
    const { rt, turns } = fakeRt(() => ({ content: '섹션을 채웠어요' }));
    const session = createAssistantSession({ history: mem.io, runtime: () => rt, setPetState: () => {}, now: () => 5 });
    session.setActivePath(NOTE);
    await flush();
    const params = { documentPath: NOTE, heading: '결과 섹션', existing: 'no' };
    await session.runChip({ chip: 'section', params, line: '결과 섹션', text: '' });
    expect(turns).toHaveLength(1);
    expect(turns[0].mode).toEqual({ kind: 'chip', chip: 'section', params });
    expect(turns[0].userText).toBe(chipRequest('section', params, ''));
    const saved = mem.writes.at(-1)!;
    expect(saved.folder).toBe(DIR);
    expect(saved.messages.map((m) => [m.role, m.text, m.chip])).toEqual([
      ['user', '[섹션 만들기] 결과 섹션', 'section'],
      ['assistant', '섹션을 채웠어요', 'section'],
    ]);
    expect(session.get().messages.map((m) => m.text)).toEqual(['[섹션 만들기] 결과 섹션', '섹션을 채웠어요']);
  });

  it('howTo never reaches the runtime; a scoped chip outside an experiment says to open one and calls nothing', async () => {
    const mem = memoryHistory();
    const { rt, turns } = fakeRt(() => ({ content: 'x' }));
    const session = createAssistantSession({ history: mem.io, runtime: () => rt, setPetState: () => {} });
    session.setActivePath('notes/free.md');
    await session.runChip({ chip: 'howTo', params: {}, line: '', text: '' });
    await session.runChip({ chip: 'unitOp', params: { documentPath: 'notes/free.md' }, line: 'PCR', text: 'PCR' });
    expect(turns).toHaveLength(0);
    expect(session.get().messages.at(-1)?.error).toBe(t('pet.needExperiment'));
  });

  it('the chosen chip is part of the session state', () => {
    const session = createAssistantSession({ setPetState: () => {} });
    expect(session.get().chip).toBe('chat');
    session.setChip('workflow');
    expect(session.get().chip).toBe('workflow');
  });
});
