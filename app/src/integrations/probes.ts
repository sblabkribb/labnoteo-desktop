import type { AppSettings } from '../labnote/settings';

/**
 * 연동 설정 대화상자의 바깥 고리(D17).
 *
 * - 연결 시험(probe): partbank, AI, bfworkflow 기능이 각자 등록한다(Parts A/B/C). 대화상자는 등록된 시험에만
 *   "연결 시험" 단추를 보이고, 아직 저장하지 않은 칸의 값으로 부른다(D8).
 * - 설정이 바뀐 뒤의 고리(onIntegrationChange): 설정을 먼저 저장한 다음 (앞, 뒤) 값으로 부른다.
 * - 키가 바뀐 알림(onSecretsChange, notifySecretsChange)은 secretsEvents 에 있고 여기서 다시 내보낸다.
 */

export { notifySecretsChange, onSecretsChange } from './secretsEvents';

/** 대화상자가 다루는 설정. 키는 없다: 키는 자격 증명 관리자에만 있다. */
export type IntegrationSettingsValue = Pick<
  AppSettings,
  | 'partbankDesktopUrl'
  | 'partbankWebUrl'
  | 'partbankDefaultConnection'
  | 'partbankSendUsages'
  | 'llmProvider'
  | 'llmEndpointOllama'
  | 'llmEndpointOpenai'
  | 'llmModel'
  | 'bfwUrl'
  | 'bfwConnection'
  | 'allowHttpOrigins'
  // SP7 Part B: the "Barcode & scans" section (Task 29)
  | 'worksheetPaperSize'
  | 'scanMaxImageEdge'
  | 'scanJpegQuality'
  | 'scanEmbedWidth'
  // SP7 Part C: MCP 서버 스위치와 포트(McpSection)
  | 'mcpEnabled'
  | 'mcpPort'
> &
  // feat/ai-context: the context-window field (ContextWindowField). Optional so older values still type-check.
  Partial<Pick<AppSettings, 'llmContextWindow'>> &
  // AI provider > Advanced: the temperature field (TemperatureField). Optional so older values still type-check.
  Partial<Pick<AppSettings, 'llmTemperature'>> &
  // AI provider > Advanced: the thinking-mode field (ThinkingField). Optional so older values still type-check.
  Partial<Pick<AppSettings, 'llmThinking'>> &
  // MCP 클라이언트(Task 5b): 외부 MCP 서버 목록(토큰 없음). 없으면 []로 읽는다(예전 값도 타입이 맞게 선택 칸).
  Partial<Pick<AppSettings, 'mcpClientServers'>> &
  // 문헌 검색(Task 13): 출처 스위치와 연락처 이메일. 선택 칸이라 예전 값도 타입이 맞는다(없으면 기본값으로 읽는다).
  Partial<Pick<AppSettings, 'scholarSources' | 'ncbiEmail' | 'crossrefMailto'>>;

export type ProbeId = 'partbankDesktop' | 'partbankWeb' | 'llm' | 'bfw';

/** 칸의 지금 값으로 연결을 시험한다. `message` 는 이미 번역된 사용자 문장이다. */
export type ProbeFn = (fields: {
  url: string;
  apiKey?: string;
  model?: string;
  provider?: string;
  connection?: string;
}) => Promise<{ ok: boolean; message: string }>;

const probes = new Map<ProbeId, ProbeFn>();

/** 시험을 등록한다. 돌려준 함수는 이 등록이 아직 그 자리에 있을 때만 지운다. */
export function registerProbe(id: ProbeId, fn: ProbeFn): () => void {
  probes.set(id, fn);
  return () => {
    if (probes.get(id) === fn) probes.delete(id);
  };
}

export function probeFor(id: ProbeId): ProbeFn | undefined {
  return probes.get(id);
}

type ChangeHook = (before: IntegrationSettingsValue, after: IntegrationSettingsValue) => void | Promise<void>;

const changeHooks = new Set<ChangeHook>();

/** 연동 설정이 저장된 뒤마다 부른다. 돌려준 함수로 구독을 끝낸다. */
export function onIntegrationChange(fn: ChangeHook): () => void {
  changeHooks.add(fn);
  return () => {
    changeHooks.delete(fn);
  };
}

/** 고리를 차례로 부른다. 한 고리가 던져도 나머지는 부른다. */
export async function runIntegrationChangeHooks(before: IntegrationSettingsValue, after: IntegrationSettingsValue): Promise<void> {
  for (const fn of [...changeHooks]) {
    try {
      await fn(before, after);
    } catch {
      // 한 기능의 실패가 다른 기능의 갱신을 막지 않는다.
    }
  }
}
