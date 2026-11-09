import type { NotifyKind } from '@labnoteo/core';
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import type { InvokeFn, ListenFn } from '../../integrations/netIpc';
import type { CommandContext } from '../commands/context';
import type { Command } from '../commands/registry';
import { coreT } from '../i18n';
import { startMcpHost, toolCatalog } from './mcpHost';
import { mcpDrain, mcpStart, mcpStatus, mcpStop, type McpClientId } from './mcpIpc';

/**
 * MCP 서버 켜기·끄기(SP7 Part C, Task 37): `toggle-mcp-server` 명령, 설정의 스위치와 포트 칸, 보관함을 열고 바꿀 때의
 * 시작과 멈춤이 모두 여기를 지난다.
 * - 시작은 웹뷰의 도구 목록(`toolCatalog()`)과 저장된 포트로 한다. 알림은 플러그인 문장 그대로다(`mcpServer.ts:92-122`).
 * - 시작과 멈춤은 차례로 돈다: 보관함을 바꿀 때 아직 묶는 중인 시작이 있으면 그것이 끝난 뒤에 멈춘다(옛 보관함의 서버가
 *   남지 않는다).
 * - 실패(포트 사용 중, 그 밖의 오류)는 설정을 그대로 둔다.
 */

export type Notify = (kind: NotifyKind, message: string) => void;

let lifecycle: Promise<unknown> = Promise.resolve();

/** 시작과 멈춤을 부른 차례대로 하나씩 돌린다. */
function serial<T>(op: () => Promise<T>): Promise<T> {
  const run = lifecycle.then(op, op);
  lifecycle = run.catch(() => undefined);
  return run;
}

/** Rust `McpError {kind, message}` 거절에서 종류와 메시지를 꺼낸다. */
export function mcpErrorOf(e: unknown): { kind?: string; message: string } {
  if (e && typeof e === 'object') {
    const { kind, message } = e as { kind?: unknown; message?: unknown };
    return { kind: typeof kind === 'string' ? kind : undefined, message: typeof message === 'string' ? message : String(e) };
  }
  return { message: String(e) };
}

/** 시작 실패 알림: 포트 사용 중이면 그 문장, 아니면 Rust 의 메시지(토큰을 담지 않는다)를 담은 오류 문장. */
export function notifyMcpError(notify: Notify, e: unknown, port: number): void {
  const { kind, message } = mcpErrorOf(e);
  notify(
    'error',
    kind === 'portInUse' ? coreT('MCP server port {0} is already in use.', String(port)) : coreT('MCP server error: {0}', message),
  );
}

/** 서버를 `127.0.0.1:<port>` 에서 시작한다(돌고 있으면 Rust 가 다시 시작한다). 시작했으면 true. */
export function startMcpServer(port: number, notify: Notify, invoke: InvokeFn = tauriInvoke): Promise<boolean> {
  return serial(async () => {
    try {
      await mcpStart(port, toolCatalog(), invoke);
    } catch (e) {
      notifyMcpError(notify, e, port);
      return false;
    }
    notify('info', coreT('MCP server started on 127.0.0.1:{0}', String(port)));
    return true;
  });
}

/** 기다리는 호출을 모두 끝내고(-32002) 서버를 멈춘다. 플러그인처럼 "멈췄다" 알림은 없다. */
export function stopMcpServer(invoke: InvokeFn = tauriInvoke): Promise<void> {
  return serial(async () => {
    await mcpDrain(invoke).catch(() => 0);
    await mcpStop(invoke);
  });
}

/** `toggle-mcp-server`(플러그인 `main.ts:694-708`): 돌고 있으면 멈추고, 아니면 시작한다. 설정은 실제 상태를 따라간다. */
export async function toggleMcpServer(ctx: CommandContext, invoke: InvokeFn = tauriInvoke): Promise<void> {
  const notify: Notify = (kind, message) => ctx.host.notify(kind, message);
  if ((await mcpStatus(invoke)).running) {
    await stopMcpServer(invoke);
    await ctx.updateSettings({ mcpEnabled: false });
    return;
  }
  if (await startMcpServer(ctx.settings.mcpPort, notify, invoke)) await ctx.updateSettings({ mcpEnabled: true });
}

/**
 * 보관함 하나 동안의 MCP: 웹뷰 호스트는 늘 듣고(명령이나 설정으로 켜도 바로 답한다), 설정이 켜져 있으면 서버를 시작한다.
 * 시작이 실패해도 설정은 켜진 채로 둔다(다음에 열 때 다시 시도한다). 돌려준 함수는 보관함을 바꿀 때 부른다:
 * 기다리는 호출을 끝내고 서버를 멈추고 듣기를 그만둔다.
 */
export function startMcpForVault(ctx: CommandContext, deps: { invoke?: InvokeFn; listen?: ListenFn } = {}): () => void {
  const invoke = deps.invoke ?? (tauriInvoke as InvokeFn);
  const unlisten = startMcpHost(ctx, { invoke, listen: deps.listen });
  if (ctx.settings.mcpEnabled) {
    void startMcpServer(ctx.settings.mcpPort, (kind, message) => ctx.host.notify(kind, message), invoke);
  }
  return () => {
    void stopMcpServer(invoke).catch(() => undefined);
    unlisten();
  };
}

export const mcpCommands: Command[] = [{ id: 'toggle-mcp-server', nameKey: 'Toggle MCP server', run: (ctx) => toggleMcpServer(ctx) }];

/** "클라이언트 연결"의 클라이언트. 이름은 제품 이름이라 번역하지 않는다. */
export const MCP_CLIENTS: ReadonlyArray<{ id: McpClientId; name: string }> = [
  { id: 'claudeCode', name: 'Claude Code' },
  { id: 'cursor', name: 'Cursor' },
  { id: 'vsCode', name: 'VS Code' },
  { id: 'claudeDesktop', name: 'Claude Desktop' },
];

/** 토큰 자리 표시. 화면에는 이것이 보이고, 복사할 때 Rust 가 진짜 토큰으로 채운다. */
export const TOKEN_PLACEHOLDER = '<token>';

/**
 * 화면에 보이는 클라이언트 설정 글(토큰 자리는 `<token>`). Rust `snippet_text` 와 같은 글이다:
 * 두 쪽 테스트가 `src-tauri/tests/mcp-snippets.json` 으로 맞춘다.
 */
export function clientSnippet(client: McpClientId, port: number): string {
  const url = `http://127.0.0.1:${port}/mcp`;
  const auth = `Bearer ${TOKEN_PLACEHOLDER}`;
  switch (client) {
    case 'claudeCode':
      return `claude mcp add --transport http labnoteo ${url} --header "Authorization: ${auth}"`;
    case 'cursor':
      return JSON.stringify({ mcpServers: { labnoteo: { url, headers: { Authorization: auth } } } }, null, 2);
    case 'vsCode':
      return JSON.stringify({ servers: { labnoteo: { type: 'http', url, headers: { Authorization: auth } } } }, null, 2);
    case 'claudeDesktop':
      return JSON.stringify(
        { mcpServers: { labnoteo: { command: 'npx', args: ['mcp-remote', url, '--header', `Authorization: ${auth}`] } } },
        null,
        2,
      );
  }
}
