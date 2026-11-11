/**
 * 스트리밍 답 조립기(spec §6.2, ruling R1). Rust(`net/stream.rs`)는 받은 프레임을 그대로 `llm://frame` 으로
 * 넘기고, 여기서 비스트리밍 답과 같은 {@link ChatResult} 로 모은다.
 *
 * - OpenAI 호환(SSE): 프레임마다 `choices[0].delta` 의 `content` 를 잇고, `tool_calls[i]` 는 `index` 로 합친다
 *   (`id` 는 처음 온 값, `function.name` 은 비어 있을 때 채우고, `function.arguments` 문자열은 이어 붙인다).
 *   생각 글은 `reasoning_content` 나 `reasoning`(vLLM) 이다. 생각만 있고 답이 없으면 `thinkingOnly`.
 * - Ollama(NDJSON): 줄마다 `message.content` 를 잇고, `message.tool_calls` 는 나온 줄(보통 마지막 줄)에서 모은다.
 *   `message.thinking` 만 있고 답이 없으면 `thinkingOnly`.
 * - 생각 글이 같은 대목을 되풀이하면(생각 고리) {@link ReasoningLoopError} 를 던진다: `llmChatStream` 이 요청을 멈추고
 *   그 오류로 거절한다. 고리에 빠진 모델은 LLM_TIMEOUT(300초) 내내 생각만 흘리다 "연결할 수 없다"로 끝났다(real-app check).
 * - `reasoningOnly()` 는 생각 글만 왔는지 알려 준다: 그때의 시간 초과는 llmProvider 가 생각을 끄고 한 번 더 보낸다.
 * - `finish_reason`(OpenAI) 이나 `done_reason`(Ollama) 이 'length' 면 결과에 `truncated` 를 단다(출력 한도에서 멈춘 답).
 * - `[DONE]` 과 JSON 이 아닌 프레임은 건너뛴다. `error` 가 든 프레임은 `NetError('remote')`(글은 500자까지).
 *
 * labnote/port/ 밖에 둔다: provenance 가드는 그 폴더의 모든 파일에 `// Ported from` 머리를 요구한다.
 */
import { NetError } from '../integrations/netIpc';
import { ReasoningLoopError } from '../labnote/port/llmError';
import { parseToolArguments, type ChatResult, type ToolCall } from '../labnote/port/llmProvider';

export { ReasoningLoopError };

/** 서버가 보낸 오류 글을 보여 줄 수 있는 길이로 자른다(Rust bfw 와 같은 500자). */
const REMOTE_MESSAGE_MAX = 500;

/** 프레임 하나를 처리하고 새로 붙은 답 글(없으면 '')을 돌려준다. 끝나면 `result()`. */
export interface StreamAssembler {
  push(data: string): string;
  result(): ChatResult;
  /** 지금까지 생각 글만 오고 답 글도 도구 호출도 없었다(생각만 하다 시간이 다 된 요청을 가린다). */
  reasoningOnly(): boolean;
}

type Json = Record<string, unknown>;

function asObject(v: unknown): Json | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined;
}

function parseFrame(data: string): Json | undefined {
  const text = data.trim();
  if (!text || text === '[DONE]') return undefined;
  try {
    return asObject(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/** `{error: "..."}` 이나 `{error: {message}}` 면 remote 로 던진다. */
function throwIfError(frame: Json): void {
  if (frame.error === undefined || frame.error === null) return;
  const e = frame.error;
  const raw = typeof e === 'string' ? e : typeof asObject(e)?.message === 'string' ? String(asObject(e)!.message) : 'the AI server reported an error';
  const message = raw.trim() ? raw.slice(0, REMOTE_MESSAGE_MAX) : 'the AI server reported an error';
  throw new NetError('remote', message);
}

/** 고리로 보는 끝 대목의 길이(글자), 그 대목이 최근 글에 나와야 하는 횟수, 살펴보는 최근 글의 길이, 살펴보는 간격. */
const LOOP_TAIL = 240;
const LOOP_REPEATS = 4;
const LOOP_WINDOW = 24_000;
const LOOP_STEP = 400;

/**
 * 생각 글을 모으고 고리를 살핀다: 끝의 `LOOP_TAIL` 자가 최근 `LOOP_WINDOW` 자 안에 `LOOP_REPEATS` 번 이상 그대로 나오면
 * 던진다. 긴 생각이라도 같은 240자를 네 번 그대로 쓰지는 않는다. `LOOP_STEP` 자마다 한 번만 살핀다.
 */
class Thinking {
  text = '';
  private checkedAt = 0;

  add(piece: string): void {
    this.text += piece;
    if (this.text.length - this.checkedAt < LOOP_STEP || this.text.length < LOOP_TAIL * LOOP_REPEATS) return;
    this.checkedAt = this.text.length;
    const recent = this.text.slice(-LOOP_WINDOW);
    const tail = recent.slice(-LOOP_TAIL);
    let count = 0;
    for (let at = recent.indexOf(tail); at !== -1; at = recent.indexOf(tail, at + LOOP_TAIL)) {
      if (++count >= LOOP_REPEATS) throw new ReasoningLoopError();
    }
  }
}

function finish(content: string, toolCalls: ToolCall[], thinking: string, truncated: boolean): ChatResult {
  const thinkingOnly = toolCalls.length === 0 && !content.trim() && thinking.trim() !== '';
  return { content, toolCalls, ...(thinkingOnly ? { thinkingOnly: true } : {}), ...(truncated ? { truncated: true } : {}) };
}

interface PartialCall {
  id: string;
  name: string;
  args: string;
  /** 인자를 문자열 조각이 아니라 객체로 보내는 서버도 있다. */
  argsObject?: Json;
}

export class OpenAiAssembler implements StreamAssembler {
  private content = '';
  private readonly thinking = new Thinking();
  private readonly calls = new Map<number, PartialCall>();
  private truncated = false;

  push(data: string): string {
    const frame = parseFrame(data);
    if (!frame) return '';
    throwIfError(frame);
    const choices = Array.isArray(frame.choices) ? frame.choices : [];
    if (asObject(choices[0])?.finish_reason === 'length') this.truncated = true;
    const delta = asObject(asObject(choices[0])?.delta);
    if (!delta) return '';
    if (typeof delta.reasoning_content === 'string') this.thinking.add(delta.reasoning_content);
    else if (typeof delta.reasoning === 'string') this.thinking.add(delta.reasoning);
    if (Array.isArray(delta.tool_calls)) {
      delta.tool_calls.forEach((raw: unknown, pos: number) => {
        const c = asObject(raw);
        if (!c) return;
        const index = typeof c.index === 'number' ? c.index : pos;
        const part = this.calls.get(index) ?? { id: '', name: '', args: '' };
        if (typeof c.id === 'string' && c.id && !part.id) part.id = c.id;
        const fn = asObject(c.function);
        if (typeof fn?.name === 'string' && fn.name && !part.name) part.name = fn.name;
        if (typeof fn?.arguments === 'string') part.args += fn.arguments;
        else if (asObject(fn?.arguments)) part.argsObject = asObject(fn?.arguments);
        this.calls.set(index, part);
      });
    }
    const piece = typeof delta.content === 'string' ? delta.content : '';
    this.content += piece;
    return piece;
  }

  result(): ChatResult {
    const toolCalls = [...this.calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, p], i) => ({
        id: p.id || `call_${i}`,
        name: p.name,
        arguments: p.argsObject ?? parseToolArguments(p.args),
      }))
      .filter((c) => c.name !== '');
    return finish(this.content, toolCalls, this.thinking.text, this.truncated);
  }

  reasoningOnly(): boolean {
    return this.thinking.text.trim() !== '' && !this.content && this.calls.size === 0;
  }
}

export class OllamaAssembler implements StreamAssembler {
  private content = '';
  private readonly thinking = new Thinking();
  private readonly calls: ToolCall[] = [];
  private truncated = false;

  push(data: string): string {
    const frame = parseFrame(data);
    if (!frame) return '';
    throwIfError(frame);
    if (frame.done_reason === 'length') this.truncated = true;
    const message = asObject(frame.message);
    if (!message) return '';
    if (typeof message.thinking === 'string') this.thinking.add(message.thinking);
    if (Array.isArray(message.tool_calls)) {
      for (const raw of message.tool_calls) {
        const fn = asObject(asObject(raw)?.function);
        if (typeof fn?.name !== 'string' || !fn.name) continue;
        const id = asObject(raw)?.id;
        this.calls.push({
          id: typeof id === 'string' && id ? id : `call_${this.calls.length}`,
          name: fn.name,
          arguments: parseToolArguments(fn.arguments),
        });
      }
    }
    const piece = typeof message.content === 'string' ? message.content : '';
    this.content += piece;
    return piece;
  }

  result(): ChatResult {
    return finish(this.content, [...this.calls], this.thinking.text, this.truncated);
  }

  reasoningOnly(): boolean {
    return this.thinking.text.trim() !== '' && !this.content && this.calls.length === 0;
  }
}

/** SSE 프레임 전부를 한 번에 모은다. */
export function assembleOpenAi(frames: readonly string[]): ChatResult {
  const a = new OpenAiAssembler();
  for (const f of frames) a.push(f);
  return a.result();
}

/** NDJSON 줄 전부를 한 번에 모은다. */
export function assembleOllama(lines: readonly string[]): ChatResult {
  const a = new OllamaAssembler();
  for (const l of lines) a.push(l);
  return a.result();
}

/**
 * 생각 글만 흘리다 시간이 다 된 요청. 종류는 그대로 `NetError('timeout')` 이라 사용자에게는 ai.timeout 이다. llmProvider 가
 * 이것을 보고 생각을 끄고 한 번 더 보낸다.
 */
export class ReasoningStall extends NetError {
  constructor() {
    super('timeout', 'the model only reasoned until the time limit');
  }
}
