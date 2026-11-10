// Ported from app/vendor/labnoteo/src/llm/agent.ts:31-186 sha256:099940c5b1620804
// labnoteO 0.140.2, Apache-2.0.
// Changes: imports point at ./llmProvider. AgentDeps gains signal?: AbortSignal, passed to every provider.chat (which cancels the request in Rust through net_cancel). runAgent checks deps.signal?.aborted before each model turn, before each tool call of a turn, and again just before each runTool (so an approval answered after a Cancel never writes), and throws NetError('cancelled') (D11). The argument order stays the vendor's runAgent(messages, deps). Task 9 (spec §7.4): AgentDeps gains external?: ReadonlyMap<string, ExternalToolMeta> (the side map of external tools, ../../ai/externalTools) and confirm gains a 4th argument { tainted, reason? }; runAgent keeps tainted (true at start when an MCP tool is offered, and after any external result) and taintSources (MCP server ids, plus 'scholar', grown only by results), returned on AgentRun. Every mutating tool is still confirmed, now with the note; a read-only MCP tool is also confirmed when, after a result, its server is not a taint source (crossServer) or its serialised arguments exceed 2,000 chars (bigArgs); a denial of such a read answers 'User denied this call.'. Task 6 (assistant spec §6.2, app only): AgentDeps gains onDelta?(text); when it is set and the provider has chatStream, each model turn goes through provider.chatStream(history, opts, onDelta), so answer text arrives piece by piece in order; the turn's ChatResult and so the AgentRun are the same as with chat. Task 7 (assistant spec §4.5, R11, app only): AgentDeps gains initialTaint?: string[] (taint carried over from earlier chat turns); a non-empty list starts the run tainted with those entries as taintSources, so the first write is confirmed with the taint note and a read-only MCP call on any server gets the crossServer check. Task 14 (assistant spec §7.3, app only): ExternalToolMeta.kind gains 'web'; taintSources records meta.kind for non-MCP tools ('scholar', 'web') instead of always 'scholar'; a web_search call (kind 'web') while the run is tainted is confirmed with reason 'webAfterTaint' (a denial answers 'User denied this call.'); every note carries web: true once a web result reached the run. The logic is otherwise verbatim.
/**
 * The tool-calling loop that makes the built-in AI agentic.
 *
 * Until now the plugin's own AI was one-shot (prompt → text → insert) while an
 * *external* MCP client could drive the same tools in a loop. This closes that
 * gap by reusing the exact pieces the MCP path already uses — `createLabnoteTools`,
 * `ToolContext`, the `writeNote` hook, and the `mutates` confirmation policy —
 * so the two entry points cannot drift in what they permit.
 *
 * The loop is deliberately small: ask the model, run whatever it asked for,
 * feed the results back, repeat until it answers in prose or we hit the cap.
 */
import {
  createLabnoteTools,
  previewTool,
  runTool,
  type ToolContext,
  type ToolPreview,
  type ToolDef,
} from '@labnoteo/core';
import { NetError } from '../../integrations/netIpc';
import { BIG_ARGS_CHARS, type ConfirmNote, type ExternalToolMeta } from '../../ai/externalTools';
import type { ChatMessage, ChatResult, LlmProvider, ToolCall } from './llmProvider';

/** Throws NetError('cancelled') once the run's signal has aborted (D11). */
function stopIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new NetError('cancelled', 'cancelled');
}

/**
 * Ceiling on model round-trips per invocation.
 *
 * A model that keeps calling tools without converging would otherwise loop
 * forever, and every iteration is a real HTTP request plus possible vault
 * writes. Six leaves room for a realistic chain (look up a sample, read a unit
 * operation, then write a section) without letting a confused model run away.
 */
export const MAX_ITERATIONS = 6;

export interface AgentDeps {
  provider: LlmProvider;
  ctx: ToolContext;
  /**
   * Ask the user to approve a mutating tool call. Returning false is a normal
   * outcome, not an error: the denial is reported to the model, which can adapt.
   * `preview` is the tool's {@link ToolDef.describe} result, when it has one.
   * `note` says whether outside content reached the conversation, and why a
   * read-only external call is asked about (spec §7.4).
   */
  confirm(
    call: ToolCall,
    tool: ToolDef,
    preview?: Exclude<ToolPreview, { error: string }>,
    note?: ConfirmNote
  ): Promise<boolean>;
  /** Tools to offer. Defaults to the full core registry. */
  tools?: ToolDef[];
  temperature?: number;
  /**
   * Cancels the run (D11): passed to every model call, and checked before each
   * model turn and before each tool runs.
   */
  signal?: AbortSignal;
  /** What the app knows about the external tools among `tools`, by function name (spec §7.2). */
  external?: ReadonlyMap<string, ExternalToolMeta>;
  /**
   * Streamed answer text, piece by piece in order (app only, spec §6.2). Set → each model turn uses
   * `provider.chatStream` when the provider has one; the run's result does not change.
   */
  onDelta?: (text: string) => void;
  /**
   * Taint carried over from earlier turns of a chat (app only, assistant spec §4.5): a non-empty list starts
   * the run tainted with these entries as its first taint sources (none is an MCP server id, so every
   * read-only MCP call is asked as crossServer).
   */
  initialTaint?: readonly string[];
}

/**
 * What became of one tool call (#186): `done` ran and succeeded, `denied` was
 * refused in the approval dialog, `rejected` was refused by the tool before
 * anyone was asked, `failed` ran and returned an error.
 */
export type ToolOutcome = 'done' | 'denied' | 'rejected' | 'failed';

export interface AgentRun {
  /** The model's final prose answer (empty if it never produced one). */
  content: string;
  /** True when the final turn had reasoning but no answer (#195). */
  thinkingOnly?: boolean;
  /**
   * Every tool call, in order; `mutates` tells writes from reads. A call of a
   * tool that does not exist counts as a failed read. `error` is why a call
   * was rejected or failed (#281), in English for the model; `code` and
   * `params` let the notice word that reason in the user's language (#529).
   */
  executed: Array<{
    call: ToolCall;
    outcome: ToolOutcome;
    mutates: boolean;
    error?: string;
    code?: string;
    params?: string[];
  }>;
  /** True when the cap stopped the loop before the model finished. */
  stoppedAtLimit: boolean;
  /** True once outside content could reach the model (spec §7.4). */
  tainted: boolean;
  /** Where external results came from: MCP server ids, 'scholar' and 'web'. */
  taintSources: string[];
}

/** Length of the arguments as they leave the computer. */
function argsLength(args: Record<string, unknown>): number {
  try {
    return JSON.stringify(args)?.length ?? 0;
  } catch {
    return Infinity;
  }
}

/** {@link AgentRun.executed} counted the way the end notice reports it. */
export function countToolOutcomes(executed: AgentRun['executed']): {
  changed: number;
  read: number;
  denied: number;
  failed: number;
} {
  const counts = { changed: 0, read: 0, denied: 0, failed: 0 };
  for (const e of executed) {
    if (e.outcome === 'done') counts[e.mutates ? 'changed' : 'read']++;
    else if (e.outcome === 'denied') counts.denied++;
    else counts.failed++;
  }
  return counts;
}

/**
 * Serialize a tool outcome for the model. Errors are sent back as content
 * rather than thrown: a wrong argument or a missing sample is something the
 * model can correct on the next turn, and killing the run would discard the
 * work it already did.
 */
function resultMessage(call: ToolCall, payload: unknown): ChatMessage {
  return {
    role: 'tool',
    content: JSON.stringify(payload),
    toolCallId: call.id,
    toolName: call.name,
  };
}

/**
 * Run the model until it stops asking for tools.
 *
 * `messages` is not mutated; the returned transcript lives only inside the call.
 */
export async function runAgent(
  messages: ChatMessage[],
  deps: AgentDeps
): Promise<AgentRun> {
  const tools = deps.tools ?? createLabnoteTools();
  const history: ChatMessage[] = [...messages];
  const executed: AgentRun['executed'] = [];
  const external = deps.external;
  // Offered MCP tools' descriptions and schemas are server text the model reads unfenced (spec §7.4).
  const seeded = deps.initialTaint ?? [];
  let tainted = seeded.length > 0 || tools.some(t => external?.get(t.name)?.kind === 'mcp');
  const taintSources = new Set<string>(seeded);
  const taint = () => ({ tainted, taintSources: [...taintSources] });

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    stopIfAborted(deps.signal);
    const opts = { temperature: deps.temperature, tools, signal: deps.signal };
    const turn: ChatResult =
      deps.onDelta && deps.provider.chatStream
        ? await deps.provider.chatStream(history, opts, deps.onDelta)
        : await deps.provider.chat(history, opts);

    if (turn.toolCalls.length === 0) {
      return {
        content: turn.content,
        ...(turn.thinkingOnly ? { thinkingOnly: true } : {}),
        executed,
        stoppedAtLimit: false,
        ...taint(),
      };
    }

    // The assistant turn must be echoed back verbatim: both providers reject a
    // tool result that does not follow the call it answers.
    history.push({ role: 'assistant', content: turn.content, toolCalls: turn.toolCalls });

    for (const call of turn.toolCalls) {
      stopIfAborted(deps.signal);
      const tool = tools.find(t => t.name === call.name);
      if (!tool) {
        const error = `Unknown tool: ${call.name}`;
        history.push(resultMessage(call, { error }));
        executed.push({ call, outcome: 'failed', mutates: false, error });
        continue;
      }

      const meta = external?.get(tool.name);
      // A read-only MCP call still sends its arguments out: ask when outside text could be steering
      // them to another server, or when they are long enough to carry a note (spec §7.2, §7.4).
      let reason: ConfirmNote['reason'];
      if (meta?.kind === 'mcp') {
        if (tainted && taintSources.size > 0 && !taintSources.has(meta.serverId ?? '')) reason = 'crossServer';
        else if (argsLength(call.arguments) > BIG_ARGS_CHARS) reason = 'bigArgs';
      } else if (meta?.kind === 'web' && tool.name === 'web_search' && tainted) {
        // The query leaves the computer: once outside text could be steering it, the user sees it first.
        reason = 'webAfterTaint';
      }
      const note: ConfirmNote = {
        tainted,
        ...(reason ? { reason } : {}),
        ...(taintSources.has('web') ? { web: true } : {}),
      };

      if (tool.mutates) {
        // A call the tool would reject anyway is not put to the user; the
        // model gets the real reason instead of "denied" (#69).
        const preview = await previewTool(tool, deps.ctx, call.arguments);
        if (preview && 'error' in preview) {
          history.push(resultMessage(call, { error: preview.error }));
          executed.push({ call, outcome: 'rejected', mutates: true, ...preview });
          continue;
        }
        if (!(await deps.confirm(call, tool, preview, note))) {
          history.push(resultMessage(call, { error: 'User denied this write.' }));
          executed.push({ call, outcome: 'denied', mutates: true });
          continue;
        }
      } else if (reason) {
        if (!(await deps.confirm(call, tool, undefined, note))) {
          history.push(resultMessage(call, { error: 'User denied this call.' }));
          executed.push({ call, outcome: 'denied', mutates: false });
          continue;
        }
      }

      stopIfAborted(deps.signal);
      const res = await runTool(tools, call.name, deps.ctx, call.arguments);
      if (meta) {
        // The result (or its error text) is outside content from here on.
        tainted = true;
        taintSources.add(meta.kind === 'mcp' ? (meta.serverId ?? '') : meta.kind);
      }
      const payload = res.ok ? (res.data ?? null) : { error: res.error };
      // Wrapped only when there is something to say, so the common payload
      // stays exactly what the tool returned.
      history.push(
        resultMessage(
          call,
          res.warnings?.length
            ? { ...(res.ok ? { data: payload } : payload), warnings: res.warnings }
            : payload
        )
      );
      executed.push(
        res.ok
          ? { call, outcome: 'done', mutates: !!tool.mutates }
          : { call, outcome: 'failed', mutates: !!tool.mutates, error: res.error, code: res.code, params: res.params }
      );
    }
  }

  return { content: '', executed, stoppedAtLimit: true, ...taint() };
}
