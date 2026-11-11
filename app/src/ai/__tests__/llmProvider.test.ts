/**
 * LLM 제공자 포트. vendor tests/plugin/provider.test.ts 와 providerFixtures.test.ts 를 옮겼다: 플러그인이
 * `requestUrl` 의 요청 본문을 보던 곳에서 이 테스트는 `llm_chat` 의 `body` 인자를 본다. 주소와
 * `Authorization` 은 Rust 가 만든다(Task 6) — 웹뷰가 보내는 인자에는 주소도 키도 없다.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolDef } from '@labnoteo/core';
import { describe, expect, it } from 'vitest';
import { fakeInvoke, netError } from '../../integrations/__tests__/fakeNet';
import { NetError } from '../../integrations/netIpc';
import { LlmHttpError } from '../../labnote/port/llmError';
import {
  createLlmProvider,
  joinUrl,
  openaiBase,
  parseToolArguments,
  type ChatMessage,
  type ChatResult,
} from '../../labnote/port/llmProvider';
import { fromStored, type AppSettings } from '../../labnote/settings';

const settings: AppSettings = fromStored({});
const withProvider = (llmProvider: AppSettings['llmProvider'], over: Partial<AppSettings> = {}): AppSettings => ({
  ...settings,
  ...over,
  llmProvider,
});

/** `llm_chat` 이 `json` 을 2xx 글로 돌려주는 가짜 Rust. */
function replying(json: unknown) {
  return fakeInvoke({ llm_chat: () => ({ status: 200, text: JSON.stringify(json) }) });
}

/** n 번째 `llm_chat` 의 `body` 인자. */
function chatBody(calls: Array<[string, Record<string, unknown>]>, n = 0): Record<string, unknown> {
  const c = calls.filter(([cmd]) => cmd === 'llm_chat')[n];
  if (!c) throw new Error('no llm_chat call');
  // Tauri 는 인자를 JSON 으로 보낸다: undefined 필드는 사라진다
  return JSON.parse(JSON.stringify(c[1].body)) as Record<string, unknown>;
}

describe('openaiBase', () => {
  it('drops one final /v1 segment, with or without a trailing slash (C-R1)', () => {
    expect(openaiBase('https://h/v1/')).toBe('https://h');
    expect(openaiBase('https://h/v1')).toBe('https://h');
    expect(openaiBase(' https://gw.lab.kr/openai/v1 ')).toBe('https://gw.lab.kr/openai');
    expect(joinUrl(openaiBase('https://h/v1'), '/v1/models')).toBe('https://h/v1/models');
    expect(joinUrl(openaiBase('h.lab/v1'), '/v1/chat/completions')).toBe('http://h.lab/v1/chat/completions');
  });

  it('leaves everything else alone', () => {
    expect(openaiBase('https://h')).toBe('https://h');
    expect(openaiBase('https://h/')).toBe('https://h');
    expect(openaiBase('https://h/v1x')).toBe('https://h/v1x');
    expect(openaiBase('https://h/api/v10')).toBe('https://h/api/v10');
    expect(openaiBase('https://h/V1')).toBe('https://h/V1');
    expect(openaiBase('https://h/v1/v1')).toBe('https://h/v1');
    expect(openaiBase('https://h/v1/chat/completions')).toBe('https://h/v1/chat/completions');
    // The host is never a path segment.
    expect(openaiBase('https://v1')).toBe('https://v1');
    expect(openaiBase('v1')).toBe('v1');
  });
});

describe('joinUrl', () => {
  it('inserts exactly one slash regardless of how each side is punctuated', () => {
    expect(joinUrl('http://h:1', '/api/chat')).toBe('http://h:1/api/chat');
    expect(joinUrl('http://h:1/', '/api/chat')).toBe('http://h:1/api/chat');
    expect(joinUrl('http://h:1', 'api/chat')).toBe('http://h:1/api/chat');
    expect(joinUrl('http://h:1///', '///api/chat')).toBe('http://h:1/api/chat');
  });

  it('leaves slashes inside the path alone', () => {
    expect(joinUrl('http://h:1', '/v1/chat/completions')).toBe('http://h:1/v1/chat/completions');
  });

  it('adds http:// to a base without a scheme and keeps an existing one (display only)', () => {
    expect(joinUrl('localhost:11434', '/api/chat')).toBe('http://localhost:11434/api/chat');
    expect(joinUrl(' 127.0.0.1:11434/ ', 'api/chat')).toBe('http://127.0.0.1:11434/api/chat');
    expect(joinUrl('https://api.openai.com', '/v1/chat/completions')).toBe(
      'https://api.openai.com/v1/chat/completions',
    );
    expect(joinUrl('HTTP://h:1', '/x')).toBe('HTTP://h:1/x');
  });
});

describe('createLlmProvider', () => {
  it("createLlmProvider returns null for 'none'", () => {
    const f = fakeInvoke({});
    expect(createLlmProvider(withProvider('none'), f.invoke)).toBeNull();
    expect(f.calls).toEqual([]);
  });

  it('builds the provider named by the setting, with its label and model', () => {
    const o = createLlmProvider(withProvider('ollama', { llmModel: 'llama3.1' }))!;
    expect(o.name).toBe('ollama');
    expect(o.label).toBe('Ollama');
    expect(o.model).toBe('llama3.1');
    const a = createLlmProvider(withProvider('openai', { llmModel: 'gpt-4o-mini' }))!;
    expect(a.name).toBe('openai');
    expect(a.label).toBe('OpenAI-compatible');
    expect(a.model).toBe('gpt-4o-mini');
  });
});

describe('provider.chat', () => {
  it('ollama calls llm_chat with provider ollama and unwraps message.content', async () => {
    const f = replying({ message: { content: 'hi from llama' } });
    const out = await createLlmProvider(withProvider('ollama'), f.invoke)!.chat([{ role: 'user', content: 'hello' }]);
    expect(out).toEqual({ content: 'hi from llama', toolCalls: [] });
    expect(f.calls).toHaveLength(1);
    const [cmd, args] = f.calls[0];
    expect(cmd).toBe('llm_chat');
    expect(args.provider).toBe('ollama');
    expect(typeof args.requestId).toBe('string');
    // 주소는 Rust 가 저장된 설정에서 만든다: 웹뷰는 넘기지 않는다
    expect(JSON.stringify(args)).not.toMatch(/http|11434|endpoint/i);
  });

  it('openai calls llm_chat with provider openai and unwraps choices[0].message.content', async () => {
    const f = replying({ choices: [{ message: { content: 'hi from gpt' } }] });
    const out = await createLlmProvider(withProvider('openai'), f.invoke)!.chat([{ role: 'user', content: 'hello' }]);
    expect(out.content).toBe('hi from gpt');
    expect(f.calls[0][1].provider).toBe('openai');
  });

  it('ollama body: stream false, options.temperature, tool results by tool_name, arguments as objects', async () => {
    const f = replying({ message: { content: 'done' } });
    const history: ChatMessage[] = [
      { role: 'user', content: 'look it up' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call_abc', name: 'get_sample', arguments: { id: 'DNA-1' } }] },
      { role: 'tool', content: '{"alias":"pUC19"}', toolCallId: 'call_abc', toolName: 'get_sample' },
    ];
    await createLlmProvider(withProvider('ollama', { llmModel: 'llama3.1' }), f.invoke)!.chat(history, {
      temperature: 0.2,
    });
    const body = chatBody(f.calls);
    expect(body).toEqual({
      model: 'llama3.1',
      stream: false,
      options: { temperature: 0.2 },
      messages: [
        { role: 'user', content: 'look it up' },
        { role: 'assistant', content: '', tool_calls: [{ function: { name: 'get_sample', arguments: { id: 'DNA-1' } } }] },
        { role: 'tool', tool_name: 'get_sample', content: '{"alias":"pUC19"}' },
      ],
    });
  });

  it('ollama body omits options without a temperature', async () => {
    const f = replying({ message: { content: 'x' } });
    await createLlmProvider(withProvider('ollama'), f.invoke)!.chat([{ role: 'user', content: 'x' }]);
    expect(chatBody(f.calls).options).toBeUndefined();
  });

  it('ollama body gets options.num_ctx only when contextWindow is passed, beside temperature', async () => {
    const f = replying({ message: { content: 'x' } });
    const p = createLlmProvider(withProvider('ollama'), f.invoke)!;
    const msgs: ChatMessage[] = [{ role: 'user', content: 'x' }];
    await p.chat(msgs, { temperature: 0.2, contextWindow: 4096 });
    await p.chat(msgs, { contextWindow: 16384 });
    await p.chat(msgs, { temperature: 0.2 });
    await p.chat(msgs);
    expect(chatBody(f.calls, 0).options).toEqual({ temperature: 0.2, num_ctx: 4096 });
    expect(chatBody(f.calls, 1).options).toEqual({ num_ctx: 16384 });
    expect(chatBody(f.calls, 2).options).toEqual({ temperature: 0.2 });
    expect(chatBody(f.calls, 3).options).toBeUndefined();
  });

  it('the vault temperature setting replaces the caller temperature for both providers; blank keeps it (real-server check)', async () => {
    const msgs: ChatMessage[] = [{ role: 'user', content: 'x' }];
    const o = replying({ choices: [{ message: { content: 'x' } }] });
    const openai = createLlmProvider(withProvider('openai', { llmModel: 'm', llmTemperature: 0.7 }), o.invoke)!;
    await openai.chat(msgs, { temperature: 0.2 });
    await openai.chat(msgs);
    expect(chatBody(o.calls, 0).temperature).toBe(0.7);
    expect(chatBody(o.calls, 1).temperature).toBe(0.7);
    const l = replying({ message: { content: 'x' } });
    const ollama = createLlmProvider(withProvider('ollama', { llmTemperature: 0 }), l.invoke)!;
    await ollama.chat(msgs, { temperature: 0.2, contextWindow: 4096 });
    expect(chatBody(l.calls, 0).options).toEqual({ temperature: 0, num_ctx: 4096 });
    const b = replying({ choices: [{ message: { content: 'x' } }] });
    const blank = createLlmProvider(withProvider('openai', { llmModel: 'm', llmTemperature: null }), b.invoke)!;
    await blank.chat(msgs, { temperature: 0.2 });
    await blank.chat(msgs);
    expect(chatBody(b.calls, 0).temperature).toBe(0.2);
    expect('temperature' in chatBody(b.calls, 1) && chatBody(b.calls, 1).temperature !== undefined).toBe(false);
  });

  it('a blank temperature uses the model recommended sampling for qwen3 (non-thinking on a plain call: 0.7, top_p 0.8) on both providers; a typed value replaces only the temperature', async () => {
    const msgs: ChatMessage[] = [{ role: 'user', content: 'x' }];
    const o = replying({ choices: [{ message: { content: 'x' } }] });
    const openai = createLlmProvider(withProvider('openai', { llmModel: 'qwen3.6-35b', llmTemperature: null }), o.invoke)!;
    await openai.chat(msgs, { temperature: 0.2 });
    expect(chatBody(o.calls, 0)).toMatchObject({ temperature: 0.7, top_p: 0.8, top_k: 20, presence_penalty: 1.5 });
    const l = replying({ message: { content: 'x' } });
    const ollama = createLlmProvider(withProvider('ollama', { llmModel: 'qwen3:8b', llmTemperature: null }), l.invoke)!;
    await ollama.chat(msgs, { temperature: 0.2, contextWindow: 4096 });
    expect(chatBody(l.calls, 0).options).toEqual({ temperature: 0.7, top_p: 0.8, top_k: 20, min_p: 0, presence_penalty: 1.5, num_ctx: 4096 });
    // A typed value always wins for the temperature; the rest of the set stays
    const ty = replying({ choices: [{ message: { content: 'x' } }] });
    const typed = createLlmProvider(withProvider('openai', { llmModel: 'qwen3:8b', llmTemperature: 0.3 }), ty.invoke)!;
    await typed.chat(msgs, { temperature: 0.2 });
    expect(chatBody(ty.calls, 0).temperature).toBe(0.3);
    expect(chatBody(ty.calls, 0).top_p).toBe(0.8);
    const tl = replying({ message: { content: 'x' } });
    const typedOllama = createLlmProvider(withProvider('ollama', { llmModel: 'qwen3:8b', llmTemperature: 1 }), tl.invoke)!;
    await typedOllama.chat(msgs);
    expect(chatBody(tl.calls, 0).options).toEqual({ temperature: 1, top_p: 0.8, top_k: 20, min_p: 0, presence_penalty: 1.5 });
    // Other models keep today's behaviour
    const n = replying({ message: { content: 'x' } });
    const other = createLlmProvider(withProvider('ollama', { llmModel: 'llama3.1:8b', llmTemperature: null }), n.invoke)!;
    await other.chat(msgs, { temperature: 0.2 });
    expect(chatBody(n.calls, 0).options).toEqual({ temperature: 0.2 });
  });

  it('openai body is identical with and without contextWindow', async () => {
    const f = replying({ choices: [{ message: { content: 'x' } }] });
    const p = createLlmProvider(withProvider('openai', { llmModel: 'm' }), f.invoke)!;
    const msgs: ChatMessage[] = [{ role: 'user', content: 'x' }];
    await p.chat(msgs, { temperature: 0.2 });
    await p.chat(msgs, { temperature: 0.2, contextWindow: 4096 });
    expect(chatBody(f.calls, 1)).toEqual(chatBody(f.calls, 0));
    expect(chatBody(f.calls, 0)).toEqual({ model: 'm', messages: [{ role: 'user', content: 'x' }], temperature: 0.2 });
  });

  it('openai body: tool_call_id and arguments as JSON strings; never a key in the body', async () => {
    const f = replying({ choices: [{ message: { content: 'done' } }] });
    const history: ChatMessage[] = [
      { role: 'user', content: 'look it up' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call_abc', name: 'get_sample', arguments: { id: 'DNA-1' } }] },
      { role: 'tool', content: '{"alias":"pUC19"}', toolCallId: 'call_abc', toolName: 'get_sample' },
    ];
    await createLlmProvider(withProvider('openai', { llmModel: 'gpt-4o-mini' }), f.invoke)!.chat(history, {
      temperature: 0.2,
    });
    const body = chatBody(f.calls);
    expect(body).toEqual({
      model: 'gpt-4o-mini',
      temperature: 0.2,
      messages: [
        { role: 'user', content: 'look it up' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call_abc', type: 'function', function: { name: 'get_sample', arguments: '{"id":"DNA-1"}' } }],
        },
        { role: 'tool', tool_call_id: 'call_abc', content: '{"alias":"pUC19"}' },
      ],
    });
    expect(JSON.stringify(f.calls)).not.toMatch(/sk-|apiKey|Authorization/);
  });

  it('returns an empty string when the response has no content', async () => {
    const o = replying({});
    expect((await createLlmProvider(withProvider('ollama'), o.invoke)!.chat([])).content).toBe('');
    const a = replying({ choices: [] });
    expect((await createLlmProvider(withProvider('openai'), a.invoke)!.chat([])).content).toBe('');
  });

  it('thinking-only replies are flagged (ollama thinking, openai reasoning_content)', async () => {
    const o = replying({ message: { content: '', thinking: 'Let me think…' } });
    expect(await createLlmProvider(withProvider('ollama'), o.invoke)!.chat([])).toEqual({
      content: '',
      toolCalls: [],
      thinkingOnly: true,
    });

    const a = replying({ choices: [{ message: { content: null, reasoning_content: 'hmm' } }] });
    expect((await createLlmProvider(withProvider('openai'), a.invoke)!.chat([])).thinkingOnly).toBe(true);

    const both = replying({ message: { content: 'answer', thinking: 'Let me think…' } });
    expect((await createLlmProvider(withProvider('ollama'), both.invoke)!.chat([])).thinkingOnly).toBeUndefined();
  });

  it('a status NetError becomes LlmHttpError with provider, status and body', async () => {
    const o = fakeInvoke({
      llm_chat: () => {
        throw { kind: 'status', message: 'raw-rust-text', status: 500, body: '{"error":"model not found"}' };
      },
    });
    const err = await createLlmProvider(withProvider('ollama'), o.invoke)!.chat([]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmHttpError);
    expect(err).toMatchObject({ provider: 'Ollama', status: 500, body: '{"error":"model not found"}' });
    expect((err as Error).message).toMatch(/500/);

    const a = fakeInvoke({
      llm_chat: () => {
        throw netError('status', { status: 401, body: 'unauthorized' });
      },
    });
    const err2 = await createLlmProvider(withProvider('openai'), a.invoke)!.chat([]).catch((e: unknown) => e);
    expect(err2).toBeInstanceOf(LlmHttpError);
    expect(err2).toMatchObject({ provider: 'OpenAI', status: 401, body: 'unauthorized' });
  });

  it.each(['offline', 'timeout', 'tls', 'redirect', 'insecure', 'notConfigured', 'keychain'] as const)(
    'a %s NetError is rethrown as is',
    async (kind) => {
      const f = fakeInvoke({
        llm_chat: () => {
          throw netError(kind, { location: 'https://gw.example' });
        },
      });
      const err = await createLlmProvider(withProvider('openai'), f.invoke)!.chat([]).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NetError);
      expect(err).not.toBeInstanceOf(LlmHttpError);
      expect((err as NetError).kind).toBe(kind);
    },
  );

  it('a 2xx body that is not JSON is a notJson NetError', async () => {
    const f = fakeInvoke({ llm_chat: () => ({ status: 200, text: '<html>portal</html>' }) });
    const err = await createLlmProvider(withProvider('ollama'), f.invoke)!.chat([]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetError);
    expect((err as NetError).kind).toBe('notJson');
  });

  it('abort signal calls net_cancel with the request id', async () => {
    const f = fakeInvoke({ llm_chat: () => new Promise(() => {}), net_cancel: () => true });
    const p = createLlmProvider({ ...settings, llmProvider: 'ollama' }, f.invoke)!;
    const ac = new AbortController();
    const run = p.chat([{ role: 'user', content: 'hi' }], { signal: ac.signal });
    ac.abort();
    await expect(run).rejects.toMatchObject({ kind: 'cancelled' });
    const id = f.calls.find(([c]) => c === 'llm_chat')![1].requestId;
    expect(f.calls).toContainEqual(['net_cancel', { requestId: id }]);
  });

  it('an already aborted signal sends nothing', async () => {
    const f = fakeInvoke({ llm_chat: () => ({ status: 200, text: '{}' }) });
    const ac = new AbortController();
    ac.abort();
    await expect(
      createLlmProvider(withProvider('openai'), f.invoke)!.chat([], { signal: ac.signal }),
    ).rejects.toMatchObject({ kind: 'cancelled' });
    expect(f.calls).toEqual([]);
  });
});

describe('parseToolArguments', () => {
  it("accepts OpenAI's JSON string", () => {
    expect(parseToolArguments('{"type":"DNA","id":"DNA-1"}')).toEqual({ type: 'DNA', id: 'DNA-1' });
  });

  it("accepts Ollama's plain object", () => {
    expect(parseToolArguments({ type: 'DNA' })).toEqual({ type: 'DNA' });
  });

  it('degrades to an empty object rather than throwing on malformed JSON', () => {
    expect(parseToolArguments('{"type": "DN')).toEqual({});
    expect(parseToolArguments('not json at all')).toEqual({});
  });

  it('rejects non-object payloads', () => {
    expect(parseToolArguments(undefined)).toEqual({});
    expect(parseToolArguments(null)).toEqual({});
    expect(parseToolArguments('[1,2,3]')).toEqual({});
    expect(parseToolArguments(42)).toEqual({});
  });
});

describe('tool calling', () => {
  const fakeTool: ToolDef = {
    name: 'get_sample',
    mutates: false,
    description: 'Look up a sample.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    handler: async () => ({ ok: true }),
  };

  it('sends the same OpenAI-style tool schema to both providers', async () => {
    const expected = [
      {
        type: 'function',
        function: { name: 'get_sample', description: 'Look up a sample.', parameters: fakeTool.inputSchema },
      },
    ];
    const o = replying({ message: { content: '' } });
    await createLlmProvider(withProvider('ollama'), o.invoke)!.chat([], { tools: [fakeTool] });
    expect(chatBody(o.calls).tools).toEqual(expected);

    const a = replying({ choices: [{ message: { content: '' } }] });
    await createLlmProvider(withProvider('openai'), a.invoke)!.chat([], { tools: [fakeTool] });
    expect(chatBody(a.calls).tools).toEqual(expected);
  });

  it('omits tools entirely for a plain completion', async () => {
    const f = replying({ message: { content: 'hi' } });
    await createLlmProvider(withProvider('ollama'), f.invoke)!.chat([{ role: 'user', content: 'hi' }]);
    expect(chatBody(f.calls).tools).toBeUndefined();
  });

  it('normalizes ollama tool calls, synthesizing the id it omits', async () => {
    const f = replying({
      message: { content: '', tool_calls: [{ function: { name: 'get_sample', arguments: { id: 'DNA-1' } } }] },
    });
    const out = await createLlmProvider(withProvider('ollama'), f.invoke)!.chat([], { tools: [fakeTool] });
    expect(out.toolCalls).toEqual([{ id: 'call_0', name: 'get_sample', arguments: { id: 'DNA-1' } }]);
  });

  it('normalizes openai tool calls, parsing the arguments string', async () => {
    const f = replying({
      choices: [
        {
          message: {
            content: '',
            tool_calls: [
              { id: 'call_abc123', type: 'function', function: { name: 'get_sample', arguments: '{"id":"DNA-1"}' } },
            ],
          },
        },
      ],
    });
    const out = await createLlmProvider(withProvider('openai'), f.invoke)!.chat([], { tools: [fakeTool] });
    expect(out.toolCalls).toEqual([{ id: 'call_abc123', name: 'get_sample', arguments: { id: 'DNA-1' } }]);
  });

  it('drops a tool call with no name instead of dispatching an empty one', async () => {
    const f = replying({ message: { content: '', tool_calls: [{ function: { arguments: {} } }] } });
    expect((await createLlmProvider(withProvider('ollama'), f.invoke)!.chat([])).toolCalls).toEqual([]);
  });
});

// vendor tests/plugin/providerFixtures.test.ts: 기록된 응답 본문을 실제 제공자 코드에 다시 흘린다.
interface Fixture {
  provider: 'ollama' | 'openai';
  case: 'plain' | 'tool-call' | 'parallel-tool-calls';
  recordedFrom: string;
  body: unknown;
}

const FIXTURE_DIR = join('vendor', 'labnoteo', 'tests', 'fixtures', 'llm');
const fixtures: Fixture[] = readdirSync(FIXTURE_DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(join(FIXTURE_DIR, f), 'utf8')) as Fixture);

function find(provider: string, name: string): Fixture {
  const f = fixtures.find((x) => x.provider === provider && x.case === name);
  if (!f) throw new Error(`missing fixture: ${provider}-${name}`);
  return f;
}

async function replay(fixture: Fixture): Promise<ChatResult> {
  const f = replying(fixture.body);
  return createLlmProvider(withProvider(fixture.provider), f.invoke)!.chat(
    [{ role: 'user', content: 'recorded prompt' }],
    { temperature: 0 },
  );
}

describe('recorded provider responses', () => {
  it('covers both providers across all three cases', () => {
    expect(fixtures.map((f) => `${f.provider}-${f.case}`).sort()).toEqual([
      'ollama-parallel-tool-calls',
      'ollama-plain',
      'ollama-tool-call',
      'openai-parallel-tool-calls',
      'openai-plain',
      'openai-tool-call',
    ]);
  });

  it.each(['ollama', 'openai'] as const)('%s: a plain reply yields text and no tool calls', async (p) => {
    const out = await replay(find(p, 'plain'));
    expect(out.content).toBe('hello');
    expect(out.toolCalls).toEqual([]);
  });

  it.each(['ollama', 'openai'] as const)('%s: a tool turn is normalized to one call', async (p) => {
    const out = await replay(find(p, 'tool-call'));
    expect(out.toolCalls).toHaveLength(1);
    expect(out.toolCalls[0].name).toBe('get_weather');
    expect(String(out.toolCalls[0].arguments.location).toLowerCase()).toContain('toronto');
    expect(out.toolCalls[0].id).toBeTruthy();
  });

  it.each(['ollama', 'openai'] as const)('%s: parallel calls keep distinct ids', async (p) => {
    const out = await replay(find(p, 'parallel-tool-calls'));
    expect(out.toolCalls.length).toBeGreaterThanOrEqual(2);
    expect(new Set(out.toolCalls.map((c) => c.id)).size).toBe(out.toolCalls.length);
    for (const c of out.toolCalls) expect(c.name).toBe('get_weather');
  });

  it('openai: content is null on a tool turn and becomes an empty string', async () => {
    const fixture = find('openai', 'tool-call');
    const message = (fixture.body as { choices: Array<{ message: { content: unknown } }> }).choices[0].message;
    expect(message.content).toBeNull();
    expect((await replay(fixture)).content).toBe('');
  });

  it('ollama: ids are absent on the wire and synthesized by the normalizer', async () => {
    const fixture = find('ollama', 'parallel-tool-calls');
    const raw = (fixture.body as { message: { tool_calls: Array<{ id?: unknown }> } }).message.tool_calls;
    for (const call of raw) expect(call.id).toBeUndefined();
    expect((await replay(fixture)).toolCalls.map((c) => c.id)).toEqual(['call_0', 'call_1']);
  });

  it('openai: real ids from the wire are preserved, not replaced', async () => {
    expect((await replay(find('openai', 'tool-call'))).toolCalls[0].id).toBe('call_9k2Lx8QvT1aBcDeF');
  });

  it('every fixture names where it was recorded from', () => {
    for (const f of fixtures) expect(f.recordedFrom).toBeTruthy();
  });
});
