import { useEffect, useRef, useState } from 'react';
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { migrateSettings, type LabnoteSettings } from '../../vendor/labnoteo/src/settings';
import { isSecretLookingUrl } from '../integrations/netIpc';
import type { McpServerSetting } from '../integrations/mcpClient/types';

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

/**
 * 앱이 보관함마다 기억하는 설정. 플러그인 설정 가운데 앱이 쓰는 것만 고른다.
 * 비밀 값(llmApiKey, mcpToken, partbank·bfworkflow 키)은 이 Pick 에 없으므로 저장소로 갈 수 없다:
 * 키는 Windows 자격 증명 관리자에만 있고(Rust secret_* 커맨드), 웹뷰는 '설정됨' 여부만 안다.
 * 연동 주소(partbank, LLM, bfworkflow)는 비밀이 아니라 여기 저장하며, Rust 가 요청마다 이 저장본에서 읽는다.
 */
export type AppSettings = Pick<
  LabnoteSettings,
  | 'autoSyncUnitOpToc'
  | 'autoUpdateLastUpdated'
  | 'customSampleTypes'
  | 'globalSampleFolder'
  | 'sampleTracking'
  | 'workflowViewGroupBy'
  | 'catalogNoticeHash'
  | 'partbankDesktopUrl'
  | 'partbankWebUrl'
  | 'partbankDefaultConnection'
  | 'partbankSendUsages'
  | 'llmProvider'
  | 'llmEndpointOllama'
  | 'llmEndpointOpenai'
  | 'llmModel'
  | 'worksheetPaperSize'
  | 'scanMaxImageEdge'
  | 'scanJpegQuality'
  | 'scanEmbedWidth'
  | 'mcpEnabled'
> & {
  schemaVersion: number;
  importedFromPlugin?: boolean;
  /** 앱에만 있는 키: "예전 형식 노트 바꾸기" 제안에서 "이 보관함에서는 다시 묻지 않기"를 골랐다. 기본 false. */
  legacyNotesOfferDismissed: boolean;
  /** 앱에만 있는 키: bfworkflow 서버 주소(origin). 올바르지 않으면 기본값. */
  bfwUrl: string;
  /** 앱에만 있는 키: bfworkflow 를 서버로 쓸지, 이 PC 의 데스크톱 앱으로 쓸지. */
  bfwConnection: 'server' | 'desktop';
  /** 앱에만 있는 키: 암호화 없이(http) 키를 보내도 된다고 사용자가 허락한 origin 들. 기본 []. */
  allowHttpOrigins: string[];
  /** 앱에만 있는 키(SP7 Part C): MCP 서버가 듣는 127.0.0.1 포트. 1024-65535 정수, 아니면 3987. */
  mcpPort: number;
  /** 앱에만 있는 키(UI 재설계): 새 실험의 실험자 칸에 미리 채울 이름. 기본 ''. 설정 → 실험·워크플로. */
  defaultExperimenter: string;
  /**
   * 앱에만 있는 키(UI 재설계 R1, 2026-11-10 사용자 결정): 노트에 붙인 그림을 둘 폴더. 기본 'resources'(다른 첨부와 같은
   * 실험의 resources/). 'images' 는 노트 폴더의 images/(Obsidian·플러그인과 같다). 설정 → 편집기.
   */
  imageFolder: ImageFolder;
  /**
   * 앱에만 있는 키(feat/ai-context): 모델의 컨텍스트 창(토큰). 문맥 예산을 정하고, Ollama 에는 `options.num_ctx` 로 간다.
   * 2048-1,000,000 정수(벗어나면 잘라 맞춘다), 정수가 아니면 기본 8192.
   */
  llmContextWindow: number;
  /**
   * 앱에만 있는 키(real-server check, 2026-11-11): 모델에 보낼 temperature. null(빈칸)이면 지금처럼 각 요청이 정한 값을 보낸다.
   * 0-2 의 유한한 수만 살린다. qwen3 같은 생각하는 모델은 0.2 에서 같은 생각을 되풀이할 수 있어서 보관함마다 바꿀 수 있다.
   */
  llmTemperature: number | null;
  /**
   * 앱에만 있는 키(2026-11-11): 생각 모드. 'auto'(기본) 는 qwen3 계열의 도구 차례에서 생각을 끄고, 'on'/'off' 는 언제나 그렇게
   * 보낸다(`thinkingFor`). 다른 값은 'auto'.
   */
  llmThinking: ThinkingSetting;
  /**
   * 앱에만 있는 키(real-server check, 2026-11-11): 요청마다 보낼 출력 토큰 한도. null(빈칸)이면 작업마다 정한 값(도구 차례 4096,
   * 글 8192, 기록 요약 2048, llmProvider outputTokens)이고, 수를 넣으면 모든 요청이 그 값이다. 어느 쪽이든 컨텍스트 창에서
   * 프롬프트를 뺀 만큼을 넘지 않는다. `OUTPUT_TOKENS_SETTING_MIN`-`LLM_CONTEXT_WINDOW_MAX` 정수만 살린다.
   */
  llmMaxOutputTokens: number | null;
  /**
   * 앱에만 있는 키(MCP 클라이언트, spec §5.1): AI 가 쓸 외부 MCP 서버. 기본 []. 토큰은 여기 없다(자격 증명 관리자).
   * 틀린 항목은 버린다(`cleanMcpServers`, Rust `config::parse_mcp_servers` 와 같은 규칙).
   */
  mcpClientServers: McpServerSetting[];
  /**
   * 앱에만 있는 키(문헌 검색, spec §8.4): AI 가 찾아볼 수 있는 공개 문헌 서비스. 기본 모두 켬(저장된 값이 꼭 false 일 때만 끈다,
   * Rust `config::ScholarSources` 와 같은 규칙).
   */
  scholarSources: ScholarSources;
  /** 앱에만 있는 키(문헌 검색): NCBI 에 연락처로 보낼 이메일. 기본 ''(보내지 않음). 이메일 모양이 아니면 ''. */
  ncbiEmail: string;
  /** 앱에만 있는 키(문헌 검색): Crossref 에 `mailto` 로 보낼 이메일. 기본 ''(보내지 않음). 이메일 모양이 아니면 ''. */
  crossrefMailto: string;
  /**
   * 앱에만 있는 키(GitHub 올리기): 올릴 때 GitHub 첫 화면용 README 를 만들어 함께 올린다(보관함에는 쓰지 않는다).
   * 기본 켬. 저장된 값이 꼭 false 일 때만 끈다. Rust `ServiceConfig::github_readme_overlay` 도 같은 규칙이다.
   */
  githubReadmeOverlay?: boolean;
  /**
   * 앱에만 있는 키(2026-11-11 사용자 결정): AI 초안 위에 `> [!note] AI 초안 (모델, 날짜) — 검토 후 이 줄을 지우세요` 줄을
   * 함께 넣어 노트에 출처를 남긴다. 기본 끔: 초안은 보통 내용으로 들어가고 편집기에서만 잠깐 표시된다(editor/live/aiDraftReview.ts).
   * 저장된 값이 꼭 true 일 때만 켠다. 설정 → 편집기.
   */
  aiDraftNoteInFile: boolean;
};

/** 문헌 검색 출처별 켬/끔. */
export interface ScholarSources {
  pubmed: boolean;
  europepmc: boolean;
  crossref: boolean;
  biorxiv: boolean;
}

/** 출처 스위치: 저장된 값이 꼭 false 인 것만 끄고 나머지는 켠다. */
export function cleanScholarSources(v: unknown): ScholarSources {
  const o = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  return {
    pubmed: o.pubmed !== false,
    europepmc: o.europepmc !== false,
    crossref: o.crossref !== false,
    biorxiv: o.biorxiv !== false,
  };
}

/** 연락처 이메일의 최대 길이(글자, Rust `MAX_EMAIL`). */
export const CONTACT_EMAIL_MAX = 254;

/**
 * 연락처 이메일 모양(Rust `config::is_contact_email` 과 같은 규칙): 254자 이하, `@` 하나 앞뒤에 글자, 도메인 안에 `.`
 * (양 끝이 아니고 `..` 없음), 빈칸·제어 문자·따옴표·괄호 없음.
 */
export function isContactEmail(v: unknown): v is string {
  if (typeof v !== 'string' || v === '' || [...v].length > CONTACT_EMAIL_MAX) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f-\u009f"<>(),;\\]/u.test(v)) return false;
  const at = v.indexOf('@');
  if (at <= 0) return false;
  const domain = v.slice(at + 1);
  return !domain.includes('@') && domain.includes('.') && !domain.startsWith('.') && !domain.endsWith('.') && !domain.includes('..');
}

/** 저장된 연락처 이메일: 다듬어서 이메일 모양이면 그대로, 아니면 ''. */
export function cleanContactEmail(v: unknown): string {
  if (typeof v !== 'string') return '';
  const t = v.trim();
  return isContactEmail(t) ? t : '';
}

/** 그림 저장 폴더: 실험의 resources/(기본) 또는 노트 폴더의 images/. */
export type ImageFolder = 'images' | 'resources';

/** 실험자 이름의 최대 길이(글자). 넘는 것은 자른다. */
export const EXPERIMENTER_MAX = 120;

/** 실험자 이름: 제어 문자(줄 바꿈, 탭, NUL)는 빈칸으로, 앞뒤 빈칸은 지우고, EXPERIMENTER_MAX 에서 자른다. 글이 아니면 ''. */
export function cleanExperimenter(v: unknown): string {
  if (typeof v !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, EXPERIMENTER_MAX).trim();
}

/** 컨텍스트 창의 기본값과 범위(토큰). */
export const LLM_CONTEXT_WINDOW_DEFAULT = 8192;
export const LLM_CONTEXT_WINDOW_MIN = 2048;
export const LLM_CONTEXT_WINDOW_MAX = 1_000_000;

/** 컨텍스트 창 값: 유한한 정수면 범위로 잘라 맞추고, 아니면 기본값. */
export function clampContextWindow(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v)) return LLM_CONTEXT_WINDOW_DEFAULT;
  return Math.min(LLM_CONTEXT_WINDOW_MAX, Math.max(LLM_CONTEXT_WINDOW_MIN, v));
}

/**
 * 서버가 알려 준 컨텍스트 한도(토큰)에 맞춘 컨텍스트 창. 손대지 않은 기본값(8192)이면 한도를 쓰고, 한도보다 크면 한도로 줄이고,
 * 그 밖의 값(사용자가 고른 값)은 그대로 둔다. 결과는 언제나 `clampContextWindow` 범위 안이다.
 */
export function suggestContextWindow(current: number, limit: number): number {
  if (!Number.isInteger(limit) || limit <= 0) return current;
  const cap = clampContextWindow(limit);
  return current === LLM_CONTEXT_WINDOW_DEFAULT || current > cap ? cap : current;
}

/** temperature 설정의 범위. */
export const LLM_TEMPERATURE_MAX = 2;

/** 저장된 temperature: 0-2 의 유한한 수면 그대로, 아니면 null(빈칸, 요청이 정한 값). */
export function cleanTemperature(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= LLM_TEMPERATURE_MAX ? v : null;
}

/**
 * 설정 칸에 친 temperature: 빈칸은 null(요청이 정한 값), 0-2 의 십진수(쉼표 소수점도 받는다)는 그 수, 나머지는 'invalid'.
 */
export function parseTemperatureInput(raw: string): number | null | 'invalid' {
  const s = raw.trim().replace(',', '.');
  if (s === '') return null;
  if (!/^\d+(?:\.\d+)?$|^\.\d+$/.test(s)) return 'invalid';
  return cleanTemperature(Number(s)) ?? 'invalid';
}

/** 출력 토큰 한도 설정의 가장 작은 값. */
export const OUTPUT_TOKENS_SETTING_MIN = 256;

/** 저장된 출력 토큰 한도: 범위 안의 정수면 그대로, 아니면 null(빈칸, 작업마다 정한 값). */
export function cleanMaxOutputTokens(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= OUTPUT_TOKENS_SETTING_MIN && v <= LLM_CONTEXT_WINDOW_MAX ? v : null;
}

/** 설정 칸에 친 출력 토큰 한도: 빈칸은 null, 범위 안의 정수(천 단위 쉼표·빈칸은 무시)는 그 수, 나머지는 'invalid'. */
export function parseMaxOutputTokensInput(raw: string): number | null | 'invalid' {
  const s = raw.trim().replace(/[,\s_]/g, '');
  if (s === '') return null;
  if (!/^\d+$/.test(s)) return 'invalid';
  return cleanMaxOutputTokens(Number(s)) ?? 'invalid';
}

/** 생각 모드 설정: 자동(모델에 맞춰), 켬, 끔. */
export type ThinkingSetting = 'auto' | 'on' | 'off';
/** 한 요청에 보내는 생각 모드. */
export type ThinkingMode = 'on' | 'off';

/** 저장된 생각 모드: 'on' 이나 'off' 면 그대로, 아니면 'auto'. */
export function cleanThinking(v: unknown): ThinkingSetting {
  return v === 'on' || v === 'off' ? v : 'auto';
}

/**
 * 자동일 때 글만 쓰는 요청에서 생각을 켜는 가장 작은 컨텍스트 창(토큰). Qwen3.6 모델 카드는 생각하는 능력을 지키려면 128K 이상을
 * 권한다: 그보다 작은 창에서는 긴 생각이 창을 다 쓰고 답이 잘린다.
 */
export const THINKING_CONTEXT_MIN = 131_072;

/**
 * 한 요청의 생각 모드(2026-11-11, 사용자 보고 "AI 모델이 같은 생각을 되풀이해서 멈췄습니다"). 'on'/'off' 설정은 어느 모델에나
 * 그대로 보낸다. 자동은 권장값이 알려진 모델(qwen3 계열)만: 도구를 쓰는 차례는 끔(vLLM 은 생각 글 안의 도구 호출을 읽지 않아서
 * 생각만 이어 가다 도구를 부르지 못했다), 글만 쓰는 차례는 창이 `THINKING_CONTEXT_MIN` 이상일 때만 켬. 그 밖의 모델은 undefined
 * (아무것도 보내지 않는다, 지금과 같다).
 */
export function thinkingFor(
  s: Pick<AppSettings, 'llmThinking' | 'llmModel' | 'llmContextWindow'>,
  tools: boolean
): ThinkingMode | undefined {
  if (s.llmThinking === 'on' || s.llmThinking === 'off') return s.llmThinking;
  if (!recommendedSampling(s.llmModel)) return undefined;
  if (tools) return 'off';
  return (s.llmContextWindow ?? 0) >= THINKING_CONTEXT_MIN ? 'on' : 'off';
}

/** 모델이 권하는 샘플링 값과 그 모델 계열 이름. */
export interface RecommendedSampling {
  family: string;
  temperature: number;
  topP: number;
  topK: number;
  minP: number;
  presencePenalty: number;
}

/**
 * temperature 칸이 빈칸일 때 쓸 모델 권장 샘플링(qwen3 계열, qwen3.5/3.6 이름 포함). Qwen3.6-35B-A3B 모델 카드:
 * 생각 끔은 temperature 0.7, top_p 0.8, top_k 20, min_p 0, presence_penalty 1.5. 생각 켬은 Qwen3 카드의 0.6, top_p 0.95,
 * top_k 20, min_p 0 에 되풀이를 줄이는 presence_penalty 1.5(3.6 카드의 일반 생각 모드 값). 모드를 주지 않으면 끔의 값.
 * 그 밖의 모델은 null(지금처럼 요청이 정한 값).
 */
export function recommendedSampling(model: string | null | undefined, mode: ThinkingMode = 'off'): RecommendedSampling | null {
  if (!model || !/qwen3/i.test(model)) return null;
  return mode === 'on'
    ? { family: 'qwen3', temperature: 0.6, topP: 0.95, topK: 20, minP: 0, presencePenalty: 1.5 }
    : { family: 'qwen3', temperature: 0.7, topP: 0.8, topK: 20, minP: 0, presencePenalty: 1.5 };
}

/** MCP 서버의 기본 포트(플러그인과 같다). */
export const MCP_DEFAULT_PORT = 3987;

/** MCP 서버가 쓸 수 있는 포트: 1024-65535 정수(Rust `check_port` 와 같은 범위). */
export function isMcpPort(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1024 && v <= 65535;
}

/** bfworkflow 서버의 기본 주소. */
export const BFW_DEFAULT_URL = 'https://workflow.kbiofoundry.kr';

/**
 * 연동 주소로 쓸 수 있는 URL: http(s), 호스트가 있고, 사용자 정보·쿼리·조각이 없다.
 * Rust `net::config::parse_service_url` 과 같은 규칙이다(두 쪽 테스트가 같은 값을 고정한다).
 */
export function isServiceUrl(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const raw = v.trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (!url.hostname) return false;
  if (url.username || url.password) return false;
  // URL 은 빈 '?' 와 '#' 를 search/hash 에서 지우므로 원문으로도 본다.
  if (url.search || url.hash || raw.includes('?') || raw.includes('#')) return false;
  return true;
}

/** `isServiceUrl` 이면서 경로가 비었거나 `/` 뿐이다(Rust `parse_origin_url`). partbank 와 bfworkflow 주소. */
export function isOriginUrl(v: unknown): v is string {
  if (!isServiceUrl(v)) return false;
  const path = new URL(v.trim()).pathname;
  return path === '' || path === '/';
}

/** `http://` origin 만 남긴다(중복 없이). 다른 값은 버린다. */
function httpOrigins(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const e of v) {
    if (isOriginUrl(e) && new URL(e.trim()).protocol === 'http:') {
      const o = e.trim();
      if (!out.includes(o)) out.push(o);
    }
  }
  return out;
}

/** MCP 클라이언트 서버의 최대 수와 이름 길이(Rust `MAX_MCP_SERVERS`, `MAX_MCP_NAME`). */
export const MCP_CLIENT_MAX_SERVERS = 16;
export const MCP_CLIENT_MAX_NAME = 40;

/** loopback 호스트(Rust `config::is_loopback`): localhost, 127.0.0.0/8, ::1. */
function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h === '[::1]') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/**
 * MCP 서버 주소로 쓸 수 있다: `isServiceUrl`(경로 가능), 비밀처럼 보이는 경로 없음, 평문 http 는 loopback 이거나
 * `allowHttp` 에 있는 origin 일 때만(Rust `config::parse_mcp_url`).
 */
export function isMcpServerUrl(v: unknown, allowHttp: readonly string[]): v is string {
  if (!isServiceUrl(v) || isSecretLookingUrl(v)) return false;
  const url = new URL(v.trim());
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    return allowHttp.some((o) => {
      try {
        return new URL(o).origin === url.origin;
      } catch {
        return false;
      }
    });
  }
  return true;
}

/** 서버 이름: 1-40자(코드 포인트), 빈칸만은 안 되고, 제어 문자(C0, DEL, C1)가 없다. */
export function isMcpName(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const n = [...v].length;
  // eslint-disable-next-line no-control-regex
  return n >= 1 && n <= MCP_CLIENT_MAX_NAME && v.trim() !== '' && !/[\u0000-\u001f\u007f-\u009f]/.test(v);
}

/** 저장된 항목 하나. 칸 하나라도 틀리면 undefined. 도구 스위치는 불 값만 남긴다. */
function cleanMcpServer(v: unknown, allowHttp: readonly string[]): McpServerSetting | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== 'string' || !/^[0-9a-f]{8}$/.test(o.id)) return undefined;
  if (!isMcpName(o.name)) return undefined;
  if (!isMcpServerUrl(o.url, allowHttp)) return undefined;
  if (o.auth !== 'bearer' && o.auth !== 'none') return undefined;
  if (o.preset !== undefined && o.preset !== null && o.preset !== 'rapid' && o.preset !== 'biomodel') return undefined;
  if (o.enabled !== undefined && typeof o.enabled !== 'boolean') return undefined;
  if (o.tools !== undefined && (!o.tools || typeof o.tools !== 'object' || Array.isArray(o.tools))) return undefined;
  const tools: Record<string, boolean> = {};
  for (const [k, b] of Object.entries((o.tools ?? {}) as Record<string, unknown>)) if (typeof b === 'boolean') tools[k] = b;
  const out: McpServerSetting = { id: o.id, name: o.name, url: o.url.trim(), auth: o.auth, enabled: o.enabled === true, tools };
  if (o.preset === 'rapid' || o.preset === 'biomodel') out.preset = o.preset;
  return out;
}

/** `mcpClientServers`: 올바른 항목만 차례대로, 같은 id 는 처음 것만, 많아야 16개. */
export function cleanMcpServers(v: unknown, allowHttp: readonly string[]): McpServerSetting[] {
  if (!Array.isArray(v)) return [];
  const out: McpServerSetting[] = [];
  for (const e of v) {
    if (out.length >= MCP_CLIENT_MAX_SERVERS) break;
    const s = cleanMcpServer(e, allowHttp);
    if (s && !out.some((o) => o.id === s.id)) out.push(s);
  }
  return out;
}

/** 고르는 키. 저장하기 전에도 이 목록으로 다시 걸러, 타입을 우회해 섞여 든 키도 저장되지 않게 한다. */
const KEYS = [
  'schemaVersion',
  'autoSyncUnitOpToc',
  'autoUpdateLastUpdated',
  'customSampleTypes',
  'globalSampleFolder',
  'sampleTracking',
  'workflowViewGroupBy',
  'catalogNoticeHash',
  'legacyNotesOfferDismissed',
  'partbankDesktopUrl',
  'partbankWebUrl',
  'partbankDefaultConnection',
  'partbankSendUsages',
  'llmProvider',
  'llmEndpointOllama',
  'llmEndpointOpenai',
  'llmModel',
  'bfwUrl',
  'bfwConnection',
  'allowHttpOrigins',
  // SP7 Part A: 실험 워크시트 용지(a4 | letter). 플러그인 migrateSettings 가 기본값과 검사를 맡는다.
  'worksheetPaperSize',
  // SP7 Part B: 스캔 이미지 긴 변(px), JPEG 품질, 노트에 보이는 폭(0 = 원래 크기).
  // 플러그인 migrateSettings 가 기본값과 범위를 맡는다: 범위 밖 값은 버리고 기본값을 둔다(B7).
  'scanMaxImageEdge',
  'scanJpegQuality',
  'scanEmbedWidth',
  // SP7 Part C: MCP 서버. mcpEnabled 는 플러그인 키지만 가져올 때는 늘 끈다(C6). mcpPort 는 앱 키.
  'mcpEnabled',
  'mcpPort',
  // UI 재설계(Task 8): 기본 실험자와 그림 저장 폴더. 앱 키다.
  'defaultExperimenter',
  'imageFolder',
  // feat/ai-context(Task 8): 모델의 컨텍스트 창. 앱 키다.
  'llmContextWindow',
  // 모델 temperature(2026-11-11). 앱 키다. null 이면 요청이 정한 값.
  'llmTemperature',
  // 생각 모드(2026-11-11). 앱 키다.
  'llmThinking',
  // 출력 토큰 한도(2026-11-11). 앱 키다. null 이면 작업마다 정한 값.
  'llmMaxOutputTokens',
  // MCP 클라이언트(Task 5b): 외부 MCP 서버. 앱 키다.
  'mcpClientServers',
  // 문헌 검색(Task 11): 출처 스위치와 연락처 이메일. 앱 키다.
  'scholarSources',
  'ncbiEmail',
  'crossrefMailto',
  // feat/github-upload(Task 1): GitHub 첫 화면용 README. 앱 키다. clientId·forgetOnExit 는 앱 전체 설정이라 Rust 에만 있다.
  'githubReadmeOverlay',
  // AI 초안 표시를 노트에 남기기(2026-11-11). 앱 키다.
  'aiDraftNoteInFile',
] as const satisfies ReadonlyArray<keyof AppSettings>;

/** 플러그인에 없는 앱 키의 기본값. */
const APP_DEFAULTS = {
  legacyNotesOfferDismissed: false,
  bfwUrl: BFW_DEFAULT_URL,
  bfwConnection: 'server',
  mcpPort: MCP_DEFAULT_PORT,
  defaultExperimenter: '',
  imageFolder: 'resources',
  llmContextWindow: LLM_CONTEXT_WINDOW_DEFAULT,
  llmTemperature: null,
  llmThinking: 'auto',
  llmMaxOutputTokens: null,
  ncbiEmail: '',
  crossrefMailto: '',
  githubReadmeOverlay: true,
  aiDraftNoteInFile: false,
} as const;

function pick(s: LabnoteSettings): AppSettings {
  const out = {} as Record<string, unknown>;
  for (const k of KEYS) out[k] = k in APP_DEFAULTS ? APP_DEFAULTS[k as keyof typeof APP_DEFAULTS] : s[k as keyof LabnoteSettings];
  // 배열 기본값은 부를 때마다 새로 만든다(설정끼리 같은 배열을 나눠 쓰지 않게).
  out.allowHttpOrigins = [];
  out.mcpClientServers = [];
  out.scholarSources = cleanScholarSources(undefined);
  return out as AppSettings;
}

/**
 * 플러그인의 data.json(또는 아무 값)을 플러그인의 `migrateSettings` 로 고친 뒤 앱 키만 고른다.
 * 그 뒤 앱이 다르게 정한 것: `partbankSendUsages` 는 값이 꼭 true 일 때만 켠다(플러그인 기본은 true, D12).
 * bfworkflow 키와 `allowHttpOrigins` 는 플러그인 이주가 모르므로 여기서 직접 읽고 검사한다.
 */
export function fromPluginData(raw: unknown): AppSettings {
  const settings = pick(migrateSettings(raw));
  const data = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  settings.partbankSendUsages = data.partbankSendUsages === true;
  if (isOriginUrl(data.bfwUrl)) settings.bfwUrl = data.bfwUrl.trim();
  if (data.bfwConnection === 'server' || data.bfwConnection === 'desktop') settings.bfwConnection = data.bfwConnection;
  settings.allowHttpOrigins = httpOrigins(data.allowHttpOrigins);
  // 가져오기는 리스너를 열지 않는다(C6): 플러그인에서 켜 두었어도 앱에서는 꺼진 채로 시작한다.
  settings.mcpEnabled = false;
  return settings;
}

/** 저장해 둔 설정: 같은 이주를 거치고, 가져온 적이 있다는 표시만 따로 지킨다. */
export function fromStored(raw: unknown): AppSettings {
  const settings = fromPluginData(raw);
  if (raw && typeof raw === 'object' && (raw as { importedFromPlugin?: unknown }).importedFromPlugin === true) {
    settings.importedFromPlugin = true;
  }
  // 앱 키는 migrateSettings 가 모른다: 저장된 값이 참일 때만 살린다.
  if (raw && typeof raw === 'object' && (raw as { legacyNotesOfferDismissed?: unknown }).legacyNotesOfferDismissed === true) {
    settings.legacyNotesOfferDismissed = true;
  }
  // MCP(C6): 앱이 저장한 값이 꼭 true 일 때만 켜고, 범위 안의 정수 포트만 살린다.
  if (raw && typeof raw === 'object' && (raw as { mcpEnabled?: unknown }).mcpEnabled === true) settings.mcpEnabled = true;
  const port = raw && typeof raw === 'object' ? (raw as { mcpPort?: unknown }).mcpPort : undefined;
  if (isMcpPort(port)) settings.mcpPort = port;
  // UI 재설계(Task 8): 실험자는 다듬어 살리고, 그림 폴더는 아는 값만 살린다.
  if (raw && typeof raw === 'object') {
    const o = raw as { defaultExperimenter?: unknown; imageFolder?: unknown };
    settings.defaultExperimenter = cleanExperimenter(o.defaultExperimenter);
    if (o.imageFolder === 'images' || o.imageFolder === 'resources') settings.imageFolder = o.imageFolder;
    // feat/ai-context(Task 8): 컨텍스트 창은 정수만 살리고 범위로 잘라 맞춘다.
    settings.llmContextWindow = clampContextWindow((raw as { llmContextWindow?: unknown }).llmContextWindow);
    // temperature(2026-11-11): 0-2 의 수만 살리고, 아니면 빈칸(null).
    settings.llmTemperature = cleanTemperature((raw as { llmTemperature?: unknown }).llmTemperature);
    settings.llmThinking = cleanThinking((raw as { llmThinking?: unknown }).llmThinking);
    settings.llmMaxOutputTokens = cleanMaxOutputTokens((raw as { llmMaxOutputTokens?: unknown }).llmMaxOutputTokens);
    // MCP 클라이언트(Task 5b): 칸마다 검사하고 틀린 항목은 버린다. 평문 http 허락은 위에서 읽은 목록을 쓴다.
    settings.mcpClientServers = cleanMcpServers((raw as { mcpClientServers?: unknown }).mcpClientServers, settings.allowHttpOrigins);
    // 문헌 검색(Task 11): 출처는 꼭 false 인 것만 끄고, 이메일은 모양이 맞을 때만 살린다.
    const lit = raw as { scholarSources?: unknown; ncbiEmail?: unknown; crossrefMailto?: unknown };
    settings.scholarSources = cleanScholarSources(lit.scholarSources);
    settings.ncbiEmail = cleanContactEmail(lit.ncbiEmail);
    settings.crossrefMailto = cleanContactEmail(lit.crossrefMailto);
    // feat/github-upload(Task 1): 저장된 값이 꼭 false 일 때만 끈다.
    if ((raw as { githubReadmeOverlay?: unknown }).githubReadmeOverlay === false) settings.githubReadmeOverlay = false;
    // AI 초안 표시(2026-11-11): 저장된 값이 꼭 true 일 때만 켠다.
    if ((raw as { aiDraftNoteInFile?: unknown }).aiDraftNoteInFile === true) settings.aiDraftNoteInFile = true;
  }
  return settings;
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** 지금 열린 보관함의 설정을 저장한다(앱 설정 폴더, 보관함 밖). 앱 키만 쓴다. */
export async function saveVaultSettings(s: AppSettings, invoke: InvokeFn = tauriInvoke): Promise<void> {
  const clean: Record<string, unknown> = {};
  for (const k of KEYS) clean[k] = s[k];
  if (s.importedFromPlugin === true) clean.importedFromPlugin = true;
  await invoke<void>('settings_vault_write', { content: JSON.stringify(clean) });
}

/**
 * 지금 열린 보관함의 설정을 읽는다. 저장된 것이 있으면 그것, 없으면 Obsidian 플러그인의
 * data.json 을 한 번 가져와 저장한다(`imported: true`), 그것도 없으면 기본값을 저장한다.
 * 던지지 않는다: 읽거나 쓰지 못하면 기본값으로 계속한다.
 */
export async function loadVaultSettings(
  invoke: InvokeFn = tauriInvoke,
): Promise<{ settings: AppSettings; imported: boolean; foundLlmKey: boolean }> {
  let stored: string | null = null;
  try {
    stored = await invoke<string | null>('settings_vault_read', {});
  } catch {
    return { settings: fromPluginData(undefined), imported: false, foundLlmKey: false };
  }
  // 손상된 저장 파일은 Rust 가 없는 것으로 돌려준다. 여기서 읽지 못한 값은 기본값이 된다.
  if (stored != null) return { settings: fromStored(parse(stored)), imported: false, foundLlmKey: false };

  let plugin: string | null = null;
  try {
    plugin = await invoke<string | null>('settings_import_plugin', {});
  } catch {
    plugin = null;
  }
  const raw = plugin != null ? parse(plugin) : undefined;
  const imported = raw !== undefined && raw !== null && typeof raw === 'object' && !Array.isArray(raw);
  const settings = imported ? { ...fromPluginData(raw), importedFromPlugin: true } : fromPluginData(undefined);
  try {
    await saveVaultSettings(settings, invoke);
  } catch {
    // 저장하지 못해도 이번 실행은 이 값으로 쓴다. 다음에 다시 가져온다.
  }
  // Rust 는 가져온 설정에서 키를 지워 돌려준다(D9). LLM 키가 있었는지만 따로 묻는다(값은 오지 않는다).
  let foundLlmKey = false;
  if (imported) {
    try {
      foundLlmKey = (await invoke<boolean>('settings_plugin_llm_key', {})) === true;
    } catch {
      foundLlmKey = false;
    }
  }
  return { settings, imported, foundLlmKey };
}

/**
 * `VaultView` 용: 보관함이 바뀌면 그 보관함의 설정을 읽는다. `imported` 는 이번에 플러그인 설정을
 * 처음 가져왔을 때만 true 다(다음 실행부터는 저장된 설정을 읽으므로 false). `foundLlmKey` 는 그때
 * 플러그인 data.json 에 아직 저장하지 않은 LLM 키가 있었다는 뜻이다(App 이 저장을 제안한다).
 */
export function useVaultSettings(
  vaultRoot: string,
  invoke: InvokeFn = tauriInvoke,
): {
  settings: AppSettings | undefined;
  imported: boolean;
  foundLlmKey: boolean;
  update(patch: Partial<AppSettings>): Promise<boolean>;
} {
  const [settings, setSettings] = useState<AppSettings>();
  const [imported, setImported] = useState(false);
  const [foundLlmKey, setFoundLlmKey] = useState(false);
  const current = useRef<AppSettings>();
  useEffect(() => {
    let live = true;
    current.current = undefined;
    setSettings(undefined);
    setImported(false);
    setFoundLlmKey(false);
    loadVaultSettings(invoke).then((r) => {
      if (!live) return;
      current.current = r.settings;
      setSettings(r.settings);
      setImported(r.imported);
      setFoundLlmKey(r.foundLlmKey);
    });
    return () => {
      live = false;
    };
  }, [vaultRoot]);
  /**
   * 바꾼 값을 곧바로 보이고 저장한다. 저장이 끝나면(실패해도) 풀린다: 연동 설정은 Rust 가 저장본을 읽은 뒤에 고리를 부른다.
   * 디스크에 썼으면 true, 설정을 아직 읽지 못했거나 쓰지 못했으면 false(던지지 않는다: 기다리지 않는 호출이 많다).
   */
  const update = (patch: Partial<AppSettings>): Promise<boolean> => {
    if (!current.current) return Promise.resolve(false);
    const next = { ...current.current, ...patch };
    current.current = next;
    setSettings(next);
    return saveVaultSettings(next, invoke).then(
      () => true,
      () => false,
    );
  };
  return { settings, imported, foundLlmKey, update };
}
