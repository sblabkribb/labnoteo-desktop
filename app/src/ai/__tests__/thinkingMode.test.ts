/**
 * 생각 모드(2026-11-11, 사용자 보고 "AI 모델이 같은 생각을 되풀이해서 멈췄습니다"): qwen3 계열은 도구를 쓰는 차례에서
 * 생각을 끄고(vLLM chat_template_kwargs.enable_thinking, Ollama think), 모드마다 모델 카드의 샘플링을 보내며,
 * 생각 고리(또는 생각만 하다 시간 초과)면 생각을 끄고 한 번 더 보낸다. Rust 는 가짜 invoke/listen 이다.
 */
import type { ToolDef } from '@labnoteo/core';
import { describe, expect, it, vi } from 'vitest';
import { fakeInvoke } from '../../integrations/__tests__/fakeNet';
import type { ListenFn, LlmFrame } from '../../integrations/netIpc';
import { ReasoningLoopError } from '../../labnote/port/llmError';
import { createLlmProvider, type ChatMessage } from '../../labnote/port/llmProvider';
import {
  THINKING_CONTEXT_MIN,
  cleanThinking,
  fromStored,
  recommendedSampling,
  thinkingFor,
  type AppSettings,
} from '../../labnote/settings';

const base: AppSettings = fromStored({});
const s = (over: Partial<AppSettings>): AppSettings => ({ ...base, ...over });
const msgs: ChatMessage[] = [{ role: 'user', content: 'x' }];
const tool: ToolDef = {
  name: 'get_experiment_context',
  description: 'd',
  inputSchema: { type: 'object', properties: {} },
  handler: async () => ({ ok: true }),
} as unknown as ToolDef;

function bodies(calls: Array<[string, Record<string, unknown>]>, cmd = 'llm_chat'): Array<Record<string, unknown>> {
  return calls.filter(([c]) => c === cmd).map(([, a]) => JSON.parse(JSON.stringify(a.body)) as Record<string, unknown>);
}

describe('thinking setting', () => {
  it('defaults to auto and keeps only auto, on or off', () => {
    expect(base.llmThinking).toBe('auto');
    expect(fromStored({ llmThinking: 'off' }).llmThinking).toBe('off');
    expect(fromStored({ llmThinking: 'on' }).llmThinking).toBe('on');
    expect(fromStored({ llmThinking: 'maybe' }).llmThinking).toBe('auto');
    expect(cleanThinking(3)).toBe('auto');
  });

  it('auto: qwen3 thinks off on tool turns, and on text turns unless the window is under 128K; other models get nothing', () => {
    const q = s({ llmModel: 'qwen3.6-35b-a3b', llmContextWindow: 8192 });
    expect(thinkingFor(q, true)).toBe('off');
    expect(thinkingFor(q, false)).toBe('off');
    expect(thinkingFor({ ...q, llmContextWindow: THINKING_CONTEXT_MIN }, false)).toBe('on');
    expect(thinkingFor({ ...q, llmContextWindow: THINKING_CONTEXT_MIN }, true)).toBe('off');
    expect(thinkingFor(s({ llmModel: 'llama3.1:8b' }), true)).toBeUndefined();
    expect(thinkingFor(s({ llmModel: 'llama3.1:8b' }), false)).toBeUndefined();
  });

  it('on and off are sent as chosen, for any model', () => {
    expect(thinkingFor(s({ llmModel: 'qwen3:8b', llmThinking: 'on' }), true)).toBe('on');
    expect(thinkingFor(s({ llmModel: 'deepseek-r1', llmThinking: 'off' }), false)).toBe('off');
  });

  it('recommended sampling per mode (Qwen3.6 card): off 0.7/0.8, on 0.6/0.95, both top_k 20, min_p 0, presence 1.5', () => {
    expect(recommendedSampling('qwen3:8b', 'off')).toEqual({
      family: 'qwen3',
      temperature: 0.7,
      topP: 0.8,
      topK: 20,
      minP: 0,
      presencePenalty: 1.5,
    });
    expect(recommendedSampling('Qwen3.6-35B-A3B', 'on')).toEqual({
      family: 'qwen3',
      temperature: 0.6,
      topP: 0.95,
      topK: 20,
      minP: 0,
      presencePenalty: 1.5,
    });
    expect(recommendedSampling('qwen3:8b')!.temperature).toBe(0.7);
    expect(recommendedSampling('gpt-4o-mini', 'on')).toBeNull();
  });
});

describe('request bodies', () => {
  const okOpenai = () => fakeInvoke({ llm_chat: () => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content: 'x' } }] }) }) });
  const okOllama = () => fakeInvoke({ llm_chat: () => ({ status: 200, text: JSON.stringify({ message: { content: 'x' } }) }) });

  it('openai + qwen3, tool turn: thinking off through chat_template_kwargs and the non-thinking sampling', async () => {
    const f = okOpenai();
    await createLlmProvider(s({ llmProvider: 'openai', llmModel: 'qwen3.6-35b-a3b' }), f.invoke)!.chat(msgs, { temperature: 0.2, tools: [tool] });
    expect(bodies(f.calls)[0]).toMatchObject({
      temperature: 0.7,
      top_p: 0.8,
      top_k: 20,
      min_p: 0,
      presence_penalty: 1.5,
      chat_template_kwargs: { enable_thinking: false },
    });
  });

  it('openai + qwen3, text turn with a 128K window: thinking on and the thinking sampling', async () => {
    const f = okOpenai();
    await createLlmProvider(s({ llmProvider: 'openai', llmModel: 'qwen3:32b', llmContextWindow: 131072 }), f.invoke)!.chat(msgs, { temperature: 0.2 });
    expect(bodies(f.calls)[0]).toMatchObject({ temperature: 0.6, top_p: 0.95, top_k: 20, chat_template_kwargs: { enable_thinking: true } });
  });

  it('ollama + qwen3: top-level think false, sampling in options', async () => {
    const f = okOllama();
    await createLlmProvider(s({ llmProvider: 'ollama', llmModel: 'qwen3:8b' }), f.invoke)!.chat(msgs, { tools: [tool], contextWindow: 4096 });
    const b = bodies(f.calls)[0];
    expect(b.think).toBe(false);
    expect(b.chat_template_kwargs).toBeUndefined();
    expect(b.options).toEqual({ temperature: 0.7, top_p: 0.8, top_k: 20, min_p: 0, presence_penalty: 1.5, num_ctx: 4096 });
  });

  it('other models on auto get no new fields', async () => {
    const f = okOpenai();
    await createLlmProvider(s({ llmProvider: 'openai', llmModel: 'gpt-4o-mini' }), f.invoke)!.chat(msgs, { temperature: 0.2, tools: [tool] });
    const b = bodies(f.calls)[0];
    expect(b.temperature).toBe(0.2);
    for (const k of ['top_p', 'top_k', 'min_p', 'presence_penalty', 'chat_template_kwargs', 'think']) expect(b[k]).toBeUndefined();
    const o = okOllama();
    await createLlmProvider(s({ llmProvider: 'ollama', llmModel: 'llama3.1:8b' }), o.invoke)!.chat(msgs, { temperature: 0.2 });
    expect(bodies(o.calls)[0].think).toBeUndefined();
    expect(bodies(o.calls)[0].options).toEqual({ temperature: 0.2 });
  });

  it('a typed temperature replaces only the temperature of the recommended set', async () => {
    const f = okOpenai();
    await createLlmProvider(s({ llmProvider: 'openai', llmModel: 'qwen3:8b', llmTemperature: 0.3 }), f.invoke)!.chat(msgs, { tools: [tool] });
    expect(bodies(f.calls)[0]).toMatchObject({ temperature: 0.3, top_p: 0.8, top_k: 20, presence_penalty: 1.5 });
  });

  it('an explicit off reaches a non-qwen model, without the qwen sampling', async () => {
    const f = okOpenai();
    await createLlmProvider(s({ llmProvider: 'openai', llmModel: 'deepseek-r1', llmThinking: 'off' }), f.invoke)!.chat(msgs, { temperature: 0.2 });
    const b = bodies(f.calls)[0];
    expect(b.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(b.temperature).toBe(0.2);
    expect(b.top_k).toBeUndefined();
  });

  it('a 400 to a body with the extra fields is sent once more without them, and later requests skip them', async () => {
    let n = 0;
    const f = fakeInvoke({
      llm_chat: (a) => {
        n += 1;
        const body = a.body as Record<string, unknown>;
        if ('top_k' in body || 'chat_template_kwargs' in body) throw { kind: 'status', message: 'm', status: 400, body: 'unknown field top_k' };
        return { status: 200, text: JSON.stringify({ choices: [{ message: { content: 'ok' } }] }) };
      },
    });
    const p = createLlmProvider(s({ llmProvider: 'openai', llmModel: 'qwen3:8b' }), f.invoke)!;
    expect((await p.chat(msgs, { tools: [tool] })).content).toBe('ok');
    const sent = bodies(f.calls);
    expect(sent).toHaveLength(2);
    expect(sent[1].top_k).toBeUndefined();
    expect(sent[1].min_p).toBeUndefined();
    expect(sent[1].chat_template_kwargs).toBeUndefined();
    // Standard fields stay.
    expect(sent[1]).toMatchObject({ temperature: 0.7, top_p: 0.8, presence_penalty: 1.5 });
    await p.chat(msgs, { tools: [tool] });
    expect(n).toBe(3);
  });

  it('a 400 to a body without extra fields is reported as before (no second request)', async () => {
    const f = fakeInvoke({ llm_chat: () => { throw { kind: 'status', message: 'm', status: 400, body: 'bad' }; } });
    const p = createLlmProvider(s({ llmProvider: 'openai', llmModel: 'gpt-4o-mini' }), f.invoke)!;
    await expect(p.chat(msgs)).rejects.toMatchObject({ status: 400 });
    expect(bodies(f.calls)).toHaveLength(1);
  });

  it('a non-streamed openai reply with only `reasoning` (newer vLLM) is thinking-only', async () => {
    const f = fakeInvoke({ llm_chat: () => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content: '', reasoning: 'hmm' } }] }) }) });
    const r = await createLlmProvider(s({ llmProvider: 'openai', llmModel: 'm' }), f.invoke)!.chat(msgs);
    expect(r.thinkingOnly).toBe(true);
  });
});

/** `listen` 흉내. */
function fakeListen() {
  const handlers = new Set<(e: { payload: LlmFrame }) => void>();
  const listen = (async (_name: string, h: (e: { payload: LlmFrame }) => void) => {
    handlers.add(h);
    return () => handlers.delete(h);
  }) as unknown as ListenFn;
  return { listen, emit: (requestId: string, data: string) => { for (const h of [...handlers]) h({ payload: { requestId, data } }); } };
}

const sse = (delta: unknown) => JSON.stringify({ choices: [{ index: 0, delta }] });
const LOOP = 'I will call get_experiment_context first. Then add_section. Wait, I should check. '.repeat(40);

describe('retry with thinking off', () => {
  /** Each `llm_chat_stream` runs the next script: it gets emit(data) and returns the end or throws. */
  function streaming(scripts: Array<(emit: (d: string) => void) => unknown>) {
    const l = fakeListen();
    let i = 0;
    const f = fakeInvoke({
      llm_chat_stream: (a) => {
        const script = scripts[i++];
        if (!script) throw new Error('no more scripts');
        return script((d) => l.emit(String(a.requestId), d));
      },
    });
    return { f, listen: l.listen };
  }
  const loops = (emit: (d: string) => void) => {
    emit(sse({ reasoning: LOOP }));
    return { status: 200, done: true, frames: 1 };
  };
  const answers = (emit: (d: string) => void) => {
    emit(sse({ content: 'done' }));
    return { status: 200, done: true, frames: 1 };
  };

  it('a reasoning loop is sent once more with thinking off, and onRetry says so', async () => {
    const { f, listen } = streaming([loops, answers]);
    const p = createLlmProvider(s({ llmProvider: 'openai', llmModel: 'qwen3:8b', llmThinking: 'on' }), f.invoke, listen)!;
    const onRetry = vi.fn();
    const deltas: string[] = [];
    const r = await p.chatStream!(msgs, { tools: [tool], onRetry }, (d) => deltas.push(d));
    expect(r.content).toBe('done');
    expect(deltas).toEqual(['done']);
    expect(onRetry).toHaveBeenCalledTimes(1);
    const sent = bodies(f.calls, 'llm_chat_stream');
    expect(sent[0].chat_template_kwargs).toEqual({ enable_thinking: true });
    expect(sent[1].chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(sent[1]).toMatchObject({ temperature: 0.7, top_p: 0.8 });
  });

  it('a second loop is reported', async () => {
    const { f, listen } = streaming([loops, loops]);
    const p = createLlmProvider(s({ llmProvider: 'openai', llmModel: 'qwen3:8b', llmThinking: 'on' }), f.invoke, listen)!;
    await expect(p.chatStream!(msgs, undefined, () => {})).rejects.toBeInstanceOf(ReasoningLoopError);
    expect(bodies(f.calls, 'llm_chat_stream')).toHaveLength(2);
  });

  it('no retry when thinking was already off', async () => {
    const { f, listen } = streaming([loops, answers]);
    const p = createLlmProvider(s({ llmProvider: 'openai', llmModel: 'qwen3:8b' }), f.invoke, listen)!;
    const onRetry = vi.fn();
    await expect(p.chatStream!(msgs, { tools: [tool], onRetry }, () => {})).rejects.toBeInstanceOf(ReasoningLoopError);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('a timeout after reasoning only is retried with thinking off; one after answer text is not', async () => {
    const stalls = (emit: (d: string) => void) => {
      emit(sse({ reasoning_content: 'thinking a long time' }));
      throw { kind: 'timeout', message: 'm' };
    };
    const a = streaming([stalls, answers]);
    const p = createLlmProvider(s({ llmProvider: 'openai', llmModel: 'qwen3:8b', llmThinking: 'on' }), a.f.invoke, a.listen)!;
    expect((await p.chatStream!(msgs, undefined, () => {})).content).toBe('done');

    const wrote = (emit: (d: string) => void) => {
      emit(sse({ content: 'half' }));
      throw { kind: 'timeout', message: 'm' };
    };
    const b = streaming([wrote, answers]);
    const q = createLlmProvider(s({ llmProvider: 'openai', llmModel: 'qwen3:8b', llmThinking: 'on' }), b.f.invoke, b.listen)!;
    await expect(q.chatStream!(msgs, undefined, () => {})).rejects.toMatchObject({ kind: 'timeout' });
    expect(bodies(b.f.calls, 'llm_chat_stream')).toHaveLength(1);
  });

  it('ollama retries with think false', async () => {
    const l = fakeListen();
    let i = 0;
    const f = fakeInvoke({
      llm_chat_stream: (a) => {
        const id = String(a.requestId);
        if (i++ === 0) {
          l.emit(id, JSON.stringify({ message: { thinking: LOOP } }));
        } else {
          l.emit(id, JSON.stringify({ message: { content: 'ok' }, done: true }));
        }
        return { status: 200, done: true, frames: 1 };
      },
    });
    const p = createLlmProvider(s({ llmProvider: 'ollama', llmModel: 'qwen3:8b', llmThinking: 'on' }), f.invoke, l.listen)!;
    expect((await p.chatStream!(msgs, undefined, () => {})).content).toBe('ok');
    const sent = bodies(f.calls, 'llm_chat_stream');
    expect(sent[0].think).toBe(true);
    expect(sent[1].think).toBe(false);
  });
});
