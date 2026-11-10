/**
 * MCP 클라이언트(외부 MCP 서버)의 타입. 모양은 Rust `net::mcp_client` 의 직렬화 값과 같다(spec §4.5, §5.1).
 * 토큰은 여기 어디에도 없다: 자격 증명 관리자에만 있고 웹뷰는 `{ set, epoch }` 만 안다.
 */

/** 프리셋 서버. */
export type McpPreset = 'rapid' | 'biomodel';

/** 인증 방식: Bearer 토큰(자격 증명 관리자) 또는 없음. */
export type McpAuth = 'bearer' | 'none';

/** 보관함 설정 `mcpClientServers` 의 한 항목. `fromStored` 가 모든 칸을 검사한다. */
export interface McpServerSetting {
  /** 8자리 소문자 16진수. 무작위로 만들고 다시 쓰지 않는다. */
  id: string;
  /** 1-40자, 제어 문자 없음. */
  name: string;
  /** https(또는 허락한 http, loopback), 경로 가능, 사용자 정보·쿼리·조각 없음, 비밀처럼 보이는 경로 없음. */
  url: string;
  auth: McpAuth;
  preset?: McpPreset;
  /** AI 에이전트가 이 서버를 쓸지. */
  enabled: boolean;
  /** 도구 이름 → 켬/끔. 없는 도구는 기본값(spec §7.1). */
  tools: Record<string, boolean>;
}

/** 서버가 알려 준 도구 하나. 글은 서버가 보낸 것이라 믿을 수 없다(평문으로만 보인다). */
export interface McpToolInfo {
  name: string;
  title?: string;
  description: string;
  readOnly: boolean;
  destructive: boolean;
  openWorld: boolean;
  inputSchema: object | null;
  /** 스키마가 너무 크거나 쓸 수 없는 모양이다: 이 도구는 쓸 수 없다. */
  tooLarge: boolean;
}

/** `mcp_client_connect` 의 답, 그리고 캐시된 도구 목록. `instructions` 글은 오지 않는다(있다는 표시만). */
export interface McpServerInfo {
  name: string;
  title?: string;
  version: string;
  protocolVersion: string;
  hasInstructions: boolean;
  tools: McpToolInfo[];
  truncated: boolean;
}

/** `mcp_client_call` 의 답. `isError` 는 도구가 실패를 알린 것이지 오류 종류가 아니다. */
export interface McpCallResult {
  text: string;
  isError: boolean;
  truncated: boolean;
  /** 빼 버린 글이 아닌 내용(그림 등)의 수. */
  omitted: number;
}

/** 토큰 상태: 저장됐는지와 바뀐 횟수. 값은 없다. */
export interface McpSecretFlag {
  set: boolean;
  epoch: number;
}
