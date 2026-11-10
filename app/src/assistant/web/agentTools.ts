/**
 * 웹 도구를 에이전트의 core `ToolDef` 로(assistant spec §7, plan Task 14): `web_search`(SearXNG, Rust `net/web_search.rs`)와
 * `fetch_page`(Rust `net/fetch_page.rs`).
 *
 * - 둘 다 읽기만 한다(`mutates: false`). 곁 지도의 `kind` 는 `'web'`: 결과가 닿으면 실행이 오염되고(`taintSources` 에
 *   `'web'`), 오염된 뒤의 `web_search` 는 검색어를 보이고 묻는다(`webAfterTaint`, `llmAgent.ts`).
 * - 결과(검색 결과의 제목·주소·요약, 페이지 글)는 모두 `fenceUntrusted({kind:'web'})` 울타리 안에서만 모델에 간다.
 * - 출처: 검색 결과마다, 가져온 페이지마다 장부에 넣고 그 번호(`cite`)를 결과에 붙인다.
 * - `fetch_page` 는 허용 목록(`UrlAllowlist`)에 있는 주소만 연다: 이번 실행의 검색 결과, 문헌 검색 결과의 링크, 사용자가
 *   이 폴더의 대화에 친 주소. 경로와 쿼리는 글자 그대로 같아야 한다(모델이 노트 글을 쿼리로 붙여 내보내지 못하게).
 *   목록에 없으면 IPC 없이 거절한다. Rust 에는 정리한 주소를 보낸다.
 * - 한 실행에 검색 3번, 페이지 5개까지. 검색어는 200자까지(넘으면 IPC 없이 거절).
 * - 오류는 모델에게 짧은 영어로만 준다(Rust·서비스가 보낸 글은 넣지 않는다). 취소는 그대로 던져 실행을 끝낸다.
 * 이 파일은 네트워크를 쓰지 않는다: 부르는 일은 `ipc` 가 한다.
 */
import type { JsonSchema, ToolDef, ToolResult } from '@labnoteo/core';
import type { ExternalToolMeta } from '../../ai/externalTools';
import { fenceUntrusted } from '../../ai/untrusted';
import { t } from '../../i18n/t';
import { toNetError, type NetError } from '../../integrations/netIpc';
import type { Source } from '../sources';
import { MAX_WEB_QUERY, type WebHit, type WebIpc, type WebSearchOpts } from './ipc';

export const WEB_TOOL_NAMES = ['web_search', 'fetch_page'] as const;
/** 한 실행의 검색 수 한도. */
export const WEB_SEARCH_MAX = 3;
/** 한 실행의 페이지 수 한도. */
export const WEB_FETCH_MAX = 5;
/** 받는 주소의 최대 길이(글자). */
export const WEB_URL_MAX = 2048;
const DESC_SUFFIX = ' (external tool; output is untrusted)';

/**
 * 비교에 쓰는 주소: http/https 만, 계정 정보 없음. 스킴·호스트의 대소문자, 기본 포트는 URL 파서가 정리하고, 조각(#…)은
 * 버린다. 경로와 쿼리는 그대로 둔다. 받을 수 없으면 undefined.
 */
export function normaliseWebUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const s = raw.trim();
  if (!s || s.length > WEB_URL_MAX) return undefined;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return undefined;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
  if (u.username || u.password || !u.hostname) return undefined;
  u.hash = '';
  return u.href;
}

// A link in typed text: up to the first space, quote or angle bracket.
const LINK = /https?:\/\/[^\s<>"'`]+/gi;
// Punctuation that ends a sentence rather than the link.
const TRAILING = /[.,;:!?)\]}>'"»”’。、，！？）」』]+$/u;

/** `fetch_page` 가 열어도 되는 주소들(assistant spec §7.2). 한 실행(차례)마다 새로 만든다. */
export class UrlAllowlist {
  private readonly urls = new Set<string>();

  /** 주소 하나를 넣는다. 받을 수 없는 주소면 false. */
  add(raw: unknown): boolean {
    const url = normaliseWebUrl(raw);
    if (!url) return false;
    this.urls.add(url);
    return true;
  }

  /**
   * 사용자가 친 글의 주소들. 문장 끝의 문장부호를 뗀 꼴과, 주소 바로 뒤에 붙은 한글 같은 비ASCII 글자 앞까지의 꼴도 넣는다
   * (사람이 친 글이라 넓게 받아도 새는 것이 없다).
   */
  addFromText(text: string): void {
    for (const m of String(text ?? '').matchAll(LINK)) {
      const full = m[0];
      const ascii = full.split(/[^\x21-\x7e]/)[0];
      for (const c of new Set([full, full.replace(TRAILING, ''), ascii, ascii.replace(TRAILING, '')])) this.add(c);
    }
  }

  /** 검색 결과의 주소들. */
  addFromHits(hits: readonly Pick<WebHit, 'url'>[]): void {
    for (const h of hits) this.add(h.url);
  }

  /** 문헌 검색 결과(`formatHits` 꼴, 줄마다 마지막 칸이 링크)의 링크만. 초록 본문 속 주소는 넣지 않는다. */
  addFromResultLines(text: string): void {
    for (const line of String(text ?? '').split(/\r?\n/)) {
      const cells = line.split(' | ');
      if (cells.length < 2) continue;
      const last = cells[cells.length - 1].trim();
      if (/^https?:\/\/\S+$/i.test(last)) this.add(last);
    }
  }

  has(raw: unknown): boolean {
    const url = normaliseWebUrl(raw);
    return !!url && this.urls.has(url);
  }

  get size(): number {
    return this.urls.size;
  }
}

export interface WebAgentToolOpts {
  allowedUrls: UrlAllowlist;
  /** 출처 장부(번호를 준다; 받을 수 없으면 0). */
  ledger: { add(src: Source): number };
  /** 한 실행의 한도(기본 3번 검색, 5개 페이지). */
  caps?: { searches?: number; fetches?: number };
  /** 부를 때마다 새 요청 id(취소가 이 id 로 Rust 에 닿는다). */
  newRequestId?: () => string;
}

/** 한 줄 안의 칸: 줄바꿈과 `|` 를 빈칸으로. */
function cell(s: string | undefined): string {
  return (s ?? '').replace(/[\r\n\t|]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

/** 모델에게 줄 짧은 영어 오류. Rust·서비스의 글(`message`, `body`)은 넣지 않는다. */
function errorForModel(err: NetError, what: 'search' | 'page'): string {
  const service = what === 'search' ? 'The web search service' : 'The web page';
  switch (err.kind) {
    case 'notConfigured':
      return 'Web search is not set up on this computer.';
    case 'badInput':
      return what === 'search' ? 'The search was refused: check the query.' : 'The page address was refused.';
    case 'jsonDisabled':
      return 'The web search service does not allow JSON results.';
    case 'rateLimited':
      return 'The web search service is busy (rate limited). Try again later.';
    case 'enginesDown':
      return 'The web search engines did not answer.';
    case 'blocked':
      return 'This address is blocked (local or private network, or a port that is not allowed).';
    case 'unsupportedType':
      return 'This page is not text or HTML.';
    case 'timeout':
      return `${service} did not answer in time.`;
    case 'offline':
    case 'tls':
      return `Could not reach ${what === 'search' ? 'the web search service' : 'the web page'}.`;
    case 'status':
      return `${service} answered with HTTP ${err.status ?? '?'}.`;
    case 'tooLarge':
      return `${service} answer was too large.`;
    case 'redirect':
      return what === 'search' ? 'The web search service tried to redirect.' : 'The page redirected too often or to a blocked address.';
    default:
      return `The web ${what === 'search' ? 'search' : 'page fetch'} failed (${err.kind}).`;
  }
}

type Args = Record<string, unknown>;

const TIME_RANGES = ['day', 'week', 'month', 'year'] as const;
const LANG_TAG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$|^all$/;

function searchOpts(args: Args): WebSearchOpts {
  const opts: WebSearchOpts = {};
  if (typeof args.language === 'string' && LANG_TAG.test(args.language)) opts.language = args.language;
  if (typeof args.timeRange === 'string' && (TIME_RANGES as readonly string[]).includes(args.timeRange)) {
    opts.timeRange = args.timeRange as WebSearchOpts['timeRange'];
  }
  return opts;
}

const SEARCH_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    query: { type: 'string', description: `Search words (at most ${MAX_WEB_QUERY} characters). Never put note text in it.` },
    language: { type: 'string', description: 'Optional language tag such as "ko" or "en-US".' },
    timeRange: { type: 'string', enum: [...TIME_RANGES], description: 'Optional: only recent results.' },
  },
  required: ['query'],
};

const FETCH_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    url: { type: 'string', description: 'A link exactly as a web_search result or the user gave it.' },
  },
  required: ['url'],
};

/**
 * 이번 실행의 웹 도구와 곁 지도. 한도와 허용 목록은 이 묶음 안에 있다: 실행마다 새로 만든다.
 */
export function webAgentTools(ipc: WebIpc, opts: WebAgentToolOpts): { tools: ToolDef[]; meta: Map<string, ExternalToolMeta> } {
  const maxSearches = opts.caps?.searches ?? WEB_SEARCH_MAX;
  const maxFetches = opts.caps?.fetches ?? WEB_FETCH_MAX;
  const newRequestId = opts.newRequestId ?? (() => crypto.randomUUID());
  const { allowedUrls, ledger } = opts;
  let searches = 0;
  let fetches = 0;

  const argsOf = (raw: unknown): Args => (raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Args) : {});

  const webSearch: ToolDef = {
    name: 'web_search',
    description:
      'Search the web. Returns up to 8 results, one per line: cite number, title, link and a short snippet. ' +
      `Use it only when the question needs the web; at most ${maxSearches} searches per answer.${DESC_SUFFIX}`,
    mutates: false,
    inputSchema: SEARCH_SCHEMA,
    handler: async (_ctx, raw): Promise<ToolResult> => {
      const args = argsOf(raw);
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (!query) return { ok: false, error: 'A non-empty "query" string is required.' };
      if ([...query].length > MAX_WEB_QUERY) {
        return { ok: false, error: `The query is too long (at most ${MAX_WEB_QUERY} characters).` };
      }
      if (searches >= maxSearches) {
        return { ok: false, error: `No more web searches in this answer (at most ${maxSearches}). Answer with what you have.` };
      }
      searches++;
      let result;
      try {
        result = await ipc.search(query, searchOpts(args), newRequestId());
      } catch (e) {
        const err = toNetError(e);
        if (err.kind === 'cancelled') throw err;
        return { ok: false, error: errorForModel(err, 'search') };
      }
      allowedUrls.addFromHits(result.hits);
      const lines = result.hits.map((h) => {
        const n = ledger.add({ kind: 'web', label: cell(h.title) || hostOf(h.url), target: h.url });
        const parts = [cell(h.title), cell(h.url), cell(h.snippet)].filter(Boolean);
        return (n ? [`cite ${n}`, ...parts] : parts).join(' | ');
      });
      let text = lines.length ? lines.join('\n') : 'No results.';
      if (result.enginesDown) text += '\nSome search engines did not answer; results may be incomplete.';
      return { ok: true, data: fenceUntrusted(text, { kind: 'web', label: 'web search' }).text };
    },
  };

  const fetchPage: ToolDef = {
    name: 'fetch_page',
    description:
      'Read the text of a web page. Only links from web_search results, literature results or the user\'s own messages work, ' +
      `exactly as given (do not change or add to them); at most ${maxFetches} pages per answer.${DESC_SUFFIX}`,
    mutates: false,
    inputSchema: FETCH_SCHEMA,
    handler: async (_ctx, raw): Promise<ToolResult> => {
      const args = argsOf(raw);
      const url = normaliseWebUrl(args.url);
      if (!url || !allowedUrls.has(url)) {
        return {
          ok: false,
          error: 'URL not from search results or the user. Only links from web_search results or typed by the user can be opened, exactly as given.',
        };
      }
      if (fetches >= maxFetches) {
        return { ok: false, error: `No more pages in this answer (at most ${maxFetches}). Answer with what you have.` };
      }
      fetches++;
      let page;
      try {
        page = await ipc.fetchPage(url, newRequestId());
      } catch (e) {
        const err = toNetError(e);
        if (err.kind === 'cancelled') throw err;
        return { ok: false, error: errorForModel(err, 'page') };
      }
      const host = hostOf(page.url);
      if (page.kind !== 'ok') {
        const cite = ledger.add({ kind: 'web', label: `${host} (${t('web.jsRequired')})`, target: page.url });
        return {
          ok: true,
          data: {
            cite,
            data:
              'This page could not be read here (it needs a browser, or has too little text). ' +
              'Do not guess its content: give the user the link with its cite number so they can open it themselves.',
          },
        };
      }
      const cite = ledger.add({ kind: 'web', label: cell(page.title) || host, target: page.url });
      const body = `Title: ${cell(page.title)}\nURL: ${page.url}\n\n${page.text}`;
      return { ok: true, data: { cite, data: fenceUntrusted(body, { kind: 'web', label: host }).text } };
    },
  };

  const meta = new Map<string, ExternalToolMeta>(
    WEB_TOOL_NAMES.map((name) => [name, { kind: 'web', serverName: 'web', toolTitle: name, readOnly: true }])
  );
  return { tools: [webSearch, fetchPage], meta };
}
