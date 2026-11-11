/**
 * `search_catalog`(assistant spec §4.4, plan Task 11A, R8): 도우미만 쓰는 읽기 도구. 모델이 `opId`·`workflowId` 를
 * 짐작하지 않게, 보관함의 카탈로그 파일(`resources/workflows/*_en.json`, Workflow 탭이 보이는 것)에서 단위 공정이나
 * 워크플로를 찾아 준다.
 *
 * - 피커와 같은 행(`catalogKoFields`: 한국어 이름은 이름으로, 한국어 검색어·영어 설명은 그 아래로)과 같은 순위
 *   (`rankPickItems`)라, 한국어로 물어도 찾는다. 단위 공정은 장비·소프트웨어 이름으로도 찾는다(unitOp.ts 와 같다).
 *   모든 낱말이 맞는 것이 없으면 낱말 하나라도 맞는 것을 많이 맞는 차례로 돌려준다(모델은 긴 검색어를 쓴다).
 * - `kind` 를 빼면 둘 다 찾는다(코드 꼴이면 그 종류만: U… 는 단위 공정, W… 는 Workflow).
 * - 카탈로그를 채우지 않는다(`ensureWorkflowResources` 를 부르지 않는다): 파일이 없으면 아무것도 쓰지 않고
 *   "Update catalogs" 를 하라는 짧은 오류를 돌려준다.
 * - 결과(많아야 10개)는 `{kind, id, name, nameKo?, category, description, equipment?|software?, unitOperations?}`.
 *   코드가 꼭 맞는 결과는 설명을 거의 자르지 않는다. Workflow 의 `unitOperations` 는 카탈로그가 적어 둘 때만 있다
 *   (user decision 2026-11-11: Workflow·Unit Operation 질문은 카탈로그 설명이 먼저다).
 */
import { catalogKoEntry, type PickItem, type ToolContext, type ToolDef, type ToolResult } from '@labnoteo/core';
import { getWorkflowFilePath, loadUnitOperations, loadWorkflows } from '@labnoteo/core/lib/workflowDataLoader';
import { coreLocale } from '../../labnote/i18n';
import { VAULT_ROOT } from '../../labnote/paths';
import { catalogKoFields } from '../../labnote/port/aliasHints';
import { rankPickItems } from '../../labnote/port/rankPickItems';

/** 한 번에 돌려주는 결과의 상한. */
export const SEARCH_CATALOG_MAX = 10;
const SEARCH_CATALOG_DEFAULT = 5;
/** 결과 설명의 글자 수 상한(코드가 꼭 맞는 결과는 `EXACT_DESCRIPTION_CHARS`). */
const DESCRIPTION_CHARS = 300;
const EXACT_DESCRIPTION_CHARS = 2000;
/** 검색어 글자 수 상한. */
const QUERY_MAX = 200;

type Kind = 'unitOp' | 'workflow';

/** 결과 한 줄. */
export interface CatalogHit {
  kind: Kind;
  id: string;
  name: string;
  /** 플러그인 카탈로그의 한국어 이름(있을 때). */
  nameKo?: string;
  /** Workflow 는 Design/Build/Test/Learn 같은 갈래, 단위 공정은 HW 또는 SW. */
  category: string;
  description: string;
  equipment?: string;
  software?: string;
  /** Workflow 의 대표 Unit Operation(카탈로그가 적어 둘 때만). */
  unitOperations?: string[];
}

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max)}…` : s);

function limitOf(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return SEARCH_CATALOG_DEFAULT;
  return Math.max(1, Math.min(SEARCH_CATALOG_MAX, Math.floor(raw)));
}

const missing = (kind: Kind): ToolResult => ({
  ok: false,
  error:
    `The ${kind === 'unitOp' ? 'unit operation' : 'workflow'} catalog is not in this vault yet. ` +
    'Ask the user to run the "Update catalogs" command, then search again.',
  code: 'catalogMissing',
  params: [kind],
});

/**
 * Workflow 결과에 Unit Operation 목록이 없을 때 결과에 붙는 말(real-app check, 2026-11-11: 모델이 Workflow 의 Unit
 * Operation 을 하나씩 찾다 단계 한도에 걸렸다).
 */
export const NO_UO_LIST_NOTE =
  "The catalog does not list these Workflows' Unit Operations. Do not search for them one by one: answer from the " +
  'description, and say that the catalog has no Unit Operation list (workflow_get_method, if you have it, gives the ' +
  'ones named in papers).';

/** 카탈로그 코드 꼴(UHW010, USW020, WB030, WD010 …). */
const CODE = /^(?:U[HS]W|W[A-Z])\d{3}$/i;

/** 검색어가 코드면 그 종류. */
function kindOfCode(query: string): Kind | undefined {
  if (!CODE.test(query)) return undefined;
  return /^u/i.test(query) ? 'unitOp' : 'workflow';
}

/** Workflow 항목이 적어 둔 Unit Operation(코드 목록이나 {id} 목록). 없으면 undefined. */
function typicalUnitOps(raw: Record<string, unknown>): string[] | undefined {
  const list = raw.unitOperations ?? raw.unit_operations ?? raw.uos;
  if (!Array.isArray(list)) return undefined;
  const out = list
    .map((x) => {
      if (typeof x === 'string') return x.trim();
      const id = x && typeof x === 'object' ? (x as { id?: unknown }).id : undefined;
      return typeof id === 'string' ? id.trim() : '';
    })
    .filter(Boolean)
    .slice(0, 30);
  return out.length > 0 ? out : undefined;
}

const nameKoOf = (id: string): string | undefined => catalogKoEntry(id)?.name || undefined;

/** 한 종류의 행. 파일이 없으면 null. */
async function rowsOf(ctx: ToolContext, kind: Kind, root: string, locale: string): Promise<PickItem<CatalogHit>[] | null> {
  if (kind === 'workflow') {
    if (!(await ctx.fs.exists(getWorkflowFilePath(root, 'workflows')))) return null;
    const catalog = await loadWorkflows(ctx.fs, root);
    return catalog.workflows.map((wf) => {
      const fields = catalogKoFields(wf.id, wf.category, wf.description, locale);
      const uos = typicalUnitOps(wf as unknown as Record<string, unknown>);
      const nameKo = nameKoOf(wf.id);
      const hit: CatalogHit = {
        kind,
        id: wf.id,
        name: wf.name,
        ...(nameKo ? { nameKo } : {}),
        category: wf.category,
        description: fields.detail,
        ...(uos ? { unitOperations: uos } : {}),
      };
      return { label: `${wf.id}: ${wf.name}`, ...fields, value: hit };
    });
  }
  const present: Array<'hw' | 'sw'> = [];
  for (const k of ['hw', 'sw'] as const) if (await ctx.fs.exists(getWorkflowFilePath(root, `unitoperations_${k}`))) present.push(k);
  if (present.length === 0) return null;
  const items: PickItem<CatalogHit>[] = [];
  for (const k of present) {
    const catalog = await loadUnitOperations(ctx.fs, root, k);
    for (const op of catalog.unitOperations) {
      const category = k === 'hw' ? 'HW' : 'SW';
      const fields = catalogKoFields(op.id, category, op.description, locale);
      const tools = [op.equipment, op.software].filter((x): x is string => !!x);
      const searchWords = [...(fields.searchWords ?? []), ...tools];
      const nameKo = nameKoOf(op.id);
      const hit: CatalogHit = {
        kind,
        id: op.id,
        name: op.name,
        ...(nameKo ? { nameKo } : {}),
        category,
        description: fields.detail,
        ...(op.equipment ? { equipment: op.equipment } : {}),
        ...(op.software ? { software: op.software } : {}),
      };
      items.push({
        label: `${op.id}: ${op.name}`,
        ...fields,
        ...(searchWords.length > 0 ? { searchWords } : {}),
        value: hit,
      });
    }
  }
  return items;
}

/** 낱말 하나라도 맞는 행, 많이 맞는 차례(같으면 원래 차례). 모든 낱말이 맞는 행이 없을 때만 쓴다. */
function anyWord(items: readonly PickItem<CatalogHit>[], query: string): PickItem<CatalogHit>[] {
  const words = [...new Set(query.toLowerCase().split(/[\s,;/]+/).filter((w) => w.length >= 2))];
  if (words.length < 2) return [];
  return items
    .map((item, index) => {
      const extra = (item as { searchWords?: readonly string[] }).searchWords ?? [];
      const hay = [item.label, ...(item.keywords ?? []), ...extra, item.description ?? '', item.detail ?? ''].join(' ').toLowerCase();
      return { item, index, n: words.filter((w) => hay.includes(w)).length };
    })
    .filter((r) => r.n > 0)
    .sort((a, b) => b.n - a.n || a.index - b.index)
    .map((r) => r.item);
}

async function search(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const rawKind = args.kind;
  const given = rawKind !== undefined && rawKind !== null && rawKind !== '';
  if (given && rawKind !== 'unitOp' && rawKind !== 'workflow') return { ok: false, error: 'kind must be "unitOp", "workflow" or left out.' };
  const query = typeof args.query === 'string' ? args.query.trim().slice(0, QUERY_MAX) : '';
  if (!query) return { ok: false, error: 'query is required.' };
  const limit = limitOf(args.limit);
  const root = ctx.workspaceRoot || VAULT_ROOT;
  const locale = ctx.locale ?? coreLocale();
  const asked = given ? (rawKind as Kind) : undefined;
  const byCode = kindOfCode(query);
  const kinds: Kind[] = asked ? [asked] : byCode ? [byCode] : ['unitOp', 'workflow'];

  const items: PickItem<CatalogHit>[] = [];
  let absent: Kind | undefined;
  for (const k of kinds) {
    const rows = await rowsOf(ctx, k, root, locale);
    if (rows) items.push(...rows);
    else absent ??= k;
  }
  if (items.length === 0 && absent) return missing(absent);
  let ranked = rankPickItems(items, query);
  if (ranked.length === 0) ranked = anyWord(items, query);
  const code = query.toUpperCase();
  const results = ranked.slice(0, limit).map(({ value }) => ({
    ...value,
    description: clip(value.description, value.id.toUpperCase() === code ? EXACT_DESCRIPTION_CHARS : DESCRIPTION_CHARS),
  }));
  const bareWorkflows = results.some((r) => r.kind === 'workflow' && !r.unitOperations);
  return { ok: true, data: { ...(asked ? { kind: asked } : {}), query, results, ...(bareWorkflows ? { note: NO_UO_LIST_NOTE } : {}) } };
}

export function searchCatalogTool(): ToolDef {
  return {
    name: 'search_catalog',
    mutates: false,
    description:
      "Look up the vault's Workflow / Unit Operation catalog (what the Workflow tab shows) by code (e.g. UHW010, WB030), " +
      'English or Korean name, or keywords. Returns {kind, id, name, nameKo, category, description, equipment or software, ' +
      'unitOperations when the catalog lists them}. Use it first for any question about what a Workflow or Unit Operation ' +
      'is or does, and to get real codes: use the id as opId for get_unit_operation / insert_unit_operation, or as ' +
      'workflowId for create_workflow. Leave kind out to search both.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        kind: { type: 'string', enum: ['unitOp', 'workflow'], description: 'Optional: only Unit Operations or only Workflows.' },
        query: { type: 'string', description: 'A code (e.g. UHW010, WB030), a name or keywords, in English or Korean.' },
        limit: { type: 'integer', minimum: 1, maximum: SEARCH_CATALOG_MAX, default: SEARCH_CATALOG_DEFAULT },
      },
    },
    handler: search,
  };
}
