/**
 * 도우미만 쓰는 도구(assistant spec §4.4, plan Task 11A, R8). 내장 런타임만 더한다: `appTools()` 는 MCP 서버의 도구
 * 목록(`labnote/mcp/mcpHost.ts` `toolCatalog()`)도 만들므로 여기 도구는 그쪽에 넣지 않는다.
 */
import type { ToolDef } from '@labnoteo/core';
import type { Scope } from '../../labnote/context/scope';
import { addSectionTool } from './addSection';
import { searchCatalogTool } from './searchCatalog';

export { addSectionText, isAddSectionPreview, type AddSectionPreview } from './addSection';

/** `add_section`(범위 `scope` 안의 노트만)과 `search_catalog`. */
export function assistantTools(scope: Scope | undefined): ToolDef[] {
  return [addSectionTool(scope), searchCatalogTool()];
}
