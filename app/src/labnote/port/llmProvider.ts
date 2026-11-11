// Ported from app/vendor/labnoteo/src/llm/provider.ts:27-267 sha256:50318941b2f8b631
// labnoteO 0.140.2, Apache-2.0.
// Changes: requestUrl({url, method, headers, body, throw:false}) → llmChat({provider, body, signal}) (integrations/netIpc), so the webview never names a host or holds a key: Rust builds the URL (joinUrl(endpoint, '/api/chat' | '/v1/chat/completions'), with https:// for a scheme-less non-loopback host, D8) and the Authorization: Bearer header from the stored settings and Windows Credential Manager (Task 6); joinUrl is kept for display and tests only; openaiBase (new, app only) mirrors Rust's openai_base so a displayed OpenAI-compatible URL drops one final /v1 segment of the endpoint before /v1/... is appended, as Rust does (C-R1); a NetError of kind status → LlmHttpError('Ollama' | 'OpenAI', status, body), every other NetError kind is rethrown as is for describeLlmError, and a 2xx text that is not JSON → NetError('notJson') where Obsidian's res.json threw; ChatOptions gains signal (cancels through net_cancel); LabnoteSettings → AppSettings, which has no llmApiKey, so OpenAiProvider no longer builds headers; LlmProvider gains label ('Ollama' | 'OpenAI-compatible', for the progress title) and model; createLlmProvider takes an optional invoke for tests. ChatOptions gains contextWindow (feat/ai-context): Ollama merges it into options as num_ctx beside temperature; the OpenAI body ignores it. Task 6 (assistant spec §6.2, app only): LlmProvider gains an optional chatStream(messages, opts, onDelta), implemented by both providers: the same body with stream: true goes to llmChatStream (llm_chat_stream + llm://frame events, integrations/netIpc), the frames are assembled by ../../ai/streamAssembler (OpenAI SSE tool-call deltas merged by index, Ollama NDJSON) into the same ChatResult, and each content delta goes to onDelta in order; a 2xx JSON answer (stream ignored) is read like chat's; a non-2xx answer, or a status/notJson error, before the first frame falls back to one non-streamed chat (never after a frame, never on a network error). chat's body building and reply reading are factored into body()/read() so both paths share them; createLlmProvider takes an optional listen for tests. The JSON body is otherwise built and the reply parsed as in the vendor file.
import type { ToolDef } from '@labnoteo/core';
import { llmChat, llmChatStream, NetError, type InvokeFn, type ListenFn } from '../../integrations/netIpc';
import { OllamaAssembler, OpenAiAssembler, type StreamAssembler } from '../../ai/streamAssembler';
import { recommendedSampling, type AppSettings } from '../settings';
import { LlmHttpError } from './llmError';

/** One tool invocation the model asked for, in provider-neutral form. */
export interface ToolCall {
  /**
   * Correlates a result with its request. Synthesized for Ollama, which omits
   * ids — it pairs results by tool name instead.
   */
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Assistant turn: the tools the model wants run before it can continue. */
  toolCalls?: ToolCall[];
  /** Tool turn: the id of the call this answers (OpenAI pairs on this). */
  toolCallId?: string;
  /** Tool turn: the name of the tool that ran (Ollama pairs on this). */
  toolName?: string;
}

/**
 * A model turn. `toolCalls` is empty for a normal completion; when it is not,
 * the caller must run the tools and send the results back as `role: 'tool'`
 * messages before the model will produce its answer.
 */
export interface ChatResult {
  content: string;
  toolCalls: ToolCall[];
  /**
   * True when a thinking model spent the reply on reasoning and left `content`
   * empty (#195), so callers can say why there is no answer.
   */
  thinkingOnly?: boolean;
}

export interface ChatOptions {
  temperature?: number;
  /** Tools to offer the model. Omitted entirely for a plain completion. */
  tools?: ToolDef[];
  /** Aborting cancels the request in Rust (`net_cancel`) and rejects with `NetError('cancelled')`. */
  signal?: AbortSignal;
  /**
   * The model's context window in tokens (`llmContextWindow`). Ollama gets it as
   * `options.num_ctx`; the OpenAI-compatible body ignores it. Omitted → the body is unchanged.
   */
  contextWindow?: number;
}

/** Ollama's `options`: temperature, top_p and num_ctx when given, otherwise omitted. */
function ollamaOptions(opts: ChatOptions | undefined, topP: number | undefined): Record<string, number> | undefined {
  const out: Record<string, number> = {};
  if (opts?.temperature != null) out.temperature = opts.temperature;
  if (topP != null) out.top_p = topP;
  if (opts?.contextWindow != null) out.num_ctx = opts.contextWindow;
  return Object.keys(out).length ? out : undefined;
}

/**
 * The sampling a request sends. The vault's `llmTemperature` when it is set (Settings > Integrations > AI provider >
 * Advanced, real-server check 2026-11-11: thinking models such as qwen3 loop at 0.2) always wins and adds no top_p.
 * Blank: the model's recommended sampling when it has one (settings recommendedSampling: qwen3 → 0.6, top_p 0.95),
 * else what the caller asked for, as before. Every LLM call goes through a provider body, so this covers them all.
 */
function samplingOf(settings: AppSettings, opts: ChatOptions | undefined): { temperature: number | undefined; topP: number | undefined } {
  if (settings.llmTemperature != null) return { temperature: settings.llmTemperature, topP: undefined };
  const rec = recommendedSampling(settings.llmModel);
  if (rec) return { temperature: rec.temperature, topP: rec.topP };
  return { temperature: opts?.temperature, topP: undefined };
}

export interface LlmProvider {
  /** `'ollama'` or `'openai'`, as the plugin's `provider.name`. */
  readonly name: 'ollama' | 'openai';
  /** What the UI calls it: 'Ollama' or 'OpenAI-compatible' (not translated, D22). */
  readonly label: string;
  /** The model the request names (`llmModel`). */
  readonly model: string;
  chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResult>;
  /**
   * The same turn, streamed (app only, spec §6.2): `onDelta` gets each piece of answer text in order, and the
   * result equals what `chat` would return. Falls back to one `chat` when the provider refuses the stream
   * before any frame arrived.
   */
  chatStream?(messages: ChatMessage[], opts: ChatOptions | undefined, onDelta: (text: string) => void): Promise<ChatResult>;
}

/**
 * Join a base URL and path with exactly one slash between them. A base without
 * a scheme (`localhost:11434`, as Ollama's own docs write it) gets `http://`
 * (#203). In the app this is for display and tests only: Rust builds the real
 * URL, and gives a scheme-less non-loopback host `https://` instead (D8).
 */
export function joinUrl(base: string, path: string): string {
  const trimmed = base.trim().replace(/\/+$/, '');
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  return withScheme + '/' + path.replace(/^\/+/, '');
}

/**
 * The base of an OpenAI-compatible endpoint, as Rust's `openai_base` takes it
 * (C-R1): one final path segment exactly `v1` (case-sensitive, with or without
 * a trailing `/`) is dropped, so `https://host/v1` and `https://host` name the
 * same server. Trailing slashes go too; the host is never taken for a segment.
 * Anything else, a pasted `/v1/chat/completions` included, is left as typed.
 */
export function openaiBase(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/+$/, '');
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(trimmed)?.[0] ?? '';
  const rest = trimmed.slice(scheme.length);
  const slash = rest.indexOf('/');
  if (slash < 0) return trimmed;
  const path = rest.slice(slash);
  return path.endsWith('/v1') ? scheme + rest.slice(0, slash) + path.slice(0, -'/v1'.length) : trimmed;
}

/** True when the reply has reasoning text but no answer. */
function isThinkingOnly(content: unknown, thinking: unknown): boolean {
  return !(typeof content === 'string' && content.trim()) && typeof thinking === 'string' && thinking.trim() !== '';
}

/**
 * Wire format for the `tools` request field. Ollama adopted OpenAI's shape, so
 * one serialization serves both.
 */
export function toolSchemas(tools: ToolDef[]): unknown[] {
  return tools.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
}

/**
 * Coerce a tool call's arguments to an object.
 *
 * OpenAI sends a JSON *string*, Ollama sends an object, and a model can emit
 * malformed JSON in either. An unparseable payload becomes `{}` so the handler
 * reports a missing-argument error the model can recover from, rather than the
 * loop dying on a `SyntaxError`.
 */
export function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

interface RawToolCall {
  id?: unknown;
  function?: { name?: unknown; arguments?: unknown };
}

/** Normalize a provider's `tool_calls` array, synthesizing ids where absent. */
function normalizeToolCalls(raw: unknown): ToolCall[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((call: RawToolCall, i) => ({
      id: typeof call?.id === 'string' && call.id ? call.id : `call_${i}`,
      name: typeof call?.function?.name === 'string' ? call.function.name : '',
      arguments: parseToolArguments(call?.function?.arguments),
    }))
    .filter(c => c.name !== '');
}

/** The reply fields both providers read. The vendor file read them off Obsidian's untyped `res.json`. */
interface WireMessage {
  content?: string | null;
  tool_calls?: unknown;
  thinking?: unknown;
  reasoning_content?: unknown;
}

interface WireReply {
  message?: WireMessage;
  choices?: Array<{ message?: WireMessage }>;
}

/**
 * `llm_chat` through Rust. A non-2xx answer (NetError `status`) becomes an
 * {@link LlmHttpError}, as the plugin threw on `res.status >= 400`; every other
 * NetError is rethrown as is. Returns the parsed JSON of the 2xx text.
 */
async function post(
  provider: 'ollama' | 'openai',
  errorName: string,
  body: unknown,
  signal: AbortSignal | undefined,
  invoke: InvokeFn | undefined
): Promise<WireReply | null> {
  let res: { status: number; text: string };
  try {
    res = await llmChat({ provider, body, signal }, invoke);
  } catch (e) {
    if (e instanceof NetError && e.kind === 'status') {
      throw new LlmHttpError(errorName, e.status ?? 0, e.body ?? '');
    }
    throw e;
  }
  if (res.status >= 400) {
    throw new LlmHttpError(errorName, res.status, res.text);
  }
  try {
    return JSON.parse(res.text) as WireReply | null;
  } catch {
    throw new NetError('notJson', 'the AI reply is not JSON');
  }
}

/**
 * HTTP statuses before the first frame that suggest the server refused `stream: true`. Others (401, 403, 429,
 * 5xx) would fail the same way without streaming, so they are reported at once instead of sending a second request.
 */
const STREAM_REFUSED_STATUS: ReadonlySet<number> = new Set([400, 404, 405, 415, 422, 501]);

/** An error before the first frame that means "this server will not stream", not "the network failed". */
function streamRefused(e: unknown): boolean {
  if (!(e instanceof NetError)) return false;
  return e.kind === 'notJson' || (e.kind === 'status' && STREAM_REFUSED_STATUS.has(e.status ?? 0));
}

/**
 * `llm_chat_stream` through Rust (app only, spec §6.2). Frames go through `asm`; each content delta goes to
 * `onDelta`. A 2xx JSON text (the server ignored `stream: true`) is read by `read`. A status in
 * `STREAM_REFUSED_STATUS`, or a `notJson` error, before the first frame runs `fallback` (one non-streamed call)
 * instead. An error frame mid-stream (the assembler throws) rejects with that error once the request stops.
 */
async function streamPost(
  provider: 'ollama' | 'openai',
  errorName: string,
  body: Record<string, unknown>,
  signal: AbortSignal | undefined,
  invoke: InvokeFn | undefined,
  listen: ListenFn | undefined,
  asm: StreamAssembler,
  read: (json: WireReply | null) => ChatResult,
  fallback: () => Promise<ChatResult>,
  onDelta: (text: string) => void
): Promise<ChatResult> {
  let frames = 0;
  let end: Awaited<ReturnType<typeof llmChatStream>>;
  try {
    end = await llmChatStream(
      {
        provider,
        body: { ...body, stream: true },
        signal,
        onFrame: (data) => {
          frames += 1;
          const piece = asm.push(data);
          if (piece) onDelta(piece);
        },
      },
      invoke,
      listen
    );
  } catch (e) {
    if (frames === 0 && streamRefused(e)) return deliver(await fallback(), onDelta);
    if (e instanceof NetError && e.kind === 'status') throw new LlmHttpError(errorName, e.status ?? 0, e.body ?? '');
    throw e;
  }
  if (end.status < 200 || end.status >= 300) {
    if (frames === 0 && STREAM_REFUSED_STATUS.has(end.status)) return deliver(await fallback(), onDelta);
    throw new LlmHttpError(errorName, end.status, end.text ?? '');
  }
  if (end.text !== undefined) {
    let json: WireReply | null;
    try {
      json = JSON.parse(end.text) as WireReply | null;
    } catch {
      throw new NetError('notJson', 'the AI reply is not JSON');
    }
    return deliver(read(json), onDelta);
  }
  return asm.result();
}

/** A reply that arrived whole: its text is one delta. */
function deliver(result: ChatResult, onDelta: (text: string) => void): ChatResult {
  if (result.content) onDelta(result.content);
  return result;
}

class OllamaProvider implements LlmProvider {
  readonly name = 'ollama';
  readonly label = 'Ollama';
  constructor(
    private readonly settings: AppSettings,
    private readonly invoke?: InvokeFn,
    private readonly listen?: ListenFn
  ) {}

  get model(): string {
    return this.settings.llmModel;
  }

  /** Ollama keys tool results by `tool_name` and takes arguments as objects. */
  private static toWire(messages: ChatMessage[]): unknown[] {
    return messages.map(m => {
      if (m.role === 'tool') {
        return { role: 'tool', tool_name: m.toolName, content: m.content };
      }
      if (m.toolCalls?.length) {
        return {
          role: m.role,
          content: m.content,
          tool_calls: m.toolCalls.map(c => ({
            function: { name: c.name, arguments: c.arguments },
          })),
        };
      }
      return { role: m.role, content: m.content };
    });
  }

  private body(messages: ChatMessage[], opts?: ChatOptions): Record<string, unknown> {
    const { temperature, topP } = samplingOf(this.settings, opts);
    return {
      model: this.settings.llmModel,
      messages: OllamaProvider.toWire(messages),
      stream: false,
      tools: opts?.tools?.length ? toolSchemas(opts.tools) : undefined,
      options: ollamaOptions({ ...opts, temperature }, topP),
    };
  }

  async chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResult> {
    return this.read(await post('ollama', 'Ollama', this.body(messages, opts), opts?.signal, this.invoke));
  }

  async chatStream(messages: ChatMessage[], opts: ChatOptions | undefined, onDelta: (text: string) => void): Promise<ChatResult> {
    return streamPost(
      'ollama',
      'Ollama',
      this.body(messages, opts),
      opts?.signal,
      this.invoke,
      this.listen,
      new OllamaAssembler(),
      (json) => this.read(json),
      () => this.chat(messages, opts),
      onDelta
    );
  }

  private read(json: WireReply | null): ChatResult {
    const message = json?.message;
    const toolCalls = normalizeToolCalls(message?.tool_calls);
    // Thinking models can spend the whole reply on `thinking` and leave `content` empty (#161).
    const thinkingOnly = toolCalls.length === 0 && isThinkingOnly(message?.content, message?.thinking);
    if (thinkingOnly) {
      console.warn(
        `[labnoteo] Ollama model "${this.settings.llmModel}" returned only "thinking" and no answer content.`
      );
    }
    return {
      content: message?.content ?? '',
      toolCalls,
      ...(thinkingOnly ? { thinkingOnly: true } : {}),
    };
  }
}

class OpenAiProvider implements LlmProvider {
  readonly name = 'openai';
  readonly label = 'OpenAI-compatible';
  constructor(
    private readonly settings: AppSettings,
    private readonly invoke?: InvokeFn,
    private readonly listen?: ListenFn
  ) {}

  get model(): string {
    return this.settings.llmModel;
  }

  /** OpenAI keys tool results by `tool_call_id` and takes arguments as JSON strings. */
  private static toWire(messages: ChatMessage[]): unknown[] {
    return messages.map(m => {
      if (m.role === 'tool') {
        return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
      }
      if (m.toolCalls?.length) {
        return {
          role: m.role,
          content: m.content,
          tool_calls: m.toolCalls.map(c => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: JSON.stringify(c.arguments) },
          })),
        };
      }
      return { role: m.role, content: m.content };
    });
  }

  private body(messages: ChatMessage[], opts?: ChatOptions): Record<string, unknown> {
    const { temperature, topP } = samplingOf(this.settings, opts);
    return {
      model: this.settings.llmModel,
      messages: OpenAiProvider.toWire(messages),
      temperature,
      top_p: topP,
      tools: opts?.tools?.length ? toolSchemas(opts.tools) : undefined,
    };
  }

  async chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResult> {
    // The Authorization header is Rust's: it reads the key from Credential Manager (D6).
    return this.read(await post('openai', 'OpenAI', this.body(messages, opts), opts?.signal, this.invoke));
  }

  async chatStream(messages: ChatMessage[], opts: ChatOptions | undefined, onDelta: (text: string) => void): Promise<ChatResult> {
    return streamPost(
      'openai',
      'OpenAI',
      this.body(messages, opts),
      opts?.signal,
      this.invoke,
      this.listen,
      new OpenAiAssembler(),
      (json) => this.read(json),
      () => this.chat(messages, opts),
      onDelta
    );
  }

  private read(json: WireReply | null): ChatResult {
    const message = json?.choices?.[0]?.message;
    const toolCalls = normalizeToolCalls(message?.tool_calls);
    // OpenAI-compatible servers for reasoning models put the reasoning in `reasoning_content`.
    const thinkingOnly = toolCalls.length === 0 && isThinkingOnly(message?.content, message?.reasoning_content);
    return {
      content: message?.content ?? '',
      toolCalls,
      ...(thinkingOnly ? { thinkingOnly: true } : {}),
    };
  }
}

/** Build the configured provider, or null when AI is disabled. */
export function createLlmProvider(settings: AppSettings, invoke?: InvokeFn, listen?: ListenFn): LlmProvider | null {
  switch (settings.llmProvider) {
    case 'ollama':
      return new OllamaProvider(settings, invoke, listen);
    case 'openai':
      return new OpenAiProvider(settings, invoke, listen);
    default:
      return null;
  }
}
