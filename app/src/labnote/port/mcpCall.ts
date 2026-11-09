// Ported from app/vendor/labnoteo/src/llm/mcpServer.ts:163-228 sha256:786f289c53484d7d
// labnoteO 0.140.2, Apache-2.0.
// Changes: the method becomes the function callMutating(call, tool, args, signal) and returns the reply instead of writing it: res/sendJson become a returned McpReplyIn (undefined = reply nothing), and the JSON-RPC id stays in Rust (callId). this.context() → toolContext(call.env) (SP6 Task 31: writes go through processNote, which refuses an open note that is composing; call.beforeWrite is passed as its beforeWrite hook); this.tools → call.tools. this.plugin.host.confirm → call.env.host.confirm(…, { …, unsolicited: true }) after await whenNotComposing(call.env.ctx.activeView) (A9), so the approval timeout starts when the dialog opens; notifyIfUnfocused is removed (Rust raises the taskbar, C3). The timeout text names labnoteO. new Notice → host.notify('warn'). After an Allow, call.claim() (the host's guard.check() then mcp_claim) comes before runTool: false runs nothing and replies nothing, and a vault that changed (claim throws) replies CLOSED. A call whose signal was aborted because the vault closed (call.vaultClosed()) replies CLOSED instead of the disconnected notice; a disconnected one replies noReply.
import { previewTool, runTool, type ToolDef } from '@labnoteo/core';
import type { AiEnv } from '../../ai/aiEnv';
import { whenNotComposing } from '../host/whenNotComposing';
import type { McpReplyIn } from '../mcp/mcpIpc';
import { buildApprovalMessage, erasesRecordedLines } from './approvalMessage';
import { toolContext } from './aiCommon';
import { APPROVAL_TIMEOUT_MS, approveStable, awaitApproval, buildToolCallResult } from './mcpApproval';

/** The reply when the vault closed or changed under a call (C3 drain). */
export const CLOSED_REPLY: McpReplyIn = {
  kind: 'error',
  code: -32002,
  message: 'labnoteO closed the vault; nothing was written',
};

/** What one call needs from the host (mcpHost.ts). */
export interface McpCall {
  readonly env: AiEnv;
  readonly tools: ToolDef[];
  /** guard.check() then mcp_claim: true only when Rust still waits for this call. Throws when the vault changed. */
  claim(): Promise<boolean>;
  /** The toolContext beforeWrite hook (guard.check). */
  beforeWrite?(): Promise<void>;
  /** True once the vault this call started in has closed. */
  vaultClosed(): boolean;
}

/**
 * Preview, ask and run one mutating call. Skipped when the client went away
 * while it waited its turn. If the preview changed while the dialog was open
 * (the user edited the note), the new one is asked about again.
 */
export async function callMutating(
  call: McpCall,
  tool: ToolDef,
  args: Record<string, unknown>,
  signal: AbortSignal
): Promise<McpReplyIn | undefined> {
  const host = call.env.host;
  const context = () => toolContext(call.env, { beforeWrite: call.beforeWrite });
  const gone = (): McpReplyIn => (call.vaultClosed() ? CLOSED_REPLY : { kind: 'noReply' });
  if (signal.aborted) return gone();
  const name = tool.name;
  // Surface the write target so the user is not blind-approving by tool
  // name alone (an LLM could target any note/sample path).
  const target =
    typeof args.documentPath === 'string' && args.documentPath.length > 0 ? args.documentPath : null;
  let destructive = false;
  const compose = async (): Promise<{ message: string } | { error: string }> => {
    // A call the tool would reject anyway is not put to the user (#69).
    const preview = await previewTool(tool, context(), args);
    if (preview && 'error' in preview) return { error: preview.error };
    destructive = erasesRecordedLines(preview);
    return {
      message: buildApprovalMessage(
        host.t,
        host.t('Allow MCP tool "{0}" to modify the vault?', name),
        target,
        preview
      ),
    };
  };
  const outcome = await approveStable(compose, async message => {
    // A9: no question opens while the user is composing Hangul; the timeout starts when it opens.
    await whenNotComposing(call.env.ctx.activeView);
    if (signal.aborted) return 'disconnected';
    return awaitApproval(
      s => host.confirm(message, { confirmLabel: host.t('Allow'), signal: s, destructive, unsolicited: true }),
      { timeoutMs: APPROVAL_TIMEOUT_MS, signal }
    );
  });
  if (typeof outcome === 'object') {
    return { kind: 'result', result: buildToolCallResult({ ok: false, error: outcome.error }) };
  }
  switch (outcome) {
    case 'allowed':
      break;
    case 'denied':
      return { kind: 'error', code: -32001, message: 'User denied write' };
    case 'timeout':
      host.notify('warn', host.t('MCP tool "{0}" was not run: no answer in time.', name));
      return { kind: 'error', code: -32001, message: 'Approval timed out: the user did not answer in labnoteO' };
    case 'disconnected':
      if (call.vaultClosed()) return CLOSED_REPLY;
      host.notify('warn', host.t('MCP tool "{0}" was not run: the client disconnected.', name));
      return { kind: 'noReply' };
  }
  try {
    if (!(await call.claim())) return undefined;
  } catch {
    return CLOSED_REPLY;
  }
  const result = await runTool(call.tools, name, context(), args);
  return { kind: 'result', result: buildToolCallResult(result) };
}
