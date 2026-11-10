/**
 * 스트리밍 전송(spec §6.2, plan Task 6): `llm_chat_stream` + `llm://frame` 이벤트 → `llmChatStream`
 * → `LlmProvider.chatStream` → `runAgent(deps.onDelta)`. Rust 는 가짜 invoke/listen 으로 흉내 낸다.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ToolDef } from '@labnoteo/core';
import { MemFileSystem } from '@labnoteo/core';
import { fakeInvoke } from '../../integrations/__tests__/fakeNet';
import { LLM_FRAME_EVENT, llmChatStream, type ListenFn, type LlmFrame } from '../../integrations/netIpc';
import { LlmHttpError } from '../../labnote/port/llmError';
import { runAgent } from '../../labnote/port/llmAgent';
import {
  createLlmProvider,
  type ChatMessage,
  type ChatOptions,
  type ChatResult,
  type LlmProvider,
} from '../../labnote/port/llmProvider';
import { fromStored, type AppSettings } from '../../labnote/settings';

/** `listen` 흉내: 등록된 처리기에 이벤트를 보내고, 풀린 횟수를 센다. */
function fakeListen() {
  const handlers = new Set<(e: { payload: LlmFrame }) => void>();
  let names: string[] = [];
  let unlistened = 0;
  const listen = (async (name: string, h: (e: { payload: LlmFrame }) => void) => {
    names = [...names, name];
    handlers.add(h);
    return () => {
      unlistened += 1;
      handlers.delete(h);
    };
  }) as unknown as ListenFn;
  return {
    listen,
    emit: (requestId: string, data: string) => {
      for (const h of [...handlers]) h({ payload: { requestId, data } });
    },
    get active() {
      return handlers.size;
    },
    get names() {
      return names;
    },
    get unlistened() {
      return unlistened;
    },
  };
}

const sse = (delta: unknown) => JSON.stringify({ choices: [{ index: 0, delta }] });

describe('llmChatStream', () => {
  it('the event name and payload fields match ipc-events.json', () => {
    const ev = JSON.parse(readFileSync('src-tauri/tests/ipc-events.json', 'utf-8')).llmFrame;
    expect(ev.name).toBe(LLM_FRAME_EVENT);
    const frame: LlmFrame = { requestId: 'r', data: 'd' };
    expect(Object.values(ev.payload.fields).sort()).toEqual(Object.keys(frame).sort());
  });

  it('passes only its own frames, resolves the end and removes the listener', async () => {
    const l = fakeListen();
    const f = fakeInvoke({
      llm_chat_stream: (args) => {
        l.emit('someone-else', 'x');
        l.emit(String(args.requestId), 'a');
        l.emit(String(args.requestId), 'b');
        return { status: 200, done: true, frames: 2 };
      },
    });
    const seen: string[] = [];
    const end = await llmChatStream({ provider: 'openai', body: { stream: true }, onFrame: (d) => seen.push(d) }, f.invoke, l.listen);
    expect(end).toEqual({ status: 200, done: true, frames: 2 });
    expect(seen).toEqual(['a', 'b']);
    expect(l.names).toEqual(['llm://frame']);
    expect(l.active).toBe(0);
    expect(l.unlistened).toBe(1);
    expect(Object.keys(f.calls[0][1]).sort()).toEqual(['body', 'provider', 'requestId']);
  });

  it('waits for frames the command result overtook', async () => {
    const l = fakeListen();
    const f = fakeInvoke({
      llm_chat_stream: (args) => {
        l.emit(String(args.requestId), 'a');
        setTimeout(() => l.emit(String(args.requestId), 'b'), 20);
        return { status: 200, done: true, frames: 2 };
      },
    });
    const seen: string[] = [];
    await llmChatStream({ provider: 'openai', body: {}, onFrame: (d) => seen.push(d) }, f.invoke, l.listen);
    expect(seen).toEqual(['a', 'b']);
  });

  it('cancel sends net_cancel, removes the listener and drops later frames', async () => {
    const l = fakeListen();
    let id = '';
    const f = fakeInvoke({
      llm_chat_stream: (args) => {
        id = String(args.requestId);
        l.emit(id, 'a');
        return new Promise(() => {}); // Rust never answers
      },
      net_cancel: () => true,
    });
    const ac = new AbortController();
    const seen: string[] = [];
    const p = llmChatStream({ provider: 'ollama', body: {}, signal: ac.signal, onFrame: (d) => seen.push(d) }, f.invoke, l.listen);
    await new Promise((r) => setTimeout(r, 0));
    ac.abort();
    await expect(p).rejects.toMatchObject({ kind: 'cancelled' });
    l.emit(id, 'late');
    expect(seen).toEqual(['a']);
    expect(l.active).toBe(0);
    expect(f.calls).toContainEqual(['net_cancel', { requestId: id }]);
  });

  it('a missing frame after the end is noResult', async () => {
    const l = fakeListen();
    const f = fakeInvoke({ llm_chat_stream: () => ({ status: 200, done: true, frames: 1 }) });
    await expect(
      llmChatStream({ provider: 'openai', body: {}, onFrame: () => undefined, frameWaitMs: 30 }, f.invoke, l.listen),
    ).rejects.toMatchObject({ kind: 'noResult' });
    expect(l.active).toBe(0);
  });
});

const settings: AppSettings = { ...fromStored({}), llmModel: 'm1' };

describe('LlmProvider.chatStream', () => {
  it('OpenAI: sends stream:true, emits deltas in order and assembles tool calls', async () => {
    const l = fakeListen();
    const f = fakeInvoke({
      llm_chat_stream: (args) => {
        const id = String(args.requestId);
        l.emit(id, sse({ content: '먼저 ' }));
        l.emit(id, sse({ content: '읽을게요' }));
        l.emit(id, sse({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'read_note', arguments: '{"path":' } }] }));
        l.emit(id, sse({ tool_calls: [{ index: 0, function: { arguments: '"a.md"}' } }] }));
        return { status: 200, done: true, frames: 4 };
      },
    });
    const p = createLlmProvider({ ...settings, llmProvider: 'openai' }, f.invoke, l.listen)!;
    const deltas: string[] = [];
    const r = await p.chatStream!([{ role: 'user', content: 'hi' }], { temperature: 0.2 }, (d) => deltas.push(d));
    expect(deltas).toEqual(['먼저 ', '읽을게요']);
    expect(r).toEqual({ content: '먼저 읽을게요', toolCalls: [{ id: 'c1', name: 'read_note', arguments: { path: 'a.md' } }] });
    const body = JSON.parse(JSON.stringify(f.calls[0][1].body)) as Record<string, unknown>;
    expect(body).toMatchObject({ model: 'm1', stream: true, temperature: 0.2 });
    expect(f.calls[0][1].provider).toBe('openai');
  });

  it('Ollama: NDJSON lines, stream:true and num_ctx', async () => {
    const l = fakeListen();
    const f = fakeInvoke({
      llm_chat_stream: (args) => {
        const id = String(args.requestId);
        l.emit(id, JSON.stringify({ message: { content: '좋아요' }, done: false }));
        l.emit(id, JSON.stringify({ message: { content: '', tool_calls: [{ function: { name: 't', arguments: { a: 1 } } }] }, done: true }));
        return { status: 200, done: true, frames: 2 };
      },
    });
    const p = createLlmProvider({ ...settings, llmProvider: 'ollama' }, f.invoke, l.listen)!;
    const deltas: string[] = [];
    const r = await p.chatStream!([{ role: 'user', content: 'hi' }], { contextWindow: 4096 }, (d) => deltas.push(d));
    expect(deltas).toEqual(['좋아요']);
    expect(r).toEqual({ content: '좋아요', toolCalls: [{ id: 'call_0', name: 't', arguments: { a: 1 } }] });
    const body = JSON.parse(JSON.stringify(f.calls[0][1].body)) as Record<string, unknown>;
    expect(body).toMatchObject({ stream: true, options: { num_ctx: 4096 } });
  });

  it('falls back to one non-streamed call when the provider refuses the stream before any frame', async () => {
    const l = fakeListen();
    const f = fakeInvoke({
      llm_chat_stream: () => ({ status: 400, text: '{"error":{"message":"stream not supported"}}' }),
      llm_chat: () => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content: '전체 답' } }] }) }),
    });
    const p = createLlmProvider({ ...settings, llmProvider: 'openai' }, f.invoke, l.listen)!;
    const deltas: string[] = [];
    const r = await p.chatStream!([{ role: 'user', content: 'hi' }], {}, (d) => deltas.push(d));
    expect(r).toEqual({ content: '전체 답', toolCalls: [] });
    expect(deltas).toEqual(['전체 답']);
    expect(f.calls.map(([c]) => c)).toEqual(['llm_chat_stream', 'llm_chat']);
    const body = JSON.parse(JSON.stringify(f.calls[1][1].body)) as Record<string, unknown>;
    expect(body.stream).toBeUndefined();
  });

  it('the fallback runs once: a non-streamed failure is an LlmHttpError', async () => {
    const l = fakeListen();
    const f = fakeInvoke({
      llm_chat_stream: () => ({ status: 401, text: 'no key' }),
      llm_chat: () => {
        throw { kind: 'status', message: 'HTTP 401', status: 401, body: 'no key' };
      },
    });
    const p = createLlmProvider({ ...settings, llmProvider: 'openai' }, f.invoke, l.listen)!;
    await expect(p.chatStream!([{ role: 'user', content: 'hi' }], {}, () => undefined)).rejects.toBeInstanceOf(LlmHttpError);
    expect(f.calls.map(([c]) => c)).toEqual(['llm_chat_stream', 'llm_chat']);
  });

  it('never falls back once a frame arrived', async () => {
    const l = fakeListen();
    const f = fakeInvoke({
      llm_chat_stream: (args) => {
        l.emit(String(args.requestId), sse({ content: '반쯤' }));
        throw { kind: 'timeout', message: 'raw' };
      },
      llm_chat: () => ({ status: 200, text: '{}' }),
    });
    const p = createLlmProvider({ ...settings, llmProvider: 'openai' }, f.invoke, l.listen)!;
    await expect(p.chatStream!([{ role: 'user', content: 'hi' }], {}, () => undefined)).rejects.toMatchObject({ kind: 'timeout' });
    expect(f.calls.map(([c]) => c)).toEqual(['llm_chat_stream']);
  });

  it('never falls back on a network error before the first frame', async () => {
    const l = fakeListen();
    const f = fakeInvoke({
      llm_chat_stream: () => {
        throw { kind: 'offline', message: 'raw' };
      },
      llm_chat: () => ({ status: 200, text: '{}' }),
    });
    const p = createLlmProvider({ ...settings, llmProvider: 'ollama' }, f.invoke, l.listen)!;
    await expect(p.chatStream!([{ role: 'user', content: 'hi' }], {}, () => undefined)).rejects.toMatchObject({ kind: 'offline' });
    expect(f.calls.map(([c]) => c)).toEqual(['llm_chat_stream']);
  });

  it('a server that ignored stream:true answers JSON text, read like a normal reply', async () => {
    const l = fakeListen();
    const f = fakeInvoke({
      llm_chat_stream: () => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content: '한 번에' } }] }) }),
    });
    const p = createLlmProvider({ ...settings, llmProvider: 'openai' }, f.invoke, l.listen)!;
    const deltas: string[] = [];
    expect(await p.chatStream!([{ role: 'user', content: 'hi' }], {}, (d) => deltas.push(d))).toEqual({ content: '한 번에', toolCalls: [] });
    expect(deltas).toEqual(['한 번에']);
  });
});

/** chat 과 chatStream 이 같은 대본을 따르는 가짜 제공자. chatStream 은 답을 두 조각으로 흘린다. */
class StreamingScript implements LlmProvider {
  readonly name = 'openai' as const;
  readonly label = 'Scripted';
  readonly model = 'scripted';
  streamed = 0;
  private turn = 0;
  constructor(private readonly script: ChatResult[]) {}
  async chat(_m: ChatMessage[], _o?: ChatOptions): Promise<ChatResult> {
    return this.script[this.turn++] ?? { content: 'done', toolCalls: [] };
  }
  async chatStream(m: ChatMessage[], o: ChatOptions | undefined, onDelta: (t: string) => void): Promise<ChatResult> {
    this.streamed += 1;
    const r = await this.chat(m, o);
    const half = Math.ceil(r.content.length / 2);
    if (r.content) {
      onDelta(r.content.slice(0, half));
      if (r.content.slice(half)) onDelta(r.content.slice(half));
    }
    return r;
  }
}

describe('runAgent with onDelta', () => {
  const tools: ToolDef[] = [
    {
      name: 'read_thing',
      mutates: false,
      description: 'read',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => ({ ok: true, data: { v: 1 } }),
    },
  ];
  const script = (): ChatResult[] => [
    { content: '찾아볼게요', toolCalls: [{ id: 'c1', name: 'read_thing', arguments: {} }] },
    { content: '값은 1 입니다.', toolCalls: [] },
  ];
  const deps = (provider: LlmProvider) => ({
    provider,
    ctx: { fs: new MemFileSystem(), workspaceRoot: '.' },
    confirm: async () => true,
    tools,
  });

  it('emits deltas in order and returns the same AgentRun as without streaming', async () => {
    const plain = await runAgent([{ role: 'user', content: 'q' }], deps(new StreamingScript(script())));
    const sp = new StreamingScript(script());
    const deltas: string[] = [];
    const streamed = await runAgent([{ role: 'user', content: 'q' }], { ...deps(sp), onDelta: (d: string) => deltas.push(d) });
    expect(streamed).toEqual(plain);
    expect(sp.streamed).toBe(2);
    expect(deltas.join('')).toBe('찾아볼게요값은 1 입니다.');
    expect(deltas).toEqual(['찾아볼', '게요', '값은 1 ', '입니다.']);
  });

  it('without onDelta the provider is never streamed', async () => {
    const sp = new StreamingScript(script());
    await runAgent([{ role: 'user', content: 'q' }], deps(sp));
    expect(sp.streamed).toBe(0);
  });
});
