/**
 * 외부 도구(MCP 서버의 도구, 문헌 검색)를 에이전트에 줄 때의 곁 정보(spec §7.2).
 *
 * `ToolDef`/`ToolPreview` 는 vendor(@labnoteo/core, 읽기 전용) 것이라 필드를 더할 수 없다. 그래서 외부 도구는 평범한
 * core `ToolDef` 이고, 앱이 알아야 할 것(어느 서버, 읽기만 하는지)은 함수 이름으로 찾는 이 곁 지도에 둔다.
 */
import type { ToolDef } from '@labnoteo/core';
import { t } from '../i18n/t';
import type { ToolCall } from '../labnote/port/llmProvider';
import { mcpAgentTools, type McpCallFn } from '../integrations/mcpClient/agentTools';
import type { McpSecretFlag, McpServerInfo } from '../integrations/mcpClient/types';
import { mcpClientCall, mcpClientSecretStatus, mcpClientToolsCached } from '../integrations/netIpc';
import type { AiEnv } from './aiEnv';

export interface ExternalToolMeta {
  kind: 'mcp' | 'scholar';
  serverId?: string;
  serverName?: string;
  toolTitle?: string;
  readOnly: boolean;
}

/** runAgent 가 confirm 의 넷째 인자로 넘기는 것(spec §7.4). */
export interface ConfirmNote {
  tainted: boolean;
  reason?: 'crossServer' | 'bigArgs';
}

export interface ExternalTools {
  tools: ToolDef[];
  meta: ReadonlyMap<string, ExternalToolMeta>;
}

/** 읽기만 하는 MCP 호출도 직렬화한 인자가 이보다 길면 묻는다(spec §7.2). 확인 글에 보이는 인자도 이 길이까지. */
export const BIG_ARGS_CHARS = 2000;

/** 실행 하나가 외부 도구에 묶어 주는 것. */
export interface ExternalRunOpts {
  /** 실행의 취소 신호: 부르는 중인 MCP 호출은 `net_cancel` 로 멈춘다. */
  signal?: AbortSignal;
  /** 사람에게 보일 짧은 알림(토큰이 맞지 않을 때, 서버마다 세션에 한 번). */
  notify?: (message: string) => void;
}

/**
 * 이번 실행에 줄 외부 도구. 실행을 시작할 때 설정, `mcp_client_tools_cached`, `mcp_client_secret_status` 로만 만들고
 * 서버에는 연결하지 않는다(spec §7.5). 켠 MCP 서버가 없으면 Rust 에 묻지도 않는다. 캐시나 토큰 상태를 읽지 못하면 MCP
 * 도구 없이 간다. 문헌 검색 도구(Task 13)도 여기에 붙는다.
 */
export async function externalAgentTools(env: AiEnv, opts: ExternalRunOpts = {}): Promise<ExternalTools> {
  const servers = env.settings().mcpClientServers ?? [];
  if (!servers.some((s) => s.enabled)) return { tools: [], meta: new Map() };
  let cache: Record<string, McpServerInfo>;
  let secrets: Record<string, McpSecretFlag>;
  try {
    [cache, secrets] = await Promise.all([mcpClientToolsCached(env.invoke), mcpClientSecretStatus(env.invoke)]);
  } catch {
    return { tools: [], meta: new Map() };
  }
  const call: McpCallFn = (id, tool, args, requestId) => mcpClientCall(id, tool, args, requestId, env.invoke, opts.signal);
  return mcpAgentTools({ mcpClientServers: servers }, cache, secrets, call, { notify: opts.notify });
}

/** 인자를 보기 좋은 JSON 으로, 2,000자에서 자른다. 확인 창은 글로만 보여 준다(HTML 아님). */
export function argsPreview(args: Record<string, unknown>): string {
  let json: string;
  try {
    json = JSON.stringify(args, null, 2) ?? '{}';
  } catch {
    json = '{}';
  }
  return json.length > BIG_ARGS_CHARS ? `${json.slice(0, BIG_ARGS_CHARS - 1)}…` : json;
}

/**
 * 외부 도구 호출의 확인 글(spec §7.2, §7.4): 서버와 도구 이름, 왜 묻는지, 보낼 인자. core `buildApprovalMessage` 는
 * core 미리보기만 알아서 쓰지 않는다.
 */
export function externalApprovalMessage(call: ToolCall, meta: ExternalToolMeta, mutates: boolean, note?: ConfirmNote): string {
  const server = meta.serverName ?? meta.serverId ?? meta.kind;
  const tool = meta.toolTitle ?? call.name;
  const parts = [t('mcpClient.confirm.title', server, tool)];
  if (mutates) parts.push(t('mcpClient.confirm.writes'));
  if (note?.reason === 'crossServer') parts.push(t('ai.confirm.crossServer'));
  if (note?.reason === 'bigArgs') parts.push(t('mcpClient.confirm.bigArgs'));
  if (note?.tainted && mutates) parts.push(t('ai.confirm.tainted'));
  parts.push(`${t('mcpClient.confirm.args')}\n${argsPreview(call.arguments)}`);
  return parts.join('\n\n');
}
