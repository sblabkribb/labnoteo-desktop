/**
 * 에이전트 루프 포트(vendor tests/plugin/agent.test.ts 를 그대로 옮기고, 가짜 provider 를 앱의 LlmProvider 모양에
 * 맞췄다). 더한 것: AbortSignal 이 다음 모델 턴과 runTool 앞에서 멈추는지(D11), signal 이 provider.chat 에 넘어가는지.
 */
import { describe, it, expect } from 'vitest';
import { MemFileSystem } from '@labnoteo/core';
import type { ToolContext, ToolDef } from '@labnoteo/core';
import { runAgent, countToolOutcomes, MAX_ITERATIONS } from '../../labnote/port/llmAgent';
import type { ChatMessage, ChatOptions, ChatResult, LlmProvider, ToolCall } from '../../labnote/port/llmProvider';
import { NetError } from '../../integrations/netIpc';
import type { ExternalToolMeta } from '../externalTools';

/** Replays a fixed script of turns and records what it was sent. */
class ScriptedProvider implements LlmProvider {
  readonly name = 'ollama' as const;
  readonly label = 'Scripted';
  readonly model = 'scripted';
  readonly seen: ChatMessage[][] = [];
  readonly opts: Array<ChatOptions | undefined> = [];
  private turn = 0;

  constructor(private readonly script: ChatResult[]) {}

  async chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResult> {
    this.seen.push([...messages]);
    this.opts.push(opts);
    // Past the end of the script the model just answers, which is how a real
    // one behaves once it has what it needs.
    return this.script[this.turn++] ?? { content: 'done', toolCalls: [] };
  }
}
const call = (name: string, args: Record<string, unknown> = {}, id = 'call_0'): ToolCall => ({
  id,
  name,
  arguments: args,
});

const turn = (toolCalls: ToolCall[]): ChatResult => ({ content: '', toolCalls });

/** Records every invocation so tests can assert a tool did or did not run. */
function makeTools(): { tools: ToolDef[]; ran: string[] } {
  const ran: string[] = [];
  const tools: ToolDef[] = [
    {
      name: 'read_thing',
      mutates: false,
      description: 'read',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        ran.push('read_thing');
        return { ok: true, data: { value: 42 } };
      },
    },
    {
      name: 'write_thing',
      mutates: true,
      description: 'write',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        ran.push('write_thing');
        return { ok: true, data: { written: true } };
      },
    },
    {
      name: 'failing_thing',
      mutates: false,
      description: 'fails',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        ran.push('failing_thing');
        return { ok: false, error: 'boom' };
      },
    },
  ];
  return { tools, ran };
}

const ctx = (): ToolContext => ({ fs: new MemFileSystem(), workspaceRoot: '.' });

const allow = async (): Promise<boolean> => true;
const deny = async (): Promise<boolean> => false;

describe('runAgent', () => {
  it('returns the answer directly when the model asks for no tools', async () => {
    const { tools, ran } = makeTools();
    const provider = new ScriptedProvider([{ content: 'just an answer', toolCalls: [] }]);

    const run = await runAgent([{ role: 'user', content: 'hi' }], {
      provider,
      ctx: ctx(),
      tools,
      confirm: allow,
    });

    expect(run.content).toBe('just an answer');
    expect(run.executed).toEqual([]);
    expect(ran).toEqual([]);
  });

  it('runs a read-only tool without asking the user', async () => {
    const { tools, ran } = makeTools();
    const provider = new ScriptedProvider([turn([call('read_thing')])]);
    let asked = 0;

    const run = await runAgent([{ role: 'user', content: 'read it' }], {
      provider,
      ctx: ctx(),
      tools,
      confirm: async () => {
        asked++;
        return true;
      },
    });

    expect(ran).toEqual(['read_thing']);
    expect(asked).toBe(0);
    expect(run.content).toBe('done');
  });

  it('asks before a mutating tool and runs it once allowed', async () => {
    const { tools, ran } = makeTools();
    const provider = new ScriptedProvider([turn([call('write_thing')])]);
    const asked: string[] = [];

    await runAgent([{ role: 'user', content: 'write it' }], {
      provider,
      ctx: ctx(),
      tools,
      confirm: async (_c, tool) => {
        asked.push(tool.name);
        return true;
      },
    });

    expect(asked).toEqual(['write_thing']);
    expect(ran).toEqual(['write_thing']);
  });

  it('does NOT run a mutating tool when the user denies it', async () => {
    const { tools, ran } = makeTools();
    const provider = new ScriptedProvider([turn([call('write_thing')])]);

    const run = await runAgent([{ role: 'user', content: 'write it' }], {
      provider,
      ctx: ctx(),
      tools,
      confirm: deny,
    });

    expect(ran).toEqual([]);
    expect(run.executed).toEqual([{ call: call('write_thing'), outcome: 'denied', mutates: true }]);
  });

  it('tells the model about a denial so it can adapt', async () => {
    const { tools } = makeTools();
    const provider = new ScriptedProvider([turn([call('write_thing')])]);

    await runAgent([{ role: 'user', content: 'write it' }], {
      provider,
      ctx: ctx(),
      tools,
      confirm: deny,
    });

    const secondRequest = provider.seen[1];
    const toolMessage = secondRequest[secondRequest.length - 1];
    expect(toolMessage.role).toBe('tool');
    expect(toolMessage.content).toContain('denied');
  });

  // #69: the approval prompt shows what the write removes, and a call the tool
  // would reject is not put to the user at all.
  describe('with a describe hook', () => {
    const preview = {
      kind: 'sectionEdit' as const,
      documentPath: 'n.md',
      heading: 'Results',
      parentHeading: '',
      occurrence: 1,
      total: 1,
      line: 1,
      removedLines: 4,
      removedSubheadings: 0,
      clearing: false,
      removedText: [],
      removedMore: 0,
      addedText: [],
      addedMore: 0,
    };

    it('passes the preview to confirm', async () => {
      const { tools, ran } = makeTools();
      tools[1].describe = async () => preview;
      const seen: unknown[] = [];
      await runAgent([{ role: 'user', content: 'write it' }], {
        provider: new ScriptedProvider([turn([call('write_thing')])]),
        ctx: ctx(),
        tools,
        confirm: async (_c, _t, p) => {
          seen.push(p);
          return true;
        },
      });
      expect(seen).toEqual([preview]);
      expect(ran).toEqual(['write_thing']);
    });

    it('reports the describe error to the model without asking', async () => {
      const { tools, ran } = makeTools();
      tools[1].describe = async () => ({ error: 'Section not found: Results' });
      const provider = new ScriptedProvider([turn([call('write_thing')])]);
      let asked = 0;
      const run = await runAgent([{ role: 'user', content: 'write it' }], {
        provider,
        ctx: ctx(),
        tools,
        confirm: async () => {
          asked++;
          return true;
        },
      });
      expect(asked).toBe(0);
      expect(ran).toEqual([]);
      expect(run.executed).toEqual([
        { call: call('write_thing'), outcome: 'rejected', mutates: true, error: 'Section not found: Results' },
      ]);
      const toolMessage = provider.seen[1][provider.seen[1].length - 1];
      expect(toolMessage.content).toBe(JSON.stringify({ error: 'Section not found: Results' }));
    });
  });

  it('feeds a tool error back instead of aborting the run', async () => {
    const { tools, ran } = makeTools();
    const provider = new ScriptedProvider([
      turn([call('failing_thing')]),
      turn([call('read_thing')]),
    ]);

    const run = await runAgent([{ role: 'user', content: 'go' }], {
      provider,
      ctx: ctx(),
      tools,
      confirm: allow,
    });

    // The model recovered and called a second tool after the failure.
    expect(ran).toEqual(['failing_thing', 'read_thing']);
    expect(run.executed.map(e => e.outcome)).toEqual(['failed', 'done']);
    expect(run.content).toBe('done');
  });

  it('reports an unknown tool to the model rather than throwing', async () => {
    const { tools } = makeTools();
    const provider = new ScriptedProvider([turn([call('no_such_tool')])]);

    const run = await runAgent([{ role: 'user', content: 'go' }], {
      provider,
      ctx: ctx(),
      tools,
      confirm: allow,
    });

    const second = provider.seen[1];
    expect(second[second.length - 1].content).toContain('Unknown tool');
    // Counted as a failed read, so the end notice can say why (#281).
    expect(run.executed).toEqual([
      { call: call('no_such_tool'), outcome: 'failed', mutates: false, error: 'Unknown tool: no_such_tool' },
    ]);
  });

  it('tells the model which arguments the tool ignored', async () => {
    const { tools, ran } = makeTools();
    const provider = new ScriptedProvider([turn([call('read_thing', { foo: 1 })])]);

    await runAgent([{ role: 'user', content: 'go' }], { provider, ctx: ctx(), tools, confirm: allow });

    expect(ran).toEqual(['read_thing']);
    const second = provider.seen[1];
    const payload = JSON.parse(second[second.length - 1].content);
    expect(payload.data).toEqual({ value: 42 });
    expect(payload.warnings[0]).toContain('foo');
  });

  it('passes the tool data through unchanged when there is nothing to warn about', async () => {
    const { tools } = makeTools();
    const provider = new ScriptedProvider([turn([call('read_thing')])]);

    await runAgent([{ role: 'user', content: 'go' }], { provider, ctx: ctx(), tools, confirm: allow });

    const second = provider.seen[1];
    expect(second[second.length - 1].content).toBe('{"value":42}');
  });

  it('echoes the assistant turn back before the tool results', async () => {
    const { tools } = makeTools();
    const provider = new ScriptedProvider([turn([call('read_thing')])]);

    await runAgent([{ role: 'user', content: 'go' }], {
      provider,
      ctx: ctx(),
      tools,
      confirm: allow,
    });

    // Both providers reject a tool result that does not follow its call.
    const second = provider.seen[1];
    expect(second[1].role).toBe('assistant');
    expect(second[1].toolCalls).toEqual([call('read_thing')]);
    expect(second[2].role).toBe('tool');
    expect(second[2].toolCallId).toBe('call_0');
    expect(second[2].toolName).toBe('read_thing');
  });

  it('runs every call in a parallel tool turn', async () => {
    const { tools, ran } = makeTools();
    const provider = new ScriptedProvider([
      turn([call('read_thing', {}, 'a'), call('write_thing', {}, 'b')]),
    ]);

    await runAgent([{ role: 'user', content: 'go' }], {
      provider,
      ctx: ctx(),
      tools,
      confirm: allow,
    });

    expect(ran).toEqual(['read_thing', 'write_thing']);
  });

  it('stops at the iteration cap when the model never converges', async () => {
    const { tools, ran } = makeTools();
    // Always asks for another tool — a real runaway.
    const provider = new ScriptedProvider(
      Array.from({ length: MAX_ITERATIONS + 5 }, () => turn([call('read_thing')]))
    );

    const run = await runAgent([{ role: 'user', content: 'go' }], {
      provider,
      ctx: ctx(),
      tools,
      confirm: allow,
    });

    expect(run.stoppedAtLimit).toBe(true);
    expect(ran).toHaveLength(MAX_ITERATIONS);
    expect(provider.seen).toHaveLength(MAX_ITERATIONS);
  });

  it('leaves the caller\'s message array untouched', async () => {
    const { tools } = makeTools();
    const provider = new ScriptedProvider([turn([call('read_thing')])]);
    const messages: ChatMessage[] = [{ role: 'user', content: 'go' }];

    await runAgent(messages, { provider, ctx: ctx(), tools, confirm: allow });

    expect(messages).toEqual([{ role: 'user', content: 'go' }]);
  });

  // #195: a thinking-only final turn is passed on so the command can say so.
  it('passes on a thinking-only final turn', async () => {
    const { tools } = makeTools();
    const provider = new ScriptedProvider([{ content: '', toolCalls: [], thinkingOnly: true }]);
    const run = await runAgent([{ role: 'user', content: 'go' }], { provider, ctx: ctx(), tools, confirm: allow });
    expect(run.content).toBe('');
    expect(run.thinkingOnly).toBe(true);
  });
});

// #186: a denied write was counted the same as one that ran.
describe('countToolOutcomes', () => {
  it('tells changes, reads, denials and failures apart', async () => {
    const { tools } = makeTools();
    tools[1].describe = async (_ctx, args) => (args.bad ? { error: 'no' } : (undefined as never));
    const answers = [true, false];
    const provider = new ScriptedProvider([
      turn([
        call('read_thing', {}, 'a'),
        call('write_thing', {}, 'b'),
        call('write_thing', {}, 'c'),
        call('write_thing', { bad: true }, 'd'),
        call('failing_thing', {}, 'e'),
      ]),
    ]);
    const run = await runAgent([{ role: 'user', content: 'go' }], {
      provider,
      ctx: ctx(),
      tools,
      confirm: async () => answers.shift() ?? false,
    });
    expect(run.executed.map(e => e.outcome)).toEqual(['done', 'done', 'denied', 'rejected', 'failed']);
    expect(countToolOutcomes(run.executed)).toEqual({ changed: 1, read: 1, denied: 1, failed: 2 });
  });
});

// 앱이 더한 것(D11): 취소된 signal 은 다음 모델 턴과 다음 runTool 앞에서 멈춘다.
describe('runAgent with an AbortSignal', () => {
  it('an error preview is rejected without asking', async () => {
    const { tools, ran } = makeTools();
    tools[1].describe = async () => ({ error: 'Section not found: Results' });
    let asked = 0;
    const run = await runAgent([{ role: 'user', content: 'go' }], {
      provider: new ScriptedProvider([turn([call('write_thing')])]),
      ctx: ctx(),
      tools,
      confirm: async () => {
        asked++;
        return true;
      },
    });
    expect(asked).toBe(0);
    expect(ran).toEqual([]);
    expect(run.executed[0].outcome).toBe('rejected');
  });

  it('a denial sends {error:"User denied this write."} back to the model', async () => {
    const { tools } = makeTools();
    const provider = new ScriptedProvider([turn([call('write_thing')])]);
    await runAgent([{ role: 'user', content: 'go' }], { provider, ctx: ctx(), tools, confirm: deny });
    const second = provider.seen[1];
    expect(second[second.length - 1].content).toBe(JSON.stringify({ error: 'User denied this write.' }));
  });

  it('stops at 6 iterations', async () => {
    expect(MAX_ITERATIONS).toBe(6);
    const { tools } = makeTools();
    const provider = new ScriptedProvider(Array.from({ length: 10 }, () => turn([call('read_thing')])));
    const run = await runAgent([{ role: 'user', content: 'go' }], { provider, ctx: ctx(), tools, confirm: allow });
    expect(run.stoppedAtLimit).toBe(true);
    expect(provider.seen).toHaveLength(6);
  });

  it('passes the signal to every provider.chat call', async () => {
    const { tools } = makeTools();
    const ac = new AbortController();
    const provider = new ScriptedProvider([turn([call('read_thing')])]);
    await runAgent([{ role: 'user', content: 'go' }], { provider, ctx: ctx(), tools, confirm: allow, signal: ac.signal });
    expect(provider.opts).toHaveLength(2);
    expect(provider.opts.every((o) => o?.signal === ac.signal)).toBe(true);
  });

  it('an aborted signal stops before the next model turn and before runTool', async () => {
    // 거절과 함께 취소: 다음 모델 턴이 없다
    {
      const { tools, ran } = makeTools();
      const ac = new AbortController();
      const provider = new ScriptedProvider([turn([call('write_thing')])]);
      const run = runAgent([{ role: 'user', content: 'go' }], {
        provider,
        ctx: ctx(),
        tools,
        signal: ac.signal,
        confirm: async () => {
          ac.abort();
          return false;
        },
      });
      await expect(run).rejects.toBeInstanceOf(NetError);
      await expect(run).rejects.toMatchObject({ kind: 'cancelled' });
      expect(provider.seen).toHaveLength(1);
      expect(ran).toEqual([]);
    }
    // 허용과 함께 취소: 허용됐어도 runTool 은 돌지 않는다
    {
      const { tools, ran } = makeTools();
      const ac = new AbortController();
      const provider = new ScriptedProvider([turn([call('write_thing')])]);
      const run = runAgent([{ role: 'user', content: 'go' }], {
        provider,
        ctx: ctx(),
        tools,
        signal: ac.signal,
        confirm: async () => {
          ac.abort();
          return true;
        },
      });
      await expect(run).rejects.toMatchObject({ kind: 'cancelled' });
      expect(ran).toEqual([]);
      expect(provider.seen).toHaveLength(1);
    }
  });

  it('a signal aborted before the start sends nothing to the model', async () => {
    const { tools } = makeTools();
    const ac = new AbortController();
    ac.abort();
    const provider = new ScriptedProvider([]);
    await expect(
      runAgent([{ role: 'user', content: 'go' }], { provider, ctx: ctx(), tools, confirm: allow, signal: ac.signal }),
    ).rejects.toMatchObject({ kind: 'cancelled' });
    expect(provider.seen).toHaveLength(0);
  });

  it('a read tool after an abort in the same turn does not run', async () => {
    const { tools, ran } = makeTools();
    const ac = new AbortController();
    const provider = new ScriptedProvider([turn([call('write_thing', {}, 'a'), call('read_thing', {}, 'b')])]);
    const run = runAgent([{ role: 'user', content: 'go' }], {
      provider,
      ctx: ctx(),
      tools,
      signal: ac.signal,
      confirm: async () => {
        ac.abort();
        return false;
      },
    });
    await expect(run).rejects.toMatchObject({ kind: 'cancelled' });
    expect(ran).toEqual([]);
  });
});

/**
 * 외부 도구 뒤의 오염 표시와 확인(spec §7.4). `external` 이 없으면 위의 사례가 그대로 지나야 한다.
 */
describe('runAgent: taint gate for external tools', () => {
  type Note = { tainted: boolean; reason?: 'crossServer' | 'bigArgs' } | undefined;
  const ext = (name: string, mutates = false): ToolDef => ({
    name,
    mutates,
    description: name,
    inputSchema: { type: 'object', properties: {} },
    handler: async () => ({ ok: true, data: `fenced ${name}` }),
  });
  const external = new Map<string, ExternalToolMeta>([
    ['mcp_a_search', { kind: 'mcp', serverId: 'a', serverName: 'A', readOnly: true }],
    ['mcp_a_write', { kind: 'mcp', serverId: 'a', serverName: 'A', readOnly: false }],
    ['mcp_b_search', { kind: 'mcp', serverId: 'b', serverName: 'B', readOnly: true }],
    ['pubmed_search', { kind: 'scholar', readOnly: true }],
  ]);
  const extTools = () => [ext('mcp_a_search'), ext('mcp_a_write', true), ext('mcp_b_search'), ext('pubmed_search')];
  const recorder = (answer = true) => {
    const asked: Array<{ name: string; note: Note }> = [];
    return {
      asked,
      confirm: async (c: ToolCall, _t: ToolDef, _p?: unknown, note?: Note) => {
        asked.push({ name: c.name, note });
        return answer;
      },
    };
  };
  const go = [{ role: 'user' as const, content: 'go' }];

  it('without external: reads run unasked and a write gets {tainted:false}', async () => {
    const { tools, ran } = makeTools();
    const provider = new ScriptedProvider([turn([call('read_thing', {}, 'a'), call('write_thing', {}, 'b')])]);
    const r = recorder();
    const run = await runAgent(go, { provider, ctx: ctx(), tools, confirm: r.confirm });
    expect(ran).toEqual(['read_thing', 'write_thing']);
    expect(r.asked).toEqual([{ name: 'write_thing', note: { tainted: false } }]);
    expect(run.tainted).toBe(false);
    expect(run.taintSources).toEqual([]);
  });

  it('a run that offers an MCP tool starts tainted with no sources', async () => {
    const { tools } = makeTools();
    const provider = new ScriptedProvider([turn([call('write_thing')])]);
    const r = recorder();
    const run = await runAgent(go, { provider, ctx: ctx(), tools: [...tools, ext('mcp_a_search')], external, confirm: r.confirm });
    expect(r.asked).toEqual([{ name: 'write_thing', note: { tainted: true } }]);
    expect(run.tainted).toBe(true);
    expect(run.taintSources).toEqual([]);
  });

  it('a run that offers only scholarly tools starts clean', async () => {
    const { tools } = makeTools();
    const provider = new ScriptedProvider([turn([call('write_thing')])]);
    const r = recorder();
    const run = await runAgent(go, { provider, ctx: ctx(), tools: [...tools, ext('pubmed_search')], external, confirm: r.confirm });
    expect(r.asked).toEqual([{ name: 'write_thing', note: { tainted: false } }]);
    expect(run.tainted).toBe(false);
  });

  it('after one external result every write asks with {tainted:true}, also on later turns; a denial is denied', async () => {
    const { tools, ran } = makeTools();
    const provider = new ScriptedProvider([
      turn([call('pubmed_search', { query: 'x' }, 'a'), call('write_thing', {}, 'b')]),
      turn([call('write_thing', {}, 'c')]),
    ]);
    const answers = [true, false];
    const asked: Note[] = [];
    const run = await runAgent(go, {
      provider,
      ctx: ctx(),
      tools: [...tools, ext('pubmed_search')],
      external,
      confirm: async (_c, _t, _p, note) => {
        asked.push(note);
        return answers.shift() ?? false;
      },
    });
    expect(asked).toEqual([{ tainted: true }, { tainted: true }]);
    expect(ran).toEqual(['write_thing']);
    expect(run.executed.map(e => e.outcome)).toEqual(['done', 'done', 'denied']);
    expect(run.tainted).toBe(true);
    expect(run.taintSources).toEqual(['scholar']);
  });

  it('after a result from server A, a read-only tool on server B asks (crossServer); on A it runs directly', async () => {
    const provider = new ScriptedProvider([
      turn([call('mcp_a_search', {}, 'a')]),
      turn([call('mcp_a_search', {}, 'b'), call('mcp_b_search', {}, 'c'), call('pubmed_search', {}, 'd')]),
    ]);
    const r = recorder(false);
    const run = await runAgent(go, { provider, ctx: ctx(), tools: extTools(), external, confirm: r.confirm });
    expect(r.asked).toEqual([{ name: 'mcp_b_search', note: { tainted: true, reason: 'crossServer' } }]);
    expect(run.executed.map(e => [e.call.name, e.outcome, e.mutates])).toEqual([
      ['mcp_a_search', 'done', false],
      ['mcp_a_search', 'done', false],
      ['mcp_b_search', 'denied', false],
      ['pubmed_search', 'done', false],
    ]);
    expect(run.taintSources).toEqual(['a', 'scholar']);
    // The model hears a denial that does not call the read a write.
    const denied = provider.seen[2].find(m => m.role === 'tool' && m.toolCallId === 'c');
    expect(JSON.parse(denied!.content)).toEqual({ error: 'User denied this call.' });
  });

  it('a crossServer call that is allowed runs and adds its server to the sources', async () => {
    const provider = new ScriptedProvider([turn([call('mcp_a_search', {}, 'a')]), turn([call('mcp_b_search', {}, 'b')])]);
    const r = recorder(true);
    const run = await runAgent(go, { provider, ctx: ctx(), tools: extTools(), external, confirm: r.confirm });
    expect(r.asked.map(a => a.note)).toEqual([{ tainted: true, reason: 'crossServer' }]);
    expect(run.executed.map(e => e.outcome)).toEqual(['done', 'done']);
    expect(run.taintSources).toEqual(['a', 'b']);
  });

  it('a read-only MCP call whose arguments exceed 2,000 chars asks (bigArgs); scholarly tools never ask', async () => {
    const big = { query: 'x'.repeat(2001) };
    const provider = new ScriptedProvider([
      turn([call('mcp_a_search', { query: 'short' }, 'a'), call('mcp_a_search', big, 'b'), call('pubmed_search', big, 'c')]),
    ]);
    const r = recorder(true);
    await runAgent(go, { provider, ctx: ctx(), tools: extTools(), external, confirm: r.confirm });
    expect(r.asked).toEqual([{ name: 'mcp_a_search', note: { tainted: true, reason: 'bigArgs' } }]);
  });

  it('a mutating MCP tool always asks, with the tainted note', async () => {
    const provider = new ScriptedProvider([turn([call('mcp_a_write', {}, 'a')])]);
    const r = recorder(true);
    const run = await runAgent(go, { provider, ctx: ctx(), tools: extTools(), external, confirm: r.confirm });
    expect(r.asked).toEqual([{ name: 'mcp_a_write', note: { tainted: true } }]);
    expect(run.executed[0]).toMatchObject({ outcome: 'done', mutates: true });
  });

  it('a failed external result taints too', async () => {
    const { tools } = makeTools();
    const failing: ToolDef = { ...ext('pubmed_search'), handler: async () => ({ ok: false, error: 'fenced error' }) };
    const provider = new ScriptedProvider([turn([call('pubmed_search', {}, 'a')]), turn([call('write_thing', {}, 'b')])]);
    const r = recorder(true);
    const run = await runAgent(go, { provider, ctx: ctx(), tools: [...tools, failing], external, confirm: r.confirm });
    expect(r.asked).toEqual([{ name: 'write_thing', note: { tainted: true } }]);
    expect(run.taintSources).toEqual(['scholar']);
  });

  it('a denied external call does not add a source', async () => {
    const provider = new ScriptedProvider([turn([call('mcp_a_write', {}, 'a')])]);
    const r = recorder(false);
    const run = await runAgent(go, { provider, ctx: ctx(), tools: extTools(), external, confirm: r.confirm });
    expect(run.taintSources).toEqual([]);
  });

  // Assistant spec §4.5, R11: taint carried over from earlier turns of the chat.
  it('initialTaint seeds the run: the first write asks tainted and an MCP read asks crossServer', async () => {
    const { tools, ran } = makeTools();
    const provider = new ScriptedProvider([turn([call('write_thing', {}, 'a'), call('mcp_a_search', {}, 'b')])]);
    const r = recorder(true);
    const run = await runAgent(go, {
      provider,
      ctx: ctx(),
      tools: [...tools, ext('mcp_a_search')],
      external,
      confirm: r.confirm,
      initialTaint: ['history'],
    });
    expect(r.asked).toEqual([
      { name: 'write_thing', note: { tainted: true } },
      { name: 'mcp_a_search', note: { tainted: true, reason: 'crossServer' } },
    ]);
    expect(ran).toEqual(['write_thing']);
    expect(run.tainted).toBe(true);
    expect(run.taintSources).toEqual(['history', 'a']);
  });

  it('initialTaint without any external tool still marks the write tainted', async () => {
    const { tools } = makeTools();
    const provider = new ScriptedProvider([turn([call('write_thing')])]);
    const r = recorder(true);
    const run = await runAgent(go, { provider, ctx: ctx(), tools, confirm: r.confirm, initialTaint: ['scholar'] });
    expect(r.asked).toEqual([{ name: 'write_thing', note: { tainted: true } }]);
    expect(run).toMatchObject({ tainted: true, taintSources: ['scholar'] });
  });

  it('an empty initialTaint changes nothing', async () => {
    const { tools } = makeTools();
    const provider = new ScriptedProvider([turn([call('write_thing')])]);
    const r = recorder(true);
    const run = await runAgent(go, { provider, ctx: ctx(), tools, confirm: r.confirm, initialTaint: [] });
    expect(r.asked).toEqual([{ name: 'write_thing', note: { tainted: false } }]);
    expect(run).toMatchObject({ tainted: false, taintSources: [] });
  });
});
