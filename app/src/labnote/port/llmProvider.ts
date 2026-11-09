// Ported from app/vendor/labnoteo/src/llm/provider.ts:27-267 sha256:50318941b2f8b631
// labnoteO 0.140.2, Apache-2.0.
// Changes: requestUrl({url, method, headers, body, throw:false}) → llmChat({provider, body, signal}) (integrations/netIpc), so the webview never names a host or holds a key: Rust builds the URL (joinUrl(endpoint, '/api/chat' | '/v1/chat/completions'), with https:// for a scheme-less non-loopback host, D8) and the Authorization: Bearer header from the stored settings and Windows Credential Manager (Task 6); joinUrl is kept for display and tests only; a NetError of kind status → LlmHttpError('Ollama' | 'OpenAI', status, body), every other NetError kind is rethrown as is for describeLlmError, and a 2xx text that is not JSON → NetError('notJson') where Obsidian's res.json threw; ChatOptions gains signal (cancels through net_cancel); LabnoteSettings → AppSettings, which has no llmApiKey, so OpenAiProvider no longer builds headers; LlmProvider gains label ('Ollama' | 'OpenAI-compatible', for the progress title) and model; createLlmProvider takes an optional invoke for tests. The JSON body is built and the reply parsed as in the vendor file.
import type { ToolDef } from '@labnoteo/core';
import { llmChat, NetError, type InvokeFn } from '../../integrations/netIpc';
import type { AppSettings } from '../settings';
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
}

export interface LlmProvider {
  /** `'ollama'` or `'openai'`, as the plugin's `provider.name`. */
  readonly name: 'ollama' | 'openai';
  /** What the UI calls it: 'Ollama' or 'OpenAI-compatible' (not translated, D22). */
  readonly label: string;
  /** The model the request names (`llmModel`). */
  readonly model: string;
  chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResult>;
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

class OllamaProvider implements LlmProvider {
  readonly name = 'ollama';
  readonly label = 'Ollama';
  constructor(
    private readonly settings: AppSettings,
    private readonly invoke?: InvokeFn
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

  async chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResult> {
    const json = await post(
      'ollama',
      'Ollama',
      {
        model: this.settings.llmModel,
        messages: OllamaProvider.toWire(messages),
        stream: false,
        tools: opts?.tools?.length ? toolSchemas(opts.tools) : undefined,
        options: opts?.temperature != null ? { temperature: opts.temperature } : undefined,
      },
      opts?.signal,
      this.invoke
    );
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
    private readonly invoke?: InvokeFn
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

  async chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResult> {
    // The Authorization header is Rust's: it reads the key from Credential Manager (D6).
    const json = await post(
      'openai',
      'OpenAI',
      {
        model: this.settings.llmModel,
        messages: OpenAiProvider.toWire(messages),
        temperature: opts?.temperature,
        tools: opts?.tools?.length ? toolSchemas(opts.tools) : undefined,
      },
      opts?.signal,
      this.invoke
    );
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
export function createLlmProvider(settings: AppSettings, invoke?: InvokeFn): LlmProvider | null {
  switch (settings.llmProvider) {
    case 'ollama':
      return new OllamaProvider(settings, invoke);
    case 'openai':
      return new OpenAiProvider(settings, invoke);
    default:
      return null;
  }
}
