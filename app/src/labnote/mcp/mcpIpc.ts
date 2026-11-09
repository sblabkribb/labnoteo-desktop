import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import type { InvokeFn } from '../../integrations/netIpc';

/**
 * SP7 Part C MCP 커맨드의 타입 있는 래퍼(Task 36). 서버와 토큰은 Rust 가 갖는다: 웹뷰는 도구 목록을 넘기고,
 * `mcp://call` 을 받아 도구를 돌린 뒤 `mcp_reply` 로 답한다. 토큰 값은 이 파일을 지나지 않는다(불리언과 번호만).
 * 거절은 Rust 의 `McpError {kind, message}` 그대로다(`kind`: portInUse, keychain, badInput, clipboard, io, notRunning).
 */

/** 도구 목록 한 줄(비밀 아님). `mutates` 는 Rust 에 남고 `tools/list` 에는 나가지 않는다. */
export interface ToolInfo {
  name: string;
  description: string;
  inputSchema: unknown;
  mutates: boolean;
}

/** 호출 하나에 대한 웹뷰의 답. `noReply` 는 클라이언트 연결을 답 없이 닫는다. */
export type McpReplyIn =
  | { kind: 'result'; result: unknown }
  | { kind: 'error'; code: number; message: string }
  | { kind: 'noReply' };

export interface McpStatus {
  running: boolean;
  port: number | null;
  tokenSet: boolean;
  tokenEpoch: number;
}

export interface TokenStatus {
  set: boolean;
  epoch: number;
}

/** Rust 가 `tools/call` 을 넘길 때의 이벤트. 페이로드 `{callId, name, args, mutates}`. */
export const MCP_CALL = 'mcp://call';
/** Rust 가 아직 맡지 않은 호출을 끝냈을 때(시간 초과, 연결 끊김, 비우기, 멈춤)의 이벤트. 페이로드 `{callId}`. */
export const MCP_CANCEL = 'mcp://cancel';

export interface McpCallEvent {
  callId: string;
  name: string;
  args: unknown;
  mutates: boolean;
}

export interface McpCancelEvent {
  callId: string;
}

export function mcpStart(port: number, tools: ToolInfo[], invoke: InvokeFn = tauriInvoke): Promise<McpStatus> {
  return invoke<McpStatus>('mcp_start', { port, tools });
}

export async function mcpStop(invoke: InvokeFn = tauriInvoke): Promise<void> {
  await invoke<null>('mcp_stop', {});
}

export function mcpStatus(invoke: InvokeFn = tauriInvoke): Promise<McpStatus> {
  return invoke<McpStatus>('mcp_status', {});
}

/** 도구를 돌리기 직전에 부른다. Rust 가 그 호출을 아직 기다리고 있을 때만 true 다. */
export function mcpClaim(callId: string, invoke: InvokeFn = tauriInvoke): Promise<boolean> {
  return invoke<boolean>('mcp_claim', { callId });
}

/** 모르는(취소됐거나 비워졌거나 늦은) 호출이면 false. */
export function mcpReply(callId: string, reply: McpReplyIn, invoke: InvokeFn = tauriInvoke): Promise<boolean> {
  return invoke<boolean>('mcp_reply', { callId, reply });
}

/** 기다리는 호출을 모두 -32002 로 끝낸다. 끝낸 수. */
export function mcpDrain(invoke: InvokeFn = tauriInvoke): Promise<number> {
  return invoke<number>('mcp_drain', {});
}

export function mcpTokenStatus(invoke: InvokeFn = tauriInvoke): Promise<TokenStatus> {
  return invoke<TokenStatus>('mcp_token_status', {});
}

export function mcpTokenRegenerate(invoke: InvokeFn = tauriInvoke): Promise<TokenStatus> {
  return invoke<TokenStatus>('mcp_token_regenerate', {});
}

/** "클라이언트 연결"의 클라이언트(닫힌 목록, Rust `McpClient`). */
export type McpClientId = 'claudeCode' | 'cursor' | 'vsCode' | 'claudeDesktop';

/** 토큰 대신 그 클라이언트의 설정 글(토큰을 Rust 가 채운다)을 복사할 때. */
export interface McpSnippet {
  client: McpClientId;
  port: number;
}

/**
 * Rust 가 클립보드에 직접 쓴다(Win+V 기록 제외, 60초 뒤 지움). 토큰은 웹뷰로 오지 않는다.
 * `snippet` 이 있으면 토큰을 넣은 그 클라이언트의 설정 글을 복사한다.
 */
export async function mcpTokenCopy(invoke: InvokeFn = tauriInvoke, snippet: McpSnippet | null = null): Promise<void> {
  await invoke<null>('mcp_token_copy', { snippet });
}
