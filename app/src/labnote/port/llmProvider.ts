// Ported from app/vendor/labnoteo/src/llm/provider.ts:27-267 sha256:50318941b2f8b631
// labnoteO 0.140.2, Apache-2.0.
// Changes: requestUrl({url, method, headers, body, throw:false}) → llmChat({provider, body, signal}) (integrations/netIpc), so the webview never names a host or holds a key: Rust builds the URL (joinUrl(endpoint, '/api/chat' | '/v1/chat/completions'), with https:// for a scheme-less non-loopback host, D8) and the Authorization: Bearer header from the stored settings and Windows Credential Manager (Task 6); joinUrl is kept for display and tests only; openaiBase (new, app only) mirrors Rust's openai_base so a displayed OpenAI-compatible URL drops one final /v1 segment of the endpoint before /v1/... is appended, as Rust does (C-R1); a NetError of kind status → LlmHttpError('Ollama' | 'OpenAI', status, body), every other NetError kind is rethrown as is for describeLlmError, and a 2xx text that is not JSON → NetError('notJson') where Obsidian's res.json threw; ChatOptions gains signal (cancels through net_cancel); LabnoteSettings → AppSettings, which has no llmApiKey, so OpenAiProvider no longer builds headers; LlmProvider gains label ('Ollama' | 'OpenAI-compatible', for the progress title) and model; createLlmProvider takes an optional invoke for tests. ChatOptions gains contextWindow (feat/ai-context): Ollama merges it into options as num_ctx beside temperature; the OpenAI body ignores it. Task 6 (assistant spec §6.2, app only): LlmProvider gains an optional chatStream(messages, opts, onDelta), implemented by both providers: the same body with stream: true goes to llmChatStream (llm_chat_stream + llm://frame events, integrations/netIpc), the frames are assembled by ../../ai/streamAssembler (OpenAI SSE tool-call deltas merged by index, Ollama NDJSON) into the same ChatResult, and each content delta goes to onDelta in order; a 2xx JSON answer (stream ignored) is read like chat's; a non-2xx answer, or a status/notJson error, before the first frame falls back to one non-streamed chat (never after a frame, never on a network error). chat's body building and reply reading are factored into body()/read() so both paths share them; createLlmProvider takes an optional listen for tests. Thinking mode (2026-11-11, app only): both providers share an abstract WireProvider; ChatOptions gains thinking (forces 'on' | 'off') and onRetry; each request's mode is settings thinkingFor (auto: qwen3 off on tool turns) and goes out the documented way (OpenAI-compatible chat_template_kwargs.enable_thinking, Ollama top-level think) with the model's recommended sampling for that mode (temperature, top_p, top_k, min_p, presence_penalty; a typed llmTemperature replaces only the temperature); a 400/422 to a body with the extra fields (top_k, min_p, chat_template_kwargs | think) is sent once more without them, and the provider then leaves them out; a streamed request that asked for thinking and hit a ReasoningLoopError or a ReasoningStall (timeout after reasoning only), with no answer text shown yet, is sent once more with thinking off after onRetry; the non-streamed OpenAI reply also reads message.reasoning. Output cap (real-server check 2026-11-11, app only): every request carries one, OpenAI-compatible max_tokens and Ollama options.num_predict (outputTokens: ChatOptions.maxTokens, else 4096 for a turn with tools and 8192 without; a saved llmMaxOutputTokens replaces either; bounded only by a limit the server is known to enforce, Ollama's num_ctx or the max_model_len the connection check saved for this connection, minus the estimated prompt and OUTPUT_TOKENS_MARGIN, and left out when that leaves less than OUTPUT_TOKENS_MIN); an OpenAI-compatible request with thinking on also carries thinking_token_budget (half the cap, at most THINKING_BUDGET_MAX), an extra field the 400/422 resend strips; finish_reason / done_reason 'length' sets ChatResult.truncated, and with no answer text throws OutputLimitError (with text the turn's tool calls are dropped, so a cut turn runs no tools), which a streamed request that asked for thinking also answers with the one resend with thinking off. The JSON body is otherwise built and the reply parsed as in the vendor file.
import type { ToolDef } from '@labnoteo/core';
import { llmChat, llmChatStream, NetError, type InvokeFn, type ListenFn } from '../../integrations/netIpc';
import { OllamaAssembler, OpenAiAssembler, ReasoningStall, type StreamAssembler } from '../../ai/streamAssembler';
import { recommendedSampling, serverContextLimit, thinkingFor, type AppSettings, type ThinkingMode } from '../settings';
import { estimateTokens } from '../context/tokens';
import { LlmHttpError, OutputLimitError, ReasoningLoopError } from './llmError';

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
  /** The server stopped at the output cap (finish_reason / done_reason 'length'). Set only then. */
  truncated?: boolean;
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
  /**
   * Forces this request's thinking mode. Omitted → settings `thinkingFor` (the vault's thinking setting, auto by
   * default: qwen3 thinks off on tool turns). The provider's own retry after a reasoning loop sets 'off'.
   */
  thinking?: ThinkingMode;
  /** Called once just before a streamed request is sent again with thinking off (a reasoning loop or stall). */
  onRetry?: () => void;
  /**
   * This task's output cap in tokens (history compaction asks for {@link OUTPUT_TOKENS_COMPACT}). Omitted → 4096 for a
   * turn with tools, 8192 without. A saved `llmMaxOutputTokens` replaces it; a server limit known to the app still bounds it ({@link outputTokens}).
   */
  maxTokens?: number;
}

/** Output cap of a turn that offers tools (assistant chat and chips, the agent, Ask). */
export const OUTPUT_TOKENS_TOOLS = 4096;
/** Output cap of a plain text request (planning draft, Draft Method, summaries). */
export const OUTPUT_TOKENS_TEXT = 8192;
/** Output cap of the history compaction summary. */
export const OUTPUT_TOKENS_COMPACT = 2048;
/** The smallest cap ever sent. When a known server limit leaves less room than this, no cap is sent at all. */
export const OUTPUT_TOKENS_MIN = 256;
/** The most reasoning tokens asked for with thinking on (vLLM thinking_token_budget). */
export const THINKING_BUDGET_MAX = 4096;
/** Room kept free under a known server limit for what the prompt estimate misses (chat template, tool-call framing). */
export const OUTPUT_TOKENS_MARGIN = 256;

/** The estimated prompt of a request in tokens: the messages and, when offered, the tool schemas. */
export function promptTokens(messages: readonly ChatMessage[], opts: ChatOptions | undefined): number {
  return (
    messages.reduce((n, m) => n + 4 + estimateTokens(m.content) + (m.toolCalls ? estimateTokens(JSON.stringify(m.toolCalls)) : 0), 0) +
    (opts?.tools?.length ? estimateTokens(JSON.stringify(toolSchemas(opts.tools))) : 0)
  );
}

/**
 * The output cap of one request (real-server check, 2026-11-11: without one a looping request streamed for the whole
 * 300 s LLM_TIMEOUT). The vault's `llmMaxOutputTokens` when set, else the task's (`maxTokens`, or by whether tools are
 * offered). `serverLimit` is a limit the server is known to enforce on prompt + output: Ollama's `num_ctx` that this
 * request sends, or the vLLM `max_model_len` the connection check found for this connection (settings
 * serverContextLimit). Only then is the cap kept under that limit minus the estimated prompt and a margin
 * ({@link OUTPUT_TOKENS_MARGIN}); the configured context window alone never shrinks it, the server enforces its own
 * limit. When a known limit leaves less than {@link OUTPUT_TOKENS_MIN}, undefined: the request carries no cap rather
 * than one the server refuses (prompt + cap over the limit is a 400 that no resend fixes).
 */
export function outputTokens(
  settings: Pick<AppSettings, 'llmMaxOutputTokens'>,
  messages: readonly ChatMessage[],
  opts: ChatOptions | undefined,
  serverLimit?: number
): number | undefined {
  const wanted = Math.max(
    OUTPUT_TOKENS_MIN,
    settings.llmMaxOutputTokens ?? opts?.maxTokens ?? (opts?.tools?.length ? OUTPUT_TOKENS_TOOLS : OUTPUT_TOKENS_TEXT)
  );
  if (!serverLimit || serverLimit <= 0) return wanted;
  const room = serverLimit - promptTokens(messages, opts) - OUTPUT_TOKENS_MARGIN;
  return room < OUTPUT_TOKENS_MIN ? undefined : Math.min(wanted, room);
}

/** The sampling fields a request may carry. Undefined fields are left out of the body. */
interface Sampling {
  temperature?: number;
  topP?: number;
  topK?: number;
  minP?: number;
  presencePenalty?: number;
}

/** Ollama's `options`: the sampling, num_ctx and num_predict that are given, otherwise omitted. */
function ollamaOptions(sampling: Sampling, contextWindow: number | undefined, numPredict?: number): Record<string, number> | undefined {
  const out: Record<string, number> = {};
  if (sampling.temperature != null) out.temperature = sampling.temperature;
  if (sampling.topP != null) out.top_p = sampling.topP;
  if (sampling.topK != null) out.top_k = sampling.topK;
  if (sampling.minP != null) out.min_p = sampling.minP;
  if (sampling.presencePenalty != null) out.presence_penalty = sampling.presencePenalty;
  if (contextWindow != null) out.num_ctx = contextWindow;
  if (numPredict != null) out.num_predict = numPredict;
  return Object.keys(out).length ? out : undefined;
}

/**
 * The sampling a request sends. A model with a recommendation (settings recommendedSampling, qwen3) gets the set for
 * this request's thinking mode (off: 0.7, top_p 0.8; on: 0.6, top_p 0.95; both top_k 20, min_p 0, presence_penalty
 * 1.5), with the vault's typed `llmTemperature` replacing only the temperature. Any other model gets the typed
 * temperature, else what the caller asked for, as before. Every LLM call goes through a provider body.
 */
function samplingOf(settings: AppSettings, opts: ChatOptions | undefined, mode: ThinkingMode | undefined): Sampling {
  const typed = settings.llmTemperature;
  const rec = recommendedSampling(settings.llmModel, mode ?? 'off');
  if (!rec) return { temperature: typed ?? opts?.temperature };
  return { temperature: typed ?? rec.temperature, topP: rec.topP, topK: rec.topK, minP: rec.minP, presencePenalty: rec.presencePenalty };
}

/** `body` without `keys`; the same object when none of them is set. */
function withoutKeys(body: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  if (!keys.some((k) => body[k] !== undefined)) return body;
  const out = { ...body };
  for (const k of keys) delete out[k];
  return out;
}

/** A server that refuses an unknown field answers 400 (or 422, FastAPI validation). */
function refusedFields(e: unknown): boolean {
  const status = e instanceof LlmHttpError ? e.status : e instanceof NetError && e.kind === 'status' ? e.status : undefined;
  return status === 400 || status === 422;
}

/** The model spent the request on reasoning: it looped, reasoned until the time limit, or used up the cap without an answer. */
function stalledThinking(e: unknown): boolean {
  return e instanceof ReasoningLoopError || e instanceof ReasoningStall || e instanceof OutputLimitError;
}

/**
 * A reply cut at the output cap before any answer text has nothing to show: it is an error. A cut reply with text
 * keeps the text and `truncated` (callers say the answer may be incomplete), but never its tool calls: a call cut
 * mid-stream may carry partial arguments, so a truncated turn runs no tools.
 */
function checkCut(result: ChatResult): ChatResult {
  if (!result.truncated) return result;
  if (!result.content.trim()) throw new OutputLimitError();
  return result.toolCalls.length ? { ...result, toolCalls: [] } : result;
}

/** finish_reason / done_reason 'length' as the `truncated` flag (left out otherwise). */
function cutFlag(reason: unknown): { truncated?: true } {
  return reason === 'length' ? { truncated: true } : {};
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
  reasoning?: unknown;
}

interface WireReply {
  message?: WireMessage;
  done_reason?: unknown;
  choices?: Array<{ message?: WireMessage; finish_reason?: unknown }>;
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
    if (e instanceof NetError && e.kind === 'timeout' && asm.reasoningOnly()) throw new ReasoningStall();
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

/**
 * What both providers share: the thinking mode and sampling of each request, the one resend without the extra fields
 * a server refused, and the one streamed resend with thinking off after a reasoning loop or stall.
 */
abstract class WireProvider implements LlmProvider {
  abstract readonly name: 'ollama' | 'openai';
  abstract readonly label: string;
  /** The provider name an {@link LlmHttpError} carries. */
  protected abstract readonly errorName: string;
  /**
   * Body fields some servers may refuse (non-standard sampling and the thinking switch). A 400/422 to a body with
   * them is sent once more without them; once that worked, this provider leaves them out.
   */
  protected abstract readonly extraKeys: readonly string[];
  private extrasRefused = false;

  constructor(
    protected readonly settings: AppSettings,
    protected readonly invoke?: InvokeFn,
    protected readonly listen?: ListenFn
  ) {}

  get model(): string {
    return this.settings.llmModel;
  }

  protected abstract body(messages: ChatMessage[], opts: ChatOptions | undefined, mode: ThinkingMode | undefined): Record<string, unknown>;
  protected abstract read(json: WireReply | null): ChatResult;
  protected abstract assembler(): StreamAssembler;

  private modeOf(opts: ChatOptions | undefined): ThinkingMode | undefined {
    return opts?.thinking ?? thinkingFor(this.settings, !!opts?.tools?.length);
  }

  protected sampling(opts: ChatOptions | undefined, mode: ThinkingMode | undefined): Sampling {
    return samplingOf(this.settings, opts, mode);
  }

  /** The limit this provider's server enforces on prompt + output, when known (see {@link outputTokens}). */
  protected abstract serverLimit(opts: ChatOptions | undefined): number | undefined;

  protected outputCap(messages: ChatMessage[], opts: ChatOptions | undefined): number | undefined {
    return outputTokens(this.settings, messages, opts, this.serverLimit(opts));
  }

  private async withExtras<T>(full: Record<string, unknown>, run: (body: Record<string, unknown>) => Promise<T>): Promise<T> {
    const plain = withoutKeys(full, this.extraKeys);
    if (plain === full || this.extrasRefused) return run(plain);
    try {
      return await run(full);
    } catch (e) {
      if (!refusedFields(e)) throw e;
      const out = await run(plain);
      this.extrasRefused = true;
      return out;
    }
  }

  private async send(body: Record<string, unknown>, signal: AbortSignal | undefined): Promise<ChatResult> {
    // For OpenAI the Authorization header is Rust's: it reads the key from Credential Manager (D6).
    return checkCut(this.read(await post(this.name, this.errorName, body, signal, this.invoke)));
  }

  async chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResult> {
    return this.withExtras(this.body(messages, opts, this.modeOf(opts)), (b) => this.send(b, opts?.signal));
  }

  async chatStream(messages: ChatMessage[], opts: ChatOptions | undefined, onDelta: (text: string) => void): Promise<ChatResult> {
    const attempt = (mode: ThinkingMode | undefined, sink: (text: string) => void) =>
      this.withExtras(this.body(messages, opts, mode), (b) =>
        streamPost(
          this.name,
          this.errorName,
          b,
          opts?.signal,
          this.invoke,
          this.listen,
          this.assembler(),
          (json) => this.read(json),
          () => this.send(b, opts?.signal),
          sink
        ).then(checkCut)
      );
    const mode = this.modeOf(opts);
    let delivered = false;
    try {
      return await attempt(mode, (text) => {
        delivered = true;
        onDelta(text);
      });
    } catch (e) {
      // Only a request that asked for thinking can drop it; answer text already shown is never sent twice.
      if (mode !== 'on' || delivered || opts?.signal?.aborted || !stalledThinking(e)) throw e;
      opts?.onRetry?.();
      return attempt('off', onDelta);
    }
  }
}

class OllamaProvider extends WireProvider {
  readonly name = 'ollama';
  readonly label = 'Ollama';
  protected readonly errorName = 'Ollama';
  protected readonly extraKeys: readonly string[] = ['think'];

  /** The num_ctx this request sends is the window Ollama runs it in. */
  protected serverLimit(opts: ChatOptions | undefined): number | undefined {
    return opts?.contextWindow;
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

  protected body(messages: ChatMessage[], opts: ChatOptions | undefined, mode: ThinkingMode | undefined): Record<string, unknown> {
    return {
      model: this.settings.llmModel,
      messages: OllamaProvider.toWire(messages),
      stream: false,
      tools: opts?.tools?.length ? toolSchemas(opts.tools) : undefined,
      options: ollamaOptions(this.sampling(opts, mode), opts?.contextWindow, this.outputCap(messages, opts)),
      // Ollama's documented switch is the top-level `think`.
      ...(mode ? { think: mode === 'on' } : {}),
    };
  }

  protected assembler(): StreamAssembler {
    return new OllamaAssembler();
  }

  protected read(json: WireReply | null): ChatResult {
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
      ...cutFlag(json?.done_reason),
    };
  }
}

class OpenAiProvider extends WireProvider {
  readonly name = 'openai';
  readonly label = 'OpenAI-compatible';
  protected readonly errorName = 'OpenAI';
  // top_k and min_p are vLLM extra sampling parameters; chat_template_kwargs is vLLM's thinking switch and
  // thinking_token_budget its reasoning cap.
  protected readonly extraKeys: readonly string[] = ['top_k', 'min_p', 'chat_template_kwargs', 'thinking_token_budget'];

  /** The max_model_len the connection check found for this endpoint and model; the configured window is not one. */
  protected serverLimit(): number | undefined {
    return serverContextLimit(this.settings);
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

  protected body(messages: ChatMessage[], opts: ChatOptions | undefined, mode: ThinkingMode | undefined): Record<string, unknown> {
    const sm = this.sampling(opts, mode);
    const cap = this.outputCap(messages, opts);
    return {
      model: this.settings.llmModel,
      messages: OpenAiProvider.toWire(messages),
      max_tokens: cap,
      temperature: sm.temperature,
      top_p: sm.topP,
      presence_penalty: sm.presencePenalty,
      top_k: sm.topK,
      min_p: sm.minP,
      // vLLM's documented per-request switch for Qwen3 (the /no_think soft switch does not work on qwen3.6).
      ...(mode ? { chat_template_kwargs: { enable_thinking: mode === 'on' } } : {}),
      // Reasoning may use at most half the cap, so the answer always has room.
      ...(mode === 'on' && cap != null ? { thinking_token_budget: Math.min(THINKING_BUDGET_MAX, Math.floor(cap / 2)) } : {}),
      tools: opts?.tools?.length ? toolSchemas(opts.tools) : undefined,
    };
  }

  protected assembler(): StreamAssembler {
    return new OpenAiAssembler();
  }

  protected read(json: WireReply | null): ChatResult {
    const choice = json?.choices?.[0];
    const message = choice?.message;
    const toolCalls = normalizeToolCalls(message?.tool_calls);
    // OpenAI-compatible servers for reasoning models put the reasoning in `reasoning_content`, newer vLLM in `reasoning`.
    const thinking = message?.reasoning_content ?? message?.reasoning;
    const thinkingOnly = toolCalls.length === 0 && isThinkingOnly(message?.content, thinking);
    return {
      content: message?.content ?? '',
      toolCalls,
      ...(thinkingOnly ? { thinkingOnly: true } : {}),
      ...cutFlag(choice?.finish_reason),
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
