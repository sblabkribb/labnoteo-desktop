import type { McpPreset } from './types';

/**
 * 미리 넣어 둔 MCP 서버(spec §5.3). 둘 다 KBF 로그인 토큰(KBF_SSO_ACCESS_TOKEN)을 Bearer 로 쓴다. 저장하기 전에도
 * "외부 MCP 서버" 묶음 맨 위에 보이고, 처음 토큰을 저장할 때 새 id 로 `McpServerSetting` 이 생긴다. 주소는 바꿀 수 있다
 * (시험 서버 등). 사용자가 토큰을 저장하고 "연결 확인"을 누르거나 에이전트가 켠 도구를 쓰기 전에는 아무 곳에도 연결하지 않는다.
 */
export interface McpPresetDef {
  preset: McpPreset;
  name: string;
  url: string;
  /** 토큰 칸 밑의 도움말 번역 키. */
  tokenHintKey: string;
}

export const MCP_PRESETS: readonly McpPresetDef[] = [
  { preset: 'rapid', name: 'RAPID', url: 'https://rapid.kbiofoundry.kr/mcp', tokenHintKey: 'mcpClient.tokenHint.kbf' },
  { preset: 'biomodel', name: 'BioModel Portal', url: 'https://biomodel.kbiofoundry.kr/mcp', tokenHintKey: 'mcpClient.tokenHint.kbf' },
];
