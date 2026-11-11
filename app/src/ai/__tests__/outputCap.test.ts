/**
 * 출력 한도(real-server check, 2026-11-11): 앱이 max_tokens 를 보내지 않아 고리에 빠진 요청이 LLM_TIMEOUT(300초) 내내
 * 수 MB 를 흘렸다. 이제 모든 요청이 작업에 맞는 한도(OpenAI 호환 max_tokens, Ollama num_predict)를 보내고, 생각을 켠
 * vLLM 요청은 thinking_token_budget 도 보낸다(400/422 면 다른 추가 필드처럼 빼고 다시). 한도에서 멈춘 빈 답은 분명한 글이다.
 * Rust 는 가짜 invoke/listen 이다.
 */
import type { ToolDef } from '@labnoteo/core';
import { describe, expect, it, vi } from 'vitest';
import { t } from '../../i18n/t';
import { fakeInvoke } from '../../integrations/__tests__/fakeNet';
import type { ListenFn, LlmFrame } from '../../integrations/netIpc';
import { describeLlmError, OutputLimitError } from '../../labnote/port/llmError';
import {
  createLlmProvider,
  outputTokens,
  OUTPUT_TOKENS_COMPACT,
  OUTPUT_TOKENS_MIN,
  OUTPUT_TOKENS_TEXT,
  OUTPUT_TOKENS_TOOLS,
  type ChatMessage,
} from '../../labnote/port/llmProvider';
import { cleanMaxOutputTokens, fromStored, parseMaxOutputTokensInput, type AppSettings } from '../../labnote/settings';
import { assembleOllama, assembleOpenAi } from '../streamAssembler';

const base: AppSettings = fromStored({});
const s = (over: Partial<AppSettings>): AppSettings => ({ ...base, ...over });
const msgs: ChatMessage[] = [{ role: 'user', content: 'x' }];
const tool = {
  name: 'get_experiment_context',
  description: 'd',
  inputSchema: { type: 'object', properties: {} },
  handler: async () => ({ ok: true }),
} as unknown as ToolDef;
const BIG = { llmContextWindow: 262_144 };

function bodies(calls: Array<[string, Record<string, unknown>]>, cmd = 'llm_chat'): Array<Record<string, unknown>> {
  return calls.filter(([c]) => c === cmd).map(([, a]) => JSON.parse(JSON.stringify(a.body)) as Record<string, unknown>);
}
const okOpenai = () => fakeInvoke({ llm_chat: () => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content: 'x' } }] }) }) });
const okOllama = () => fakeInvoke({ llm_chat: () => ({ status: 200, text: JSON.stringify({ message: { content: 'x' } }) }) });

describe('max output tokens setting', () => {
  it('defaults to blank (null) and keeps only whole numbers from 256', () => {
    expect(base.llmMaxOutputTokens).toBeNull();
    expect(fromStored({ llmMaxOutputTokens: 16384 }).llmMaxOutputTokens).toBe(16384);
    expect(fromStored({ llmMaxOutputTokens: 100 }).llmMaxOutputTokens).toBeNull();
    expect(fromStored({ llmMaxOutputTokens: 1.5 }).llmMaxOutputTokens).toBeNull();
    expect(cleanMaxOutputTokens('4096')).toBeNull();
  });

  it('parses the typed field: blank, digits with separators, anything else invalid', () => {
    expect(parseMaxOutputTokensInput('  ')).toBeNull();
    expect(parseMaxOutputTokensInput('32,768')).toBe(32768);
    expect(parseMaxOutputTokensInput('8192')).toBe(8192);
    expect(parseMaxOutputTokensInput('12')).toBe('invalid');
    expect(parseMaxOutputTokensInput('4k')).toBe('invalid');
    expect(parseMaxOutputTokensInput('-1')).toBe('invalid');
  });
});

describe('outputTokens', () => {
  it('per task: tool turns 4096, text 8192, an explicit task value (compaction 2048)', () => {
    expect(outputTokens(s(BIG), msgs, { tools: [tool] })).toBe(OUTPUT_TOKENS_TOOLS);
    expect(outputTokens(s(BIG), msgs, undefined)).toBe(OUTPUT_TOKENS_TEXT);
    expect(outputTokens(s(BIG), msgs, { maxTokens: OUTPUT_TOKENS_COMPACT })).toBe(2048);
  });

  it('a saved number replaces the task value for every request', () => {
    const v = s({ ...BIG, llmMaxOutputTokens: 20000 });
    expect(outputTokens(v, msgs, { tools: [tool] })).toBe(20000);
    expect(outputTokens(v, msgs, { maxTokens: 2048 })).toBe(20000);
  });

  it('never above the context window minus the prompt estimate, and never below the floor', () => {
    const long: ChatMessage[] = [{ role: 'user', content: 'a'.repeat(4 * 6000) }];
    const cap = outputTokens(s({ llmContextWindow: 8192 }), long, undefined);
    expect(cap).toBeLessThanOrEqual(8192 - 6000);
    expect(cap).toBeGreaterThan(2000);
    const huge: ChatMessage[] = [{ role: 'user', content: 'a'.repeat(4 * 9000) }];
    expect(outputTokens(s({ llmContextWindow: 8192 }), huge, undefined)).toBe(OUTPUT_TOKENS_MIN);
    // The user's cap is bounded too.
    expect(outputTokens(s({ llmContextWindow: 8192, llmMaxOutputTokens: 32768 }), msgs, undefined)).toBeLessThan(8192);
  });
});

describe('request bodies carry the cap', () => {
  it('openai: max_tokens on every request, sized per task', async () => {
    const f = okOpenai();
    const p = createLlmProvider(s({ ...BIG, llmProvider: 'openai', llmModel: 'm' }), f.invoke)!;
    await p.chat(msgs, { tools: [tool] });
    await p.chat(msgs);
    await p.chat(msgs, { maxTokens: OUTPUT_TOKENS_COMPACT });
    expect(bodies(f.calls).map((b) => b.max_tokens)).toEqual([4096, 8192, 2048]);
  });

  it('ollama: options.num_predict', async () => {
    const f = okOllama();
    await createLlmProvider(s({ ...BIG, llmProvider: 'ollama', llmModel: 'llama3.1' }), f.invoke)!.chat(msgs, { tools: [tool] });
    expect((bodies(f.calls)[0].options as Record<string, unknown>).num_predict).toBe(4096);
    expect(bodies(f.calls)[0].max_tokens).toBeUndefined();
  });

  it('thinking on (vLLM): thinking_token_budget is half the cap at most 4096; never with thinking off', async () => {
    const f = okOpenai();
    const on = createLlmProvider(s({ ...BIG, llmProvider: 'openai', llmModel: 'qwen3.6-35b-a3b', llmThinking: 'on' }), f.invoke)!;
    await on.chat(msgs);
    await on.chat(msgs, { tools: [tool] });
    const off = createLlmProvider(s({ ...BIG, llmProvider: 'openai', llmModel: 'qwen3.6-35b-a3b' }), f.invoke)!;
    await off.chat(msgs, { tools: [tool] });
    const sent = bodies(f.calls);
    expect(sent[0].thinking_token_budget).toBe(4096);
    expect(sent[1].thinking_token_budget).toBe(2048);
    expect(sent[2].thinking_token_budget).toBeUndefined();
  });

  it('a 400 to thinking_token_budget is sent once more without it (and the other extras); max_tokens stays', async () => {
    const f = fakeInvoke({
      llm_chat: (a) => {
        const body = a.body as Record<string, unknown>;
        if ('thinking_token_budget' in body) throw { kind: 'status', message: 'm', status: 400, body: 'unknown field thinking_token_budget' };
        return { status: 200, text: JSON.stringify({ choices: [{ message: { content: 'ok' } }] }) };
      },
    });
    const p = createLlmProvider(s({ ...BIG, llmProvider: 'openai', llmModel: 'qwen3:8b', llmThinking: 'on' }), f.invoke)!;
    expect((await p.chat(msgs)).content).toBe('ok');
    const sent = bodies(f.calls);
    expect(sent).toHaveLength(2);
    expect(sent[1].thinking_token_budget).toBeUndefined();
    expect(sent[1].max_tokens).toBe(8192);
  });
});

describe('a reply cut at the cap', () => {
  it('the assemblers flag finish_reason / done_reason length', () => {
    const cut = assembleOpenAi([JSON.stringify({ choices: [{ index: 0, delta: { content: 'part' }, finish_reason: 'length' }] })]);
    expect(cut).toEqual({ content: 'part', toolCalls: [], truncated: true });
    const done = assembleOpenAi([JSON.stringify({ choices: [{ index: 0, delta: { content: 'all' }, finish_reason: 'stop' }] })]);
    expect(done.truncated).toBeUndefined();
    expect(assembleOllama([JSON.stringify({ message: { content: '' }, done: true, done_reason: 'length' })]).truncated).toBe(true);
  });

  it('with no answer text it is an OutputLimitError with a clear sentence; with text the text is kept', async () => {
    const empty = fakeInvoke({
      llm_chat: () => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content: '', reasoning: 'hmm' }, finish_reason: 'length' }] }) }),
    });
    const settings = s({ llmProvider: 'openai', llmEndpointOpenai: 'https://llm.example.test', llmModel: 'm' });
    const err = await createLlmProvider(settings, empty.invoke)!.chat(msgs).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OutputLimitError);
    const sentence = describeLlmError(err, settings, (k) => k);
    expect(sentence).toBe(t('ai.outputLimit', `${t('cmd.integrationSettings')} → ${t('integrations.aiProvider')} → ${t('integrations.ai.advanced')} → ${t('integrations.ai.maxOutput')}`));
    expect(sentence).not.toContain('llm.example.test');

    const partial = fakeInvoke({
      llm_chat: () => ({ status: 200, text: JSON.stringify({ message: { content: 'half an answer' }, done_reason: 'length' }) }),
    });
    const r = await createLlmProvider(s({ llmProvider: 'ollama', llmModel: 'm' }), partial.invoke)!.chat(msgs);
    expect(r).toMatchObject({ content: 'half an answer', truncated: true });
  });

  it('a streamed request that asked for thinking and used the cap on reasoning is sent once more with thinking off', async () => {
    const handlers = new Set<(e: { payload: LlmFrame }) => void>();
    const listen = (async (_n: string, h: (e: { payload: LlmFrame }) => void) => {
      handlers.add(h);
      return () => handlers.delete(h);
    }) as unknown as ListenFn;
    const emit = (id: string, data: string) => handlers.forEach((h) => h({ payload: { requestId: id, data } }));
    let i = 0;
    const f = fakeInvoke({
      llm_chat_stream: (a) => {
        const id = String(a.requestId);
        if (i++ === 0) emit(id, JSON.stringify({ choices: [{ index: 0, delta: { reasoning: 'thinking…' }, finish_reason: 'length' }] }));
        else emit(id, JSON.stringify({ choices: [{ index: 0, delta: { content: 'done' }, finish_reason: 'stop' }] }));
        return { status: 200, done: true, frames: 1 };
      },
    });
    const p = createLlmProvider(s({ ...BIG, llmProvider: 'openai', llmModel: 'qwen3:8b', llmThinking: 'on' }), f.invoke, listen)!;
    const onRetry = vi.fn();
    const r = await p.chatStream!(msgs, { onRetry }, () => {});
    expect(r.content).toBe('done');
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(bodies(f.calls, 'llm_chat_stream')[1].chat_template_kwargs).toEqual({ enable_thinking: false });
  });
});
