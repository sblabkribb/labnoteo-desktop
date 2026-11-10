import { runTool, type ToolDef } from '@labnoteo/core';
import { listen as tauriListen } from '@tauri-apps/api/event';
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { createAiEnv } from '../../ai/aiEnv';
import { vaultGuard, type InvokeFn, type ListenFn, type VaultGuard } from '../../integrations/netIpc';
import { searchNotesIn } from '../../search/indexApi';
import type { CommandContext } from '../commands/context';
import { appTools } from '../context/appTools';
import { toolContext } from '../port/aiCommon';
import { experimentReadmes } from '../port/experiments';
import { CLOSED_REPLY, callMutating, type McpCall } from '../port/mcpCall';
import { TaskQueue, buildToolCallResult } from '../port/mcpApproval';
import { MCP_CALL, MCP_CANCEL, mcpClaim, mcpReply, type McpCallEvent, type McpCancelEvent, type McpReplyIn, type ToolInfo } from './mcpIpc';

/**
 * 웹뷰의 MCP 호스트(C4, Task 36). Rust 서버가 `tools/call` 을 `mcp://call` 로 넘기면 여기서 core 도구를 돌리고
 * `mcp_reply` 로 답한다.
 * - 도구가 무엇을 바꾸는지는 이 목록(`appTools()`: core 도구 + 읽기 전용 문맥 도구)이 정한다. 목록에 없는 이름은 읽기처럼 `runTool` 이
 *   `isError` 결과로 답한다(플러그인과 같다).
 * - 어떤 도구든 돌리기 직전에 `guard.check()` 다음 `mcp_claim` 을 부른다. false 면 아무것도 돌리지도 답하지도 않는다.
 * - 바꾸는 도구는 한 번에 하나씩(TaskQueue) 미리 보기 → 승인(A9, 조합이 끝난 뒤 `unsolicited`) → 실행이다.
 *   `mcp://cancel` 이 그 호출의 신호를 끊는다: 열린 질문은 거둬지고 늦은 허용은 아무것도 쓰지 않는다.
 * - 보관함이 없거나 바뀌면 -32002 로 답한다.
 */

/** Context tools whose experiment comes from `experiment` or `notePath` on MCP (spec §10.1). */
const NOTE_SCOPED = new Set(['list_experiment', 'search_experiment', 'read_note']);

const MCP_EXPERIMENT_ARG = {
  type: 'string',
  description: 'Experiment number, folder name or title. Required unless notePath is given; name another experiment only when the user did.',
};
const MCP_NOTE_PATH_ARG = { type: 'string', description: 'A vault-relative note inside the experiment; its experiment is used.' };

/**
 * The schema MCP clients see. MCP has no current experiment, so the
 * list/search/read tools say `experiment` is required unless `notePath`
 * names a note of the experiment (the handlers accept both).
 */
function mcpSchema(tool: ToolDef): unknown {
  if (!NOTE_SCOPED.has(tool.name)) return tool.inputSchema;
  const schema = tool.inputSchema;
  return { ...schema, properties: { ...schema.properties, experiment: MCP_EXPERIMENT_ARG, notePath: MCP_NOTE_PATH_ARG } };
}

/**
 * Rust 에 넘기는 도구 목록(비밀 아님): core 도구와 읽기 전용 문맥 도구(`appTools()`, 폴더로 감싸지 않음; spec §10.1).
 * 문맥 도구는 MCP 에서 범위를 인자(`experiment`/`notePath`)로만 받는다.
 */
export function toolCatalog(): ToolInfo[] {
  return appTools().map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: mcpSchema(t),
    mutates: t.mutates === true,
  }));
}

function argsOf(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

/**
 * 두 이벤트를 듣기 시작한다. 돌려준 함수는 듣기를 그만두고, 아직 끝나지 않은 호출을 모두 거둔다
 * (열린 승인은 닫히고 아무것도 쓰지 않는다).
 */
export function startMcpHost(ctx: CommandContext, deps: { invoke?: InvokeFn; listen?: ListenFn } = {}): () => void {
  const invoke = deps.invoke ?? (tauriInvoke as InvokeFn);
  const listen = deps.listen ?? tauriListen;
  const tools: ToolDef[] = appTools();
  const writes = new TaskQueue();
  const calls = new Map<string, AbortController>();
  let stopped = false;

  const run = async (event: McpCallEvent, signal: AbortSignal): Promise<McpReplyIn | undefined> => {
    let guard: VaultGuard;
    try {
      guard = await vaultGuard(invoke);
    } catch {
      return CLOSED_REPLY;
    }
    if (!guard.root || guard.signal.aborted) return CLOSED_REPLY;
    const abortOnClose = () => controllerOf(event.callId)?.abort();
    guard.signal.addEventListener('abort', abortOnClose);
    try {
      const env = createAiEnv(ctx, invoke);
      const call: McpCall = {
        env,
        tools,
        claim: async () => {
          await guard.check();
          return mcpClaim(event.callId, invoke);
        },
        beforeWrite: () => guard.check(),
        vaultClosed: () => guard.signal.aborted,
      };
      const args = argsOf(event.args);
      const tool = tools.find((t) => t.name === event.name);
      if (tool?.mutates) return await writes.run(() => callMutating(call, tool, args, signal));
      if (signal.aborted) return guard.signal.aborted ? CLOSED_REPLY : { kind: 'noReply' };
      try {
        if (!(await call.claim())) return undefined;
      } catch {
        return CLOSED_REPLY;
      }
      // MCP 는 현재 실험이 없다: 문맥 도구의 범위는 인자에서만 오고, 없으면 scopeRequired 다.
      const context = toolContext(env, {
        beforeWrite: call.beforeWrite,
        experiments: async () => (await experimentReadmes(env.host)).map((e) => ({ folder: e.folder, title: e.title })),
        searchIn: (query, prefix, limit) => searchNotesIn(query, prefix, limit, invoke),
      });
      const result = await runTool(tools, event.name, context, args);
      return { kind: 'result', result: buildToolCallResult(result) };
    } finally {
      guard.signal.removeEventListener('abort', abortOnClose);
    }
  };

  const controllerOf = (callId: string) => calls.get(callId);

  const onCall = (event: McpCallEvent) => {
    if (stopped || typeof event?.callId !== 'string' || calls.has(event.callId)) return;
    const controller = new AbortController();
    calls.set(event.callId, controller);
    void run(event, controller.signal)
      .catch((err: unknown) => {
        console.error('[labnoteo] MCP tool call failed:', err);
        return { kind: 'result', result: buildToolCallResult({ ok: false, error: String(err) }) } as McpReplyIn;
      })
      .then(async (reply) => {
        calls.delete(event.callId);
        if (reply) await mcpReply(event.callId, reply, invoke).catch(() => undefined);
      });
  };

  const onCancel = (event: McpCancelEvent) => {
    if (typeof event?.callId === 'string') calls.get(event.callId)?.abort();
  };

  const unlisteners: Array<Promise<() => void>> = [
    listen<McpCallEvent>(MCP_CALL, (e) => onCall(e.payload)),
    listen<McpCancelEvent>(MCP_CANCEL, (e) => onCancel(e.payload)),
  ];

  return () => {
    if (stopped) return;
    stopped = true;
    for (const p of unlisteners) void p.then((off) => off(), () => undefined);
    for (const c of calls.values()) c.abort();
  };
}
