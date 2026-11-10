/**
 * 스트리밍 조립기(spec §6.2, plan Task 6). Rust 는 SSE/NDJSON 프레임을 그대로 넘기고, 여기서 비스트리밍과
 * 같은 ChatResult 로 모은다.
 */
import { describe, expect, it } from 'vitest';
import { NetError } from '../../integrations/netIpc';
import {
  OllamaAssembler,
  OpenAiAssembler,
  assembleOllama,
  assembleOpenAi,
} from '../streamAssembler';

const sse = (delta: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta, ...extra }] });

describe('assembleOpenAi', () => {
  it('joins content deltas, Korean included, and ignores [DONE]', () => {
    const frames = [sse({ role: 'assistant', content: '' }), sse({ content: '안녕' }), sse({ content: '하세요.' }), sse({}, { finish_reason: 'stop' }), '[DONE]'];
    expect(assembleOpenAi(frames)).toEqual({ content: '안녕하세요.', toolCalls: [] });
  });

  it('merges tool-call deltas split by index', () => {
    const frames = [
      sse({ role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'read_note', arguments: '' } }] }),
      sse({ tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'update_section', arguments: '{"heading":' } }] }),
      sse({ tool_calls: [{ index: 0, function: { arguments: '{"path":"실험/a' } }] }),
      sse({ tool_calls: [{ index: 1, function: { arguments: '"결과"}' } }] }),
      sse({ tool_calls: [{ index: 0, function: { arguments: '.md"}' } }] }),
      sse({}, { finish_reason: 'tool_calls' }),
      '[DONE]',
    ];
    expect(assembleOpenAi(frames)).toEqual({
      content: '',
      toolCalls: [
        { id: 'call_a', name: 'read_note', arguments: { path: '실험/a.md' } },
        { id: 'call_b', name: 'update_section', arguments: { heading: '결과' } },
      ],
    });
  });

  it('synthesizes missing ids, drops nameless calls and turns bad JSON into {}', () => {
    const frames = [
      sse({ tool_calls: [{ index: 0, function: { name: 'a', arguments: '{bad' } }] }),
      sse({ tool_calls: [{ index: 1, function: { arguments: '{}' } }] }),
    ];
    expect(assembleOpenAi(frames).toolCalls).toEqual([{ id: 'call_0', name: 'a', arguments: {} }]);
  });

  it('marks a reasoning-only reply thinkingOnly', () => {
    expect(assembleOpenAi([sse({ reasoning_content: 'hmm' }), sse({ reasoning_content: '...' })])).toEqual({
      content: '',
      toolCalls: [],
      thinkingOnly: true,
    });
  });

  it('push returns each content delta in order; non-JSON frames are skipped', () => {
    const a = new OpenAiAssembler();
    expect([a.push(sse({ content: '가' })), a.push(': keepalive'), a.push(sse({ content: '나' })), a.push('[DONE]')]).toEqual(['가', '', '나', '']);
    expect(a.result().content).toBe('가나');
  });

  it('an error frame throws remote with the message', () => {
    const a = new OpenAiAssembler();
    expect(() => a.push(JSON.stringify({ error: { message: 'model overloaded' } }))).toThrow(NetError);
    try {
      a.push(JSON.stringify({ error: { message: 'x'.repeat(900) } }));
    } catch (e) {
      expect((e as NetError).kind).toBe('remote');
      expect((e as NetError).message.length).toBe(500);
    }
  });
});

describe('assembleOllama', () => {
  it('joins content lines and takes tool_calls from the final line', () => {
    const lines = [
      JSON.stringify({ model: 'm', message: { role: 'assistant', content: '실험 ' }, done: false }),
      JSON.stringify({ model: 'm', message: { role: 'assistant', content: '노트' }, done: false }),
      JSON.stringify({
        model: 'm',
        message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_note', arguments: { path: 'a.md' } } }] },
        done: true,
      }),
    ];
    expect(assembleOllama(lines)).toEqual({
      content: '실험 노트',
      toolCalls: [{ id: 'call_0', name: 'read_note', arguments: { path: 'a.md' } }],
    });
  });

  it('marks thinking-only and streams content deltas', () => {
    const a = new OllamaAssembler();
    expect(a.push(JSON.stringify({ message: { content: '', thinking: 'hmm' }, done: false }))).toBe('');
    expect(a.push(JSON.stringify({ message: { content: '' }, done: true }))).toBe('');
    expect(a.result()).toEqual({ content: '', toolCalls: [], thinkingOnly: true });
    const b = new OllamaAssembler();
    expect(b.push(JSON.stringify({ message: { content: '응' }, done: false }))).toBe('응');
  });

  it('an error line throws remote', () => {
    expect(() => assembleOllama([JSON.stringify({ error: 'model not found' })])).toThrow(
      expect.objectContaining({ kind: 'remote', message: 'model not found' }),
    );
  });
});
