import type { McpServerSetting, McpToolInfo } from './types';

/**
 * 도구 하나가 AI 에이전트에게 켜져 있는지(spec §7.1).
 * - 설명(스키마)이 너무 커서 쓸 수 없는 도구는 늘 꺼져 있다.
 * - 사용자가 고른 값이 있으면 그것을 따른다.
 * - 없으면 프리셋 서버의 읽기 전용(파괴 표시 없음) 도구만 켜진다. 직접 넣은 서버와 가져온 서버는 모두 꺼져 있다.
 * 주석(readOnly, destructive)은 서버가 알려 준 것이라 믿을 수 없다: 기본값을 고를 때와 확인을 물을지 정할 때만 쓴다.
 */
export function toolEnabled(server: McpServerSetting, tool: McpToolInfo): boolean {
  if (tool.tooLarge) return false;
  if (Object.prototype.hasOwnProperty.call(server.tools, tool.name)) return server.tools[tool.name] === true;
  return server.preset !== undefined && tool.readOnly && !tool.destructive;
}

/** 사용자의 선택을 적은 새 서버 항목. 받은 항목은 바꾸지 않는다. */
export function setToolEnabled(server: McpServerSetting, name: string, on: boolean): McpServerSetting {
  const tools: Record<string, boolean> = { ...server.tools };
  Object.defineProperty(tools, name, { value: on, enumerable: true, writable: true, configurable: true });
  return { ...server, tools };
}
