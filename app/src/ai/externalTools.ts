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
import { scholarAgentTools } from '../integrations/scholar/agentTools';
import { scholarIpcFor } from '../integrations/scholar/ipc';
import type { AiEnv } from './aiEnv';

export interface ExternalToolMeta {
  /** `web` 은 도우미의 `web_search`/`fetch_page`(assistant/web/agentTools.ts, assistant spec §7). */
  kind: 'mcp' | 'scholar' | 'web';
  serverId?: string;
  serverName?: string;
  toolTitle?: string;
  readOnly: boolean;
}

/**
 * runAgent 가 confirm 의 넷째 인자로 넘기는 것(spec §7.4). `webAfterTaint`: 바깥 내용이 닿은 뒤의 `web_search`
 * (검색어가 PC 밖으로 나간다, assistant spec §7.1). `web`: 이 실행에 웹에서 온 내용이 닿았다(확인 글에 웹 줄을 붙인다).
 * `historyOnly`(앱 도우미가 confirm 을 감쌀 때 단다, builtinRuntime): 오염이 저장된 기록에서만 왔다. 이번 차례는 바깥 내용을
 * 읽지 않았으므로 확인 글은 "이전 대화에서 읽었다"고 말한다(real-server check, 2026-11-11).
 */
export interface ConfirmNote {
  tainted: boolean;
  reason?: 'crossServer' | 'bigArgs' | 'webAfterTaint';
  web?: boolean;
  historyOnly?: boolean;
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
 * 이번 실행에 줄 외부 도구: 켠 문헌 검색 출처의 도구, 그다음 켠 MCP 서버의 도구. 실행을 시작할 때 설정,
 * `mcp_client_tools_cached`, `mcp_client_secret_status` 로만 만들고 서버에는 연결하지 않는다(spec §7.5).
 * 켠 MCP 서버가 없으면 Rust 에 묻지도 않는다. 캐시나 토큰 상태를 읽지 못하면 MCP 도구 없이 간다.
 * 두 쪽 모두 실행의 취소 신호에 묶인다(부르는 중인 호출은 `net_cancel` 로 멈춘다).
 */
export async function externalAgentTools(env: AiEnv, opts: ExternalRunOpts = {}): Promise<ExternalTools> {
  const settings = env.settings();
  const scholar = scholarAgentTools(settings, scholarIpcFor(env.invoke, opts.signal));
  const mcp = await mcpTools(env, opts);
  const meta = new Map<string, ExternalToolMeta>([...scholar.meta, ...mcp.meta]);
  return { tools: [...scholar.tools, ...mcp.tools], meta };
}

async function mcpTools(env: AiEnv, opts: ExternalRunOpts): Promise<{ tools: ToolDef[]; meta: Map<string, ExternalToolMeta> }> {
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

// Controls (C0, DEL, C1) and bidi/zero-width formatting characters.
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g;

/** 확인 글에 넣을 검색어: 한 줄, 제어·양방향 글자 없이, 200자까지(Rust `web_search::MAX_QUERY`). */
function queryLine(args: Record<string, unknown>): string {
  return oneLine(args.query, 200);
}

/** 확인 글에 넣을 한 줄: 제어·양방향 글자 없이, `max` 자까지. 글이 아니면 빈 글. */
function oneLine(v: unknown, max = 2000): string {
  const s = typeof v === 'string' ? v : '';
  return [...s.replace(/[\r\n\t]+/g, ' ').replace(UNSAFE_CHARS, '').replace(/\s+/g, ' ').trim()].slice(0, max).join('');
}

/**
 * 외부 도구 호출의 확인 글(spec §7.2, §7.4): 서버와 도구 이름, 왜 묻는지, 보낼 인자. core `buildApprovalMessage` 는
 * core 미리보기만 알아서 쓰지 않는다. 바깥 내용이 닿은 뒤의 웹 검색은 보낼 검색어를 따로 보이고, 웹에서 온 내용이
 * 닿은 실행이면 웹 줄(`web.tainted`)을 덧붙인다(assistant spec §7.3).
 */
export function externalApprovalMessage(call: ToolCall, meta: ExternalToolMeta, mutates: boolean, note?: ConfirmNote): string {
  if (meta.kind === 'web') return webApprovalMessage(call, mutates, note);
  const server = meta.serverName ?? meta.serverId ?? meta.kind;
  const tool = meta.toolTitle ?? call.name;
  const parts = [t('mcpClient.confirm.title', server, tool)];
  if (mutates) parts.push(t('mcpClient.confirm.writes'));
  if (note?.reason === 'crossServer') parts.push(note.historyOnly ? t('ai.confirm.crossServerHistory') : t('ai.confirm.crossServer'));
  if (note?.reason === 'bigArgs') parts.push(t('mcpClient.confirm.bigArgs'));
  if (note?.tainted && mutates) parts.push(note.historyOnly ? t('ai.confirm.taintedHistory') : t('ai.confirm.tainted'));
  if (note?.web && (mutates || note.reason)) parts.push(t('web.tainted'));
  parts.push(`${t('mcpClient.confirm.args')}\n${argsPreview(call.arguments)}`);
  return parts.join('\n\n');
}

/**
 * 웹 도구의 확인 글(Visual QA): 도구 id('web_search') 와 JSON 대신 말로 — 무엇을 하려는지, 왜 묻는지, 보낼 검색어(또는 열
 * 주소) 한 줄. 검색어·주소는 한 줄로, 제어·방향 글자 없이 보인다.
 */
function webApprovalMessage(call: ToolCall, mutates: boolean, note?: ConfirmNote): string {
  const page = call.name === 'fetch_page';
  const parts = [page ? t('web.confirm.fetch') : t('web.confirm.search')];
  if (note?.reason === 'webAfterTaint') parts.push(note.historyOnly ? t('web.confirm.whyHistory') : t('web.confirm.why'));
  if (note?.reason === 'crossServer') parts.push(note.historyOnly ? t('ai.confirm.crossServerHistory') : t('ai.confirm.crossServer'));
  if (note?.reason === 'bigArgs') parts.push(t('mcpClient.confirm.bigArgs'));
  if (note?.tainted && mutates) parts.push(note.historyOnly ? t('ai.confirm.taintedHistory') : t('ai.confirm.tainted'));
  if (note?.web && (mutates || note.reason)) parts.push(t('web.tainted'));
  parts.push(page ? t('web.confirm.url', oneLine(call.arguments.url)) : t('web.confirm.query', queryLine(call.arguments)));
  return parts.join('\n\n');
}
