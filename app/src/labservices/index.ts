/**
 * 도우미의 읽기 전용 실험실 도구를 줄지 정하고 만든다(design §7).
 *
 * - partbank 도구: 기본 연결(`partbankDefaultConnection`)의 주소가 있고 그 연결의 키가 저장되어 있을 때만. 키 상태를 읽지
 *   못하면(`unknown`) 주지 않는다.
 * - Workflow 도구: 서버 모드는 주소와 `bfwServer` 키, 데스크톱 모드는 `bfwDesktop` 키가 있을 때만(앱이 꺼져 있으면 부를 때
 *   `notConfigured` 로 알린다).
 * - 곁 지도의 `kind` 는 `'lab'`, `readOnly: true`: 결과가 닿으면 실행이 오염되고, 결과는 `kind:'lab'` 울타리에 싸인다.
 *   검색어는 사용자가 설정한 실험실 서버에만 가므로 오염된 뒤에도 묻지 않는다(웹 검색의 `webAfterTaint` 와 다르다).
 */
import type { ToolDef } from '@labnoteo/core';
import type { ExternalToolMeta } from '../ai/externalTools';
import { t } from '../i18n/t';
import { secretStatus, type InvokeFn, type SecretStatus } from '../integrations/netIpc';
import { isOriginUrl } from '../labnote/settings';
import type { AppSettings } from '../labnote/settings';
import type { Source } from '../assistant/sources';
import { newRunState } from './common';
import type { LabIpc } from './ipc';
import { linkOrigin } from './links';
import { partbankTools, PARTBANK_TOOL_NAMES } from './partbankTools';
import { workflowTools, WORKFLOW_TOOL_NAMES } from './workflowTools';

export { labIpcFor, partbankRead, type LabIpc } from './ipc';
export { PARTBANK_TOOL_NAMES } from './partbankTools';
export { WORKFLOW_TOOL_NAMES } from './workflowTools';

export type LabToolName = (typeof PARTBANK_TOOL_NAMES)[number] | (typeof WORKFLOW_TOOL_NAMES)[number];

/** 시스템 프롬프트 문단의 조각(design §7). 준 도구의 서비스 것만 넣는다(`labToolRules`). */
export const LAB_TOOL_RULES = {
  partbank:
    "partbank_* tools read the lab's partbank: where mine = the user's workspace, group = a shared group, public = the public registry. " +
    "For every partbank item in your answer, say whose it is from its scope: mine, group (with the group's name) or public.",
  workflow:
    "workflow_* tools read the lab's Workflow server: the user's designs and their saved protocol notes, and " +
    "(workflow_get_method) summaries mined from published papers, which are not the lab's own protocol. They only add to " +
    "the catalog description from search_catalog: label what you take from workflow_get_method as '논문 요약' (in English " +
    "replies 'Paper summary').",
  partbankOnly: 'These tools only read; you cannot create or change anything in partbank.',
  workflowOnly: 'These tools only read; you cannot create or change anything on the Workflow server.',
  both: 'These tools only read; you cannot create or change anything in partbank or on the Workflow server.',
  cite: 'Cite items with their KID or code and link.',
} as const;

/** 이번 실행의 실험실 도구에 맞춘 시스템 프롬프트 문단. 실험실 도구가 없으면 빈 글. */
export function labToolRules(toolNames: readonly string[]): string {
  const pb = toolNames.some((n) => (PARTBANK_TOOL_NAMES as readonly string[]).includes(n));
  const wf = toolNames.some((n) => (WORKFLOW_TOOL_NAMES as readonly string[]).includes(n));
  if (!pb && !wf) return '';
  const r = LAB_TOOL_RULES;
  return [pb ? r.partbank : '', wf ? r.workflow : '', pb && wf ? r.both : pb ? r.partbankOnly : r.workflowOnly, r.cite]
    .filter(Boolean)
    .join(' ');
}

type LabSettings = Pick<AppSettings, 'partbankWebUrl' | 'partbankDesktopUrl' | 'partbankDefaultConnection' | 'bfwUrl' | 'bfwConnection' | 'allowHttpOrigins'>;

export type PartbankSetup = 'configured' | 'notSetUp' | 'unknown';

export interface LabSetup {
  /** partbank 연동 상태(어느 연결이든 키가 있으면 configured). 도구가 없을 때의 문단을 고른다. */
  partbank: PartbankSetup;
  /** 기본 연결이 설정되어 있어 partbank 도구를 준다. */
  partbankTools: boolean;
  /** Workflow 서버 도구를 준다. */
  workflowTools: boolean;
}

/** partbank 연동 상태: 주소가 있고 그 연결의 키가 저장되어 있으면 configured. */
export function partbankSetupOf(s: LabSettings, status: SecretStatus): Exclude<PartbankSetup, 'unknown'> {
  const set =
    (isOriginUrl(s.partbankWebUrl) && status.set.partbankWeb === true) ||
    (isOriginUrl(s.partbankDesktopUrl) && status.set.partbankDesktop === true);
  return set ? 'configured' : 'notSetUp';
}

/** 기본 연결의 주소와 키가 모두 있다. */
export function partbankDefaultReady(s: LabSettings, status: SecretStatus): boolean {
  return s.partbankDefaultConnection === 'desktop'
    ? isOriginUrl(s.partbankDesktopUrl) && status.set.partbankDesktop === true
    : isOriginUrl(s.partbankWebUrl) && status.set.partbankWeb === true;
}

/** Workflow 서버 연동 상태(design §7). */
export function bfwSetupOf(s: LabSettings, status: SecretStatus): boolean {
  return s.bfwConnection === 'desktop' ? status.set.bfwDesktop === true : isOriginUrl(s.bfwUrl) && status.set.bfwServer === true;
}

/** 키 상태를 한 번 읽어 세 가지를 정한다. 읽지 못하면 아무 도구도 주지 않는다. */
export async function labSetup(env: { settings(): LabSettings; invoke?: InvokeFn }): Promise<LabSetup> {
  try {
    const status = await secretStatus(env.invoke);
    const s = env.settings();
    return { partbank: partbankSetupOf(s, status), partbankTools: partbankDefaultReady(s, status), workflowTools: bfwSetupOf(s, status) };
  } catch {
    return { partbank: 'unknown', partbankTools: false, workflowTools: false };
  }
}

/** 상태 줄과 끝 알림에 쓰는 도구 이름(지금 언어). 각 `t` 는 글자로 적는다(번역 목록 검사). */
export function labToolTitle(name: string): string | undefined {
  switch (name) {
    case 'partbank_search_parts':
      return t('tool.name.partbankSearchParts');
    case 'partbank_lookup_part':
      return t('tool.name.partbankLookupPart');
    case 'partbank_list_groups':
      return t('tool.name.partbankListGroups');
    case 'workflow_list_designs':
      return t('tool.name.workflowListDesigns');
    case 'workflow_get_design':
      return t('tool.name.workflowGetDesign');
    case 'workflow_get_protocol_notes':
      return t('tool.name.workflowGetProtocolNotes');
    case 'workflow_get_method':
      return t('tool.name.workflowGetMethod');
    default:
      return undefined;
  }
}

export interface LabToolOpts {
  ipc: LabIpc;
  setup: LabSetup;
  settings: LabSettings;
  /** 출처 장부. */
  cite?: (src: Source) => number;
  /** 설정 문제의 알림(서비스마다 실행에 한 번). */
  notify?: (message: string) => void;
  /** Workflow 디자인 목록 5분 캐시의 보관함 열쇠. */
  vaultKey?: string;
}

/** 이번 실행의 실험실 도구와 곁 지도. 한도와 캐시는 이 묶음 안에 있다: 실행마다 새로 만든다. */
export function labAgentTools(o: LabToolOpts): { tools: ToolDef[]; meta: Map<string, ExternalToolMeta> } {
  const s = o.settings;
  const tools: ToolDef[] = [];
  if (o.setup.partbankTools) {
    const origin = s.partbankDefaultConnection === 'desktop' ? null : linkOrigin(s.partbankWebUrl, s.allowHttpOrigins);
    const state = newRunState('partbank', { ...(o.notify ? { notify: o.notify } : {}) });
    tools.push(...partbankTools({ ipc: o.ipc, origin, state, ...(o.cite ? { cite: o.cite } : {}) }));
  }
  if (o.setup.workflowTools) {
    const desktop = s.bfwConnection === 'desktop';
    const origin = desktop ? null : linkOrigin(s.bfwUrl, s.allowHttpOrigins);
    const state = newRunState('workflow', { desktop, ...(o.notify ? { notify: o.notify } : {}) });
    const cacheKey = `${o.vaultKey ?? ''}|${desktop ? 'desktop' : (origin ?? s.bfwUrl)}`;
    tools.push(...workflowTools({ ipc: o.ipc, origin, state, cacheKey, ...(o.cite ? { cite: o.cite } : {}) }));
  }
  const meta = new Map<string, ExternalToolMeta>(
    tools.map((x) => [x.name, { kind: 'lab', serverName: x.name.startsWith('partbank_') ? 'partbank' : 'Workflow', toolTitle: labToolTitle(x.name) ?? x.name, readOnly: true }])
  );
  return { tools, meta };
}
