/**
 * `search_catalog`(assistant spec §4.4, plan Task 11A, R8): 도우미만 쓰는 읽기 도구. 모델이 `opId`·`workflowId` 를
 * 짐작하지 않게, 보관함의 카탈로그 파일(`resources/workflows/*_en.json`)에서 단위 공정이나 워크플로를 찾아 준다.
 *
 * - 피커와 같은 행(`catalogKoFields`: 한국어 이름은 이름으로, 한국어 검색어·영어 설명은 그 아래로)과 같은 순위
 *   (`rankPickItems`)라, 한국어로 물어도 찾는다. 단위 공정은 장비·소프트웨어 이름으로도 찾는다(unitOp.ts 와 같다).
 * - 카탈로그를 채우지 않는다(`ensureWorkflowResources` 를 부르지 않는다): 파일이 없으면 아무것도 쓰지 않고
 *   "Update catalogs" 를 하라는 짧은 오류를 돌려준다.
 * - 결과는 `{id, name, description}` 만, 많아야 10개.
 */
import type { PickItem, ToolContext, ToolDef, ToolResult } from '@labnoteo/core';
import { getWorkflowFilePath, loadUnitOperations, loadWorkflows } from '@labnoteo/core/lib/workflowDataLoader';
import { coreLocale } from '../../labnote/i18n';
import { VAULT_ROOT } from '../../labnote/paths';
import { catalogKoFields } from '../../labnote/port/aliasHints';
import { rankPickItems } from '../../labnote/port/rankPickItems';

/** 한 번에 돌려주는 결과의 상한. */
export const SEARCH_CATALOG_MAX = 10;
const SEARCH_CATALOG_DEFAULT = 5;
/** 결과 설명의 글자 수 상한. */
const DESCRIPTION_CHARS = 300;
/** 검색어 글자 수 상한. */
const QUERY_MAX = 200;

interface Hit {
  id: string;
  name: string;
  description: string;
}

const clip = (s: string): string => (s.length > DESCRIPTION_CHARS ? `${s.slice(0, DESCRIPTION_CHARS)}…` : s);

function limitOf(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return SEARCH_CATALOG_DEFAULT;
  return Math.max(1, Math.min(SEARCH_CATALOG_MAX, Math.floor(raw)));
}

const missing = (kind: 'unitOp' | 'workflow'): ToolResult => ({
  ok: false,
  error:
    `The ${kind === 'unitOp' ? 'unit operation' : 'workflow'} catalog is not in this vault yet. ` +
    'Ask the user to run the "Update catalogs" command, then search again.',
  code: 'catalogMissing',
  params: [kind],
});

async function search(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const kind = args.kind;
  if (kind !== 'unitOp' && kind !== 'workflow') return { ok: false, error: 'kind must be "unitOp" or "workflow".' };
  const query = typeof args.query === 'string' ? args.query.trim().slice(0, QUERY_MAX) : '';
  if (!query) return { ok: false, error: 'query is required.' };
  const limit = limitOf(args.limit);
  const root = ctx.workspaceRoot || VAULT_ROOT;
  const locale = ctx.locale ?? coreLocale();

  let items: PickItem<Hit>[];
  if (kind === 'workflow') {
    if (!(await ctx.fs.exists(getWorkflowFilePath(root, 'workflows')))) return missing(kind);
    const catalog = await loadWorkflows(ctx.fs, root);
    items = catalog.workflows.map((wf) => {
      const fields = catalogKoFields(wf.id, wf.category, wf.description, locale);
      return { label: `${wf.id}: ${wf.name}`, ...fields, value: { id: wf.id, name: wf.name, description: clip(fields.detail) } };
    });
  } else {
    const kinds = (['hw', 'sw'] as const).map((k) => ({ k, path: getWorkflowFilePath(root, `unitoperations_${k}`) }));
    const present: Array<'hw' | 'sw'> = [];
    for (const { k, path } of kinds) if (await ctx.fs.exists(path)) present.push(k);
    if (present.length === 0) return missing(kind);
    items = [];
    for (const k of present) {
      const catalog = await loadUnitOperations(ctx.fs, root, k);
      for (const op of catalog.unitOperations) {
        const fields = catalogKoFields(op.id, k === 'hw' ? 'HW' : 'SW', op.description, locale);
        const tools = [op.equipment, op.software].filter((x): x is string => !!x);
        const searchWords = [...(fields.searchWords ?? []), ...tools];
        items.push({
          label: `${op.id}: ${op.name}`,
          ...fields,
          ...(searchWords.length > 0 ? { searchWords } : {}),
          value: { id: op.id, name: op.name, description: clip(fields.detail) },
        });
      }
    }
  }
  const results = rankPickItems(items, query)
    .slice(0, limit)
    .map((item) => item.value);
  return { ok: true, data: { kind, query, results } };
}

export function searchCatalogTool(): ToolDef {
  return {
    name: 'search_catalog',
    mutates: false,
    description:
      "Search the vault's catalog for a unit operation (kind \"unitOp\", hardware and software) or a workflow (kind \"workflow\") by ID, " +
      'English or Korean name, or keywords. Returns {id, name, description} of the best matches; use the id as opId for ' +
      'get_unit_operation / insert_unit_operation, or as workflowId for create_workflow.',
    inputSchema: {
      type: 'object',
      required: ['kind', 'query'],
      properties: {
        kind: { type: 'string', enum: ['unitOp', 'workflow'] },
        query: { type: 'string', description: 'An ID (e.g. UHW010), a name or keywords, in English or Korean.' },
        limit: { type: 'integer', minimum: 1, maximum: SEARCH_CATALOG_MAX, default: SEARCH_CATALOG_DEFAULT },
      },
    },
    handler: search,
  };
}
