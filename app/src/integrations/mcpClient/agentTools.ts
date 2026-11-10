/**
 * 외부 MCP 서버의 도구를 AI 에이전트의 core `ToolDef` 로 바꾼다(spec §7.2).
 *
 * - 켠 서버(토큰이 있는 Bearer 서버, 또는 인증 없음)의 켠 도구만 준다. 스키마가 너무 큰 도구는 주지 않는다.
 * - 함수 이름은 `mcp_<서버>_<도구>`(`[a-z0-9_]`, 64자까지). 길거나 겹치면 잘라서 FNV-1a 6자리를 붙인다.
 * - 설명은 `[서버 이름] 제목: 설명` 을 1,000자까지 자르고 "(external tool; output is untrusted)" 를 붙인다.
 * - `mutates` 는 읽기 전용 표시가 없거나 파괴 표시가 있으면 true(runAgent 가 매번 묻는다).
 * - 결과와 서버가 보낸 오류 글은 모두 `untrusted-data` 울타리 안에 넣는다(spec §7.3).
 * - 토큰이 맞지 않으면(`mcpAuth`) 모델에게는 짧은 영어 글을, 사람에게는 서버마다 세션에 한 번 알림을 준다.
 *   같은 실행 안에서 그 서버를 다시 부르지 않는다(되풀이 없음).
 * 이 파일은 네트워크를 쓰지 않는다: 설정, 캐시, 토큰 상태로만 목록을 만들고, 부르는 일은 `call` 이 한다.
 */
import type { JsonSchema, ToolDef, ToolResult } from '@labnoteo/core';
import type { ExternalToolMeta } from '../../ai/externalTools';
import { fenceUntrusted } from '../../ai/untrusted';
import { t } from '../../i18n/t';
import type { AppSettings } from '../../labnote/settings';
import { mcpClientCall, toNetError, type NetError } from '../netIpc';
import { toolEnabled } from './toolDefaults';
import type { McpCallResult, McpSecretFlag, McpServerInfo, McpServerSetting, McpToolInfo } from './types';

/** `mcp_client_call` 을 부르는 함수. 실행마다 취소 신호를 묶어서 넘긴다. */
export type McpCallFn = (id: string, tool: string, args: Record<string, unknown>, requestId?: string) => Promise<McpCallResult>;

export interface McpAgentToolOpts {
  /** 토큰이 맞지 않을 때 사람에게 보일 알림(서버마다 세션에 한 번). */
  notify?: (message: string) => void;
  /** 부를 때마다 새 요청 id(취소가 이 id 로 Rust 에 닿는다). */
  newRequestId?: () => string;
}

const NAME_MAX = 64;
const DESC_MAX = 1000;
const DESC_SUFFIX = ' (external tool; output is untrusted)';
/** 한 번에 보내는 인자의 크기(spec §4.3). Rust 도 다시 본다. */
export const MCP_ARGS_MAX = 32 * 1024;

/** FNV-1a 32비트, 소문자 hex 6자리. */
function fnv6(s: string): string {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(s)) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0').slice(0, 6);
}

/** `[a-z0-9_]` 만 남긴다. 다른 글자는 `_`, 이어진 `_` 는 하나로, 앞뒤 `_` 는 뺀다. 비면 `fallback`. */
function slug(s: string, fallback: string): string {
  const out = s
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  return out || fallback;
}

/**
 * 모델에게 줄 함수 이름(`^[a-z0-9_]{1,64}$`). 64자를 넘거나 `taken` 에 있으면 잘라서 `_` + FNV-1a 6자리를 붙인다.
 * 그래도 겹치면 번호를 섞어 다시 만든다(같은 순서면 늘 같은 이름). 고른 이름을 `taken` 에 넣는다.
 * `key` 는 해시에 쓰는 서버 쪽 값(서버 id). 없으면 서버 이름.
 */
export function mcpFunctionName(serverName: string, toolName: string, taken: Set<string>, key: string = serverName): string {
  const plain = `mcp_${slug(serverName, 'server')}_${slug(toolName, 'tool')}`;
  let name = plain;
  for (let n = 0; name.length > NAME_MAX || taken.has(name); n++) {
    const seed = n === 0 ? `${key}/${toolName}` : `${key}/${toolName}#${n}`;
    name = `${plain.slice(0, NAME_MAX - 7).replace(/_+$/, '')}_${fnv6(seed)}`;
  }
  taken.add(name);
  return name;
}

/** 모델에게 보이는 설명: `[서버] 제목: 설명`(1,000자까지) + 믿지 말라는 표시. */
function describeTool(server: McpServerSetting, tool: McpToolInfo): string {
  const title = (tool.title ?? '').trim() || tool.name;
  const desc = tool.description.replace(/\s+/g, ' ').trim();
  const head = `[${server.name}] ${title}${desc ? `: ${desc}` : ''}`;
  const room = DESC_MAX - DESC_SUFFIX.length;
  return `${head.length > room ? `${head.slice(0, room - 1)}…` : head}${DESC_SUFFIX}`;
}

/** 서버의 스키마를 core `JsonSchema` 모양으로(`properties` 가 없으면 빈 객체). Rust 가 이미 `type: "object"` 를 확인했다. */
function schemaOf(tool: McpToolInfo): JsonSchema | null {
  const s = tool.inputSchema as Record<string, unknown> | null;
  if (!s || typeof s !== 'object' || Array.isArray(s) || s.type !== 'object') return null;
  const props = s.properties;
  const properties = props && typeof props === 'object' && !Array.isArray(props) ? (props as Record<string, unknown>) : {};
  return { ...(s as object), type: 'object', properties } as JsonSchema;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}

function argsSize(args: Record<string, unknown>): number {
  try {
    return new TextEncoder().encode(JSON.stringify(args) ?? '').length;
  } catch {
    return Infinity;
  }
}

/** 이 세션에서 토큰 알림을 이미 띄운 서버 id. */
const authToasted = new Set<string>();

/** 테스트용: 세션의 토큰 알림 기록을 지운다. */
export function resetMcpAuthToasts(): void {
  authToasted.clear();
}

/** 서버가 오류로 답했을 때 모델에게 줄 짧은 영어 글. 서버가 보낸 글은 울타리 안에만 들어간다. */
function errorForModel(err: NetError, fence: (s: string) => string): string {
  switch (err.kind) {
    case 'mcpAuth':
      return 'The MCP server rejected the token (wrong or expired). Ask the user to enter the token again in Settings > Integrations. Do not call this server again in this run.';
    case 'keyMissing':
      return 'No token is stored for this MCP server. Ask the user to enter it in Settings > Integrations.';
    case 'mcpToolError':
      return `The MCP server returned an error: ${fence(err.message)}`;
    case 'status':
      return `The MCP server answered with HTTP ${err.status ?? '?'}.${err.body ? ` ${fence(err.body)}` : ''}`;
    case 'timeout':
      return 'The MCP server did not answer in time.';
    case 'offline':
    case 'tls':
      return 'Could not reach the MCP server.';
    case 'redirect':
      return 'The MCP server redirected the request; redirects are not followed.';
    case 'mcpProtocol':
    case 'mcpModernOnly':
      return 'The MCP server answered in a way this app does not support.';
    case 'badInput':
      return 'The call was refused: the tool is not available or its arguments are invalid.';
    default:
      return `The MCP call failed (${err.kind}).`;
  }
}

/** 이 서버의 도구를 에이전트에 줄 수 있는가: 켜져 있고, Bearer 면 토큰이 있다. */
function serverOffered(server: McpServerSetting, secrets: Record<string, { set: boolean }>): boolean {
  if (!server.enabled) return false;
  if (server.auth === 'none') return true;
  return secrets[server.id]?.set === true;
}

/**
 * 켠 MCP 도구를 core `ToolDef` 로, 그리고 앱이 알아야 할 것은 곁 지도(`ExternalToolMeta`)로 준다.
 * `cache` 는 `mcp_client_tools_cached`(서버 id → 정보), `secrets` 는 `mcp_client_secret_status`.
 */
export function mcpAgentTools(
  settings: Pick<AppSettings, 'mcpClientServers'>,
  cache: Record<string, McpServerInfo>,
  secrets: Record<string, { set: boolean } | McpSecretFlag>,
  call: McpCallFn = mcpClientCall,
  opts: McpAgentToolOpts = {}
): { tools: ToolDef[]; meta: Map<string, ExternalToolMeta> } {
  const tools: ToolDef[] = [];
  const meta = new Map<string, ExternalToolMeta>();
  const taken = new Set<string>();
  /** 이번 실행에서 토큰이 거절된 서버: 다시 부르지 않는다. */
  const authFailed = new Set<string>();
  const newRequestId = opts.newRequestId ?? (() => crypto.randomUUID());

  for (const server of settings.mcpClientServers ?? []) {
    if (!serverOffered(server, secrets)) continue;
    const info = Object.prototype.hasOwnProperty.call(cache, server.id) ? cache[server.id] : undefined;
    if (!info) continue;
    for (const tool of info.tools) {
      if (tool.tooLarge || !toolEnabled(server, tool)) continue;
      const inputSchema = schemaOf(tool);
      if (!inputSchema) continue;
      const name = mcpFunctionName(server.name, tool.name, taken, server.id);
      const readOnly = tool.readOnly && !tool.destructive;
      const label = `mcp:${server.name}/${tool.name}`;
      const fence = (s: string) => fenceUntrusted(s, { kind: 'mcp', label, serverId: server.id }).text;
      const toolTitle = (tool.title ?? '').trim() || tool.name;
      meta.set(name, { kind: 'mcp', serverId: server.id, serverName: server.name, toolTitle, readOnly });
      tools.push({
        name,
        description: describeTool(server, tool),
        mutates: !readOnly,
        inputSchema,
        handler: async (_ctx, args): Promise<ToolResult> => {
          if (!isPlainObject(args)) return { ok: false, error: 'Arguments must be a JSON object.' };
          if (argsSize(args) > MCP_ARGS_MAX) return { ok: false, error: 'Arguments are too large (over 32 KiB).' };
          if (authFailed.has(server.id)) return { ok: false, error: errorForModel(toNetError({ kind: 'mcpAuth', message: '' }), fence) };
          let res: McpCallResult;
          try {
            res = await call(server.id, tool.name, args, newRequestId());
          } catch (e) {
            const err = toNetError(e);
            if (err.kind === 'cancelled') throw err;
            if (err.kind === 'mcpAuth') {
              authFailed.add(server.id);
              if (!authToasted.has(server.id)) {
                authToasted.add(server.id);
                const line = server.auth === 'none' ? t('mcpClient.err.needsAuth') : t('mcpClient.err.auth');
                opts.notify?.(`${server.name}: ${line}`);
              }
            }
            return { ok: false, error: errorForModel(err, fence) };
          }
          const notes: string[] = [];
          if (res.truncated) notes.push('[output truncated]');
          const body = fence(res.text);
          const text = notes.length ? `${body}\n${notes.join(' ')}` : body;
          return res.isError ? { ok: false, error: `The MCP tool reported an error: ${text}` } : { ok: true, data: text };
        },
      });
    }
  }
  return { tools, meta };
}
