/**
 * 생각 고리의 되풀이된 대목(real-server check, 2026-11-11). 생각을 끄고 다시 보내도 고리로 끝난 요청의 오류 말풍선(과 알림)이
 * "반복된 부분 보기"를 보이고, 누르면 이 글이 펼쳐진다: 되풀이된 끝 대목(약 240자)과 그 앞의 짧은 대목. 글 그대로만 보인다.
 *
 * 모델의 생각 글이라 무엇이든 들어 있을 수 있다: 주소(그리고 설정한 AI 서버의 호스트), 호스트:포트, IP, 키처럼 보이는 긴 토큰과
 * `Bearer …` 는 가린다. 제어 글자와 양방향 글자도 지운다.
 */
import { t } from '../i18n/t';
import { ReasoningLoopError } from '../labnote/port/llmError';
import type { AppSettings } from '../labnote/settings';

export interface LoopDetail {
  /** 펼치는 단추의 글('반복된 부분 보기'). */
  label: string;
  /** 펼친 글(가린 뒤, 글 그대로 그린다). */
  text: string;
}

const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)\]]+/gi;
const BEARER_RE = /\bbearer\s+\S+/gi;
const PREFIXED_KEY_RE = /\b(?:sk|pk|rk|hf|xox[abp]|gh[pousr])[-_][A-Za-z0-9_-]{6,}/gi;
const LONG_TOKEN_RE = /[A-Za-z0-9_\-+/=]{32,}/g;
// A host before the port: localhost, an IPv4 address, or a dotted name ending in a label that starts with a letter.
// Times ('10:30'), ratios ('1:100') and 'step:12' are ordinary reasoning text and stay.
const HOST_PORT_RE = /\b(?:localhost|\d{1,3}(?:\.\d{1,3}){3}|(?:[a-z0-9-]+\.)+[a-z][a-z0-9-]*):\d{2,5}\b/gi;
const IP_RE = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;
// eslint-disable-next-line no-control-regex
const UNSAFE_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‎‏‪-‮⁦-⁩]/g;

/** 설정한 AI 서버 주소들의 호스트(소문자). 읽을 수 없는 주소는 건너뛴다. */
function serverHosts(settings: Pick<AppSettings, 'llmEndpointOpenai' | 'llmEndpointOllama'>): string[] {
  const out: string[] = [];
  for (const raw of [settings.llmEndpointOpenai, settings.llmEndpointOllama]) {
    const s = (raw ?? '').trim();
    if (!s) continue;
    try {
      const host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`).hostname.toLowerCase();
      if (host.length >= 3) out.push(host);
    } catch {
      // Not an address: nothing to hide.
    }
  }
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 보여도 되는 글: 주소·서버 호스트·키처럼 보이는 것을 가린다. */
export function redactLoopText(text: string, settings: Pick<AppSettings, 'llmEndpointOpenai' | 'llmEndpointOllama'>): string {
  let out = text
    .replace(UNSAFE_RE, '')
    .replace(URL_RE, '[link]')
    .replace(BEARER_RE, '[hidden]')
    .replace(PREFIXED_KEY_RE, '[hidden]')
    .replace(LONG_TOKEN_RE, '[hidden]')
    .replace(HOST_PORT_RE, '[server]')
    .replace(IP_RE, '[server]');
  for (const host of serverHosts(settings)) out = out.replace(new RegExp(escapeRe(host), 'gi'), '[server]');
  return out;
}

/** 생각 고리 오류면 펼칠 글, 아니면(또는 대목이 없으면) undefined. */
export function loopDetail(err: unknown, settings: Pick<AppSettings, 'llmEndpointOpenai' | 'llmEndpointOllama'>): LoopDetail | undefined {
  if (!(err instanceof ReasoningLoopError) || !err.repeated.trim()) return undefined;
  const parts = [`${t('ai.loopDetail.repeated')}\n${redactLoopText(err.repeated.trim(), settings)}`];
  if (err.before.trim()) parts.push(`${t('ai.loopDetail.before')}\n${redactLoopText(err.before.trim(), settings)}`);
  return { label: t('ai.loopDetail.show'), text: parts.join('\n\n') };
}
