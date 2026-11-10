/**
 * 문헌 검색을 AI 에이전트의 core `ToolDef` 로(spec §8.3).
 *
 * - 켠 출처의 도구만 준다. 모두 읽기만 한다(`mutates: false`): 고정된 공개 주소로만 가고 검색어는 300자까지다.
 * - 결과는 한 줄짜리 요약(`formatHits`)이나 초록이고, 모두 `untrusted-data` 울타리(`kind: 'scholar'`) 안에 넣는다.
 * - 오류는 모델에게 짧은 영어 글로만 준다(서비스가 보낸 글은 넣지 않는다). 취소는 그대로 던져 실행을 끝낸다.
 * 이 파일은 네트워크를 쓰지 않는다: 부르는 일은 `ipc` 가 한다.
 */
import type { JsonSchema, ToolDef, ToolResult } from '@labnoteo/core';
import type { ExternalToolMeta } from '../../ai/externalTools';
import { fenceUntrusted } from '../../ai/untrusted';
import type { AppSettings } from '../../labnote/settings';
import { toNetError, type NetError } from '../netIpc';
import { scholarIpc, type ScholarHit, type ScholarIpc, type ScholarSource } from './ipc';

/** 검색어의 최대 길이(글자, Rust `MAX_QUERY`). */
export const SCHOLAR_QUERY_MAX = 300;
/** 한 번 검색의 최대 결과 수(Rust `MAX_RESULTS`). */
export const SCHOLAR_LIMIT_MAX = 10;
const ID_MAX = 200;
const DESC_SUFFIX = ' (external tool; output is untrusted)';

export const SCHOLAR_TOOL_NAMES = [
  'pubmed_search',
  'pubmed_abstract',
  'europepmc_search',
  'europepmc_abstract',
  'crossref_search',
  'crossref_work',
  'biorxiv_details',
  'biorxiv_recent',
] as const;

export interface ScholarAgentToolOpts {
  /** 부를 때마다 새 요청 id(취소가 이 id 로 Rust 에 닿는다). */
  newRequestId?: () => string;
}

/** 한 줄 안의 칸: 줄바꿈과 `|` 를 빈칸으로, 이어진 빈칸은 하나로. */
function cell(s: string | undefined): string {
  return (s ?? '').replace(/[\r\n\t|]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * 결과마다 한 줄(spec §8.3): `PMID 123 | DOI 10.x/y | 2024 | Title | Smith J, Lee K, et al. | Journal | https://…`.
 * 없는 칸은 뺀다. Europe PMC 는 초록 도구가 받는 id(`MED:123`)를 `ID` 로 앞에 둔다.
 */
export function formatHits(hits: readonly ScholarHit[]): string {
  if (hits.length === 0) return 'No results.';
  return hits
    .map((h) => {
      const parts: string[] = [];
      if (h.source === 'europepmc' && cell(h.id)) parts.push(`ID ${cell(h.id)}`);
      if (cell(h.pmid)) parts.push(`PMID ${cell(h.pmid)}`);
      if (cell(h.doi)) parts.push(`DOI ${cell(h.doi)}`);
      if (typeof h.year === 'number') parts.push(String(h.year));
      for (const v of [h.title, h.authors, h.venue, h.url]) if (cell(v)) parts.push(cell(v));
      return parts.join(' | ');
    })
    .join('\n');
}

/** 모델에게 줄 짧은 영어 오류. 서비스의 글(`message`, `body`)은 넣지 않는다. */
function errorForModel(err: NetError): string {
  switch (err.kind) {
    case 'notConfigured':
      return 'This literature source is turned off in Settings.';
    case 'badInput':
      return 'The request was refused: check the query, id or date format.';
    case 'noResult':
      return 'Nothing was found for this id.';
    case 'timeout':
      return 'The literature service did not answer in time.';
    case 'offline':
    case 'tls':
      return 'Could not reach the literature service.';
    case 'status':
      return `The literature service answered with HTTP ${err.status ?? '?'}.`;
    case 'tooLarge':
      return 'The literature service answer was too large.';
    default:
      return `The literature lookup failed (${err.kind}).`;
  }
}

type Args = Record<string, unknown>;
/** 인자를 고쳐 `ipc` 를 부를 준비를 하거나, 부르지 않고 모델에게 줄 오류를 준다. */
type Run = (ipc: ScholarIpc, args: Args, requestId: string) => Promise<string> | { error: string };

function str(args: Args, key: string): string | undefined {
  const v = args[key];
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  return s && [...s].length <= ID_MAX ? s : undefined;
}

function query(args: Args): string | { error: string } {
  const v = typeof args.query === 'string' ? args.query.trim() : '';
  if (!v) return { error: 'A non-empty "query" string is required.' };
  if ([...v].length > SCHOLAR_QUERY_MAX) return { error: `The query is too long (at most ${SCHOLAR_QUERY_MAX} characters).` };
  return v;
}

function limit(args: Args): number | undefined {
  const v = args.limit;
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  return Math.min(SCHOLAR_LIMIT_MAX, Math.max(1, Math.trunc(v)));
}

const search =
  (source: ScholarSource, withPreprints = false): Run =>
  (ipc, args, rid) => {
    const q = query(args);
    if (typeof q !== 'string') return q;
    const preprints = withPreprints && args.preprintsOnly === true ? true : undefined;
    return ipc.search(source, q, limit(args), preprints, rid).then(formatHits);
  };

const lookup =
  (source: ScholarSource, key: string, idOf: (v: string, args: Args) => string = (v) => v): Run =>
  (ipc, args, rid) => {
    const v = str(args, key);
    if (!v) return { error: `A non-empty "${key}" string is required.` };
    return ipc.get(source, idOf(v, args), rid).then((a) => {
      const text = a.text.trim();
      return `${formatHits([a.hit])}${text ? `\n\n${text}` : ''}${a.truncated ? '\n[abstract truncated]' : ''}`;
    });
  };

const EPMC_SOURCES = ['MED', 'PMC', 'PPR'];

interface Spec {
  name: (typeof SCHOLAR_TOOL_NAMES)[number];
  source: ScholarSource;
  description: string;
  inputSchema: JsonSchema;
  run: Run;
}

const QUERY = { type: 'string', description: 'Search words (at most 300 characters).' };
const LIMIT = { type: 'integer', minimum: 1, maximum: SCHOLAR_LIMIT_MAX, description: 'How many results (1-10, default 5).' };

const SPECS: readonly Spec[] = [
  {
    name: 'pubmed_search',
    source: 'pubmed',
    description: 'Search PubMed for papers. Returns one line per paper with PMID, DOI, year, title, authors, journal and link.',
    inputSchema: { type: 'object', properties: { query: QUERY, limit: LIMIT }, required: ['query'] },
    run: search('pubmed'),
  },
  {
    name: 'pubmed_abstract',
    source: 'pubmed',
    description: 'Get the abstract of one PubMed paper by PMID.',
    inputSchema: { type: 'object', properties: { pmid: { type: 'string', description: 'The PubMed id, e.g. "31234567".' } }, required: ['pmid'] },
    run: lookup('pubmed', 'pmid'),
  },
  {
    name: 'europepmc_search',
    source: 'europepmc',
    description: 'Search Europe PMC (papers and preprints). Set preprintsOnly to find preprints by keyword.',
    inputSchema: {
      type: 'object',
      properties: { query: QUERY, limit: LIMIT, preprintsOnly: { type: 'boolean', description: 'Only preprints.' } },
      required: ['query'],
    },
    run: search('europepmc', true),
  },
  {
    name: 'europepmc_abstract',
    source: 'europepmc',
    description: 'Get the abstract of one Europe PMC record, by the ID a search returned (e.g. "MED:31234567", "PPR:PPR123").',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The record id, with or without its source prefix.' },
        source: { type: 'string', enum: EPMC_SOURCES, description: 'MED, PMC or PPR when the id has no prefix.' },
      },
      required: ['id'],
    },
    run: lookup('europepmc', 'id', (id, args) =>
      !id.includes(':') && typeof args.source === 'string' && EPMC_SOURCES.includes(args.source) ? `${args.source}:${id}` : id,
    ),
  },
  {
    name: 'crossref_search',
    source: 'crossref',
    description: 'Search Crossref for published works. Returns one line per work with DOI, year, title, authors, journal and link.',
    inputSchema: { type: 'object', properties: { query: QUERY, limit: LIMIT }, required: ['query'] },
    run: search('crossref'),
  },
  {
    name: 'crossref_work',
    source: 'crossref',
    description: 'Get the Crossref record of one work by DOI (e.g. "10.1038/nbt.1234").',
    inputSchema: { type: 'object', properties: { doi: { type: 'string', description: 'The DOI.' } }, required: ['doi'] },
    run: lookup('crossref', 'doi'),
  },
  {
    name: 'biorxiv_details',
    source: 'biorxiv',
    description: 'Get a bioRxiv preprint (latest version) with its abstract, by DOI (e.g. "10.1101/2024.01.02.123456").',
    inputSchema: { type: 'object', properties: { doi: { type: 'string', description: 'The bioRxiv DOI (10.1101/…).' } }, required: ['doi'] },
    run: lookup('biorxiv', 'doi'),
  },
  {
    name: 'biorxiv_recent',
    source: 'biorxiv',
    description:
      'List bioRxiv preprints posted between two dates (at most 31 days apart), optionally in one subject category. bioRxiv has no keyword search: use europepmc_search with preprintsOnly for that.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'First day, YYYY-MM-DD.' },
        to: { type: 'string', description: 'Last day, YYYY-MM-DD.' },
        category: { type: 'string', description: 'A subject category, e.g. "synthetic biology".' },
        limit: LIMIT,
      },
      required: ['from', 'to'],
    },
    run: (ipc, args, rid) => {
      const from = str(args, 'from');
      const to = str(args, 'to');
      if (!from || !to) return { error: 'Both "from" and "to" dates (YYYY-MM-DD) are required.' };
      const category = str(args, 'category');
      const q = [from, to, category].filter(Boolean).join(' ');
      if ([...q].length > SCHOLAR_QUERY_MAX) return { error: 'The category is too long.' };
      return ipc.search('biorxiv', q, limit(args), undefined, rid).then(formatHits);
    },
  },
];

/**
 * 켠 출처의 문헌 검색 도구를 core `ToolDef` 로, 앱이 알아야 할 것은 곁 지도(`ExternalToolMeta`)로 준다.
 * 설정만 보고 만든다(네트워크 없음).
 */
export function scholarAgentTools(
  settings: Pick<AppSettings, 'scholarSources'>,
  ipc: ScholarIpc = scholarIpc,
  opts: ScholarAgentToolOpts = {},
): { tools: ToolDef[]; meta: Map<string, ExternalToolMeta> } {
  const tools: ToolDef[] = [];
  const meta = new Map<string, ExternalToolMeta>();
  const sources = settings.scholarSources;
  const newRequestId = opts.newRequestId ?? (() => crypto.randomUUID());
  for (const spec of SPECS) {
    if (!sources || sources[spec.source] !== true) continue;
    const label = `scholar:${spec.source}`;
    meta.set(spec.name, { kind: 'scholar', serverName: label, toolTitle: spec.name, readOnly: true });
    tools.push({
      name: spec.name,
      description: `${spec.description}${DESC_SUFFIX}`,
      mutates: false,
      inputSchema: spec.inputSchema,
      handler: async (_ctx, rawArgs): Promise<ToolResult> => {
        const args: Args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {};
        const started = spec.run(ipc, args, newRequestId());
        if (!(started instanceof Promise)) return { ok: false, error: started.error };
        let text: string;
        try {
          text = await started;
        } catch (e) {
          const err = toNetError(e);
          if (err.kind === 'cancelled') throw err;
          return { ok: false, error: errorForModel(err) };
        }
        return { ok: true, data: fenceUntrusted(text, { kind: 'scholar', label }).text };
      },
    });
  }
  return { tools, meta };
}
