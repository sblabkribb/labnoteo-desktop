/**
 * 실험실 도구 결과의 웹 페이지 링크(design §4). 링크는 저장된 origin 에서 TS 가 만든다(URL API). 웹·서버 연결만 링크를
 * 받는다: 데스크톱 연결(루프백)은 null(노트에 넣어도 쓸모없다). id 는 모양을 확인한 뒤에만 링크에 들어간다.
 * https 만 쓰고, http 는 사용자가 허락한 origin(`allowHttpOrigins`, Rust `allow_http` 와 같은 규칙)일 때만 쓴다.
 */
import { isOriginUrl } from '../labnote/settings';

export type PbType = 'part' | 'device' | 'plasmid' | 'primer' | 'strain' | 'molecule';
export type PbScope = 'mine' | 'group' | 'public';

export const PB_TYPES: readonly PbType[] = ['part', 'device', 'plasmid', 'primer', 'strain', 'molecule'];

/** Mongo object id: 24 hex. */
export const OID = /^[0-9a-fA-F]{24}$/;
/** Workflow 서버의 id(Rust `is_id`). */
export const BFW_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** 카탈로그 Workflow 코드(WD001 …). */
export const WF_CODE = /^W[A-Z]{1,3}[0-9]{2,4}$/;
/** 카탈로그 Unit Operation 코드(UHW100 …). */
export const UO_CODE = /^U[A-Z]{1,3}[0-9]{2,4}$/;

/** 링크에 쓸 origin(끝 `/` 없음). 받을 수 없으면 null. */
export function linkOrigin(url: string | undefined, allowHttpOrigins: readonly string[] = []): string | null {
  if (!isOriginUrl(url)) return null;
  const u = new URL(url.trim());
  if (u.protocol === 'http:' && !allowHttpOrigins.some((o) => o.trim().replace(/\/+$/, '') === u.origin)) return null;
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  return u.origin;
}

/** `origin` + 이미 확인한 조각들. */
function join(origin: string | null, segments: string[]): string | null {
  if (!origin) return null;
  const u = new URL(origin);
  u.pathname = `/${segments.map((s) => encodeURIComponent(s)).join('/')}`;
  return u.href;
}

/** 웹 경로의 type 조각(plasmid 는 device 화면). */
function pbSegment(type: PbType): string {
  return type === 'plasmid' ? 'device' : type;
}

/**
 * partbank 항목 링크. mine: `/workspace/<type>s/{id}`, group: `/groups/{gid}/<type>s/{id}`, public: `/registry/<type>/{id}`,
 * scope 를 모르면 `/<type>s/{id}`. id(그리고 그룹 id)가 24 hex 가 아니면 null.
 */
export function partbankItemLink(origin: string | null, type: PbType, id: string, scope?: PbScope, groupId?: string): string | null {
  if (!OID.test(id)) return null;
  const seg = pbSegment(type);
  switch (scope) {
    case 'mine':
      return join(origin, ['workspace', `${seg}s`, id]);
    case 'group':
      return groupId && OID.test(groupId) ? join(origin, ['groups', groupId, `${seg}s`, id]) : null;
    case 'public':
      return join(origin, ['registry', seg, id]);
    default:
      return join(origin, [`${seg}s`, id]);
  }
}

export function partbankGroupLink(origin: string | null, groupId: string): string | null {
  return OID.test(groupId) ? join(origin, ['groups', groupId]) : null;
}

export function designLink(origin: string | null, serviceId: string): string | null {
  return BFW_ID.test(serviceId) ? join(origin, ['services', serviceId]) : null;
}

export function designWorkflowLink(origin: string | null, serviceId: string, workflowId: string): string | null {
  return BFW_ID.test(serviceId) && BFW_ID.test(workflowId) ? join(origin, ['services', serviceId, 'workflows', workflowId]) : null;
}

export function noteLink(origin: string | null, serviceId: string, workflowId: string, noteId: string): string | null {
  return BFW_ID.test(serviceId) && BFW_ID.test(workflowId) && BFW_ID.test(noteId)
    ? join(origin, ['services', serviceId, 'workflows', workflowId, 'notes', noteId])
    : null;
}

export function methodLink(origin: string | null, workflowCode: string): string | null {
  return BFW_ID.test(workflowCode) ? join(origin, ['workflows', workflowCode]) : null;
}
