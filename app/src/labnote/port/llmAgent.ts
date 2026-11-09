// Ported from app/vendor/labnoteo/src/llm/agent.ts:31-186 sha256:099940c5b1620804
// labnoteO 0.140.2, Apache-2.0.
// Changes: imports point at ./llmProvider. AgentDeps gains signal?: AbortSignal, passed to every provider.chat (which cancels the request in Rust through net_cancel). runAgent checks deps.signal?.aborted before each model turn, before each tool call of a turn, and again just before each runTool (so an approval answered after a Cancel never writes), and throws NetError('cancelled') (D11). The argument order stays the vendor's runAgent(messages, deps). The logic is otherwise verbatim.
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
   */
  confirm(call: ToolCall, tool: ToolDef, preview?: Exclude<ToolPreview, { error: string }>): Promise<boolean>;
  /** Tools to offer. Defaults to the full core registry. */
  tools?: ToolDef[];
  temperature?: number;
  /**
   * Cancels the run (D11): passed to every model call, and checked before each
   * model turn and before each tool runs.
   */
  signal?: AbortSignal;
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

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    stopIfAborted(deps.signal);
    const turn: ChatResult = await deps.provider.chat(history, {
      temperature: deps.temperature,
      tools,
      signal: deps.signal,
    });

    if (turn.toolCalls.length === 0) {
      return {
        content: turn.content,
        ...(turn.thinkingOnly ? { thinkingOnly: true } : {}),
        executed,
        stoppedAtLimit: false,
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

      if (tool.mutates) {
        // A call the tool would reject anyway is not put to the user; the
        // model gets the real reason instead of "denied" (#69).
        const preview = await previewTool(tool, deps.ctx, call.arguments);
        if (preview && 'error' in preview) {
          history.push(resultMessage(call, { error: preview.error }));
          executed.push({ call, outcome: 'rejected', mutates: true, ...preview });
          continue;
        }
        if (!(await deps.confirm(call, tool, preview))) {
          history.push(resultMessage(call, { error: 'User denied this write.' }));
          executed.push({ call, outcome: 'denied', mutates: true });
          continue;
        }
      }

      stopIfAborted(deps.signal);
      const res = await runTool(tools, call.name, deps.ctx, call.arguments);
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

  return { content: '', executed, stoppedAtLimit: true };
}
