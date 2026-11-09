// Ported from app/vendor/labnoteo/src/llm/mcpServer.ts:75-79 sha256:cdbfd34203d8bf16
// Ported from app/vendor/labnoteo/src/llm/mcpServer.ts:325-392 sha256:3fb3d0d0937fbfa2
// Ported from app/vendor/labnoteo/src/llm/mcpServer.ts:407-418 sha256:24f32a89347e96f7
// labnoteO 0.140.2, Apache-2.0.
// Changes: none (imports only).
import type { ToolResult } from '@labnoteo/core';

/**
 * How long a write waits for the user's answer. Kept under the 60s request
 * timeout common MCP clients use, so the client hears why instead of timing out.
 */
export const APPROVAL_TIMEOUT_MS = 50_000;

export type ApprovalOutcome = 'allowed' | 'denied' | 'timeout' | 'disconnected';

/** Runs tasks one at a time, in the order they were queued (#144). */
export class TaskQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

/** How many times {@link approveStable} asks before giving up on a changing preview. */
const MAX_APPROVAL_ROUNDS = 3;

/**
 * Ask about `compose()`'s message, then compose it again: an "Allow" counts
 * only if the message is still the same, otherwise the new one is asked about
 * (#144). Returns the error when the call became invalid meanwhile.
 */
export async function approveStable(
  compose: () => Promise<{ message: string } | { error: string }>,
  ask: (message: string) => Promise<ApprovalOutcome>
): Promise<ApprovalOutcome | { error: string }> {
  let current = await compose();
  for (let round = 0; round < MAX_APPROVAL_ROUNDS; round++) {
    if ('error' in current) return current;
    const outcome = await ask(current.message);
    if (outcome !== 'allowed') return outcome;
    const now = await compose();
    if ('message' in now && now.message === current.message) return 'allowed';
    current = now;
  }
  return 'error' in current
    ? current
    : { error: 'The target kept changing while the user was asked; nothing was written. Try again.' };
}

/**
 * Ask for a write approval that gives up after `timeoutMs` or when `signal`
 * (the client disconnecting) aborts. Either way the question is withdrawn via
 * the signal handed to `confirm`, and a late answer no longer counts.
 */
export async function awaitApproval(
  confirm: (signal: AbortSignal) => Promise<boolean>,
  opts: { timeoutMs: number; signal: AbortSignal }
): Promise<ApprovalOutcome> {
  if (opts.signal.aborted) return 'disconnected';
  const withdraw = new AbortController();
  let reason: 'timeout' | 'disconnected' | undefined;
  const stop = (why: 'timeout' | 'disconnected'): void => {
    if (reason) return;
    reason = why;
    withdraw.abort();
  };
  const timer = setTimeout(() => stop('timeout'), opts.timeoutMs);
  const onDisconnect = (): void => stop('disconnected');
  opts.signal.addEventListener('abort', onDisconnect);
  try {
    const allowed = await confirm(withdraw.signal);
    if (reason) return reason;
    return allowed ? 'allowed' : 'denied';
  } finally {
    clearTimeout(timer);
    opts.signal.removeEventListener('abort', onDisconnect);
  }
}

/**
 * The `CallToolResult` for a `tools/call` request. Warnings (e.g. ignored
 * arguments) go in extra text items so `content[0]` keeps the shape existing
 * clients already parse.
 */
export function buildToolCallResult(result: ToolResult) {
  const content = [{ type: 'text', text: JSON.stringify(result.data ?? result.error ?? null) }];
  for (const warning of result.warnings ?? []) {
    content.push({ type: 'text', text: `Warning: ${warning}` });
  }
  return { isError: !result.ok, content };
}
