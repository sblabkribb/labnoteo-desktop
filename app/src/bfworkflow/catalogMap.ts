// Maps the bfworkflow server catalogs (GET /api/workflow-catalog and
// GET /api/uo-catalog-json) to the shape of the bundled catalog files (D16).
// Server ids later become file names, so every id is checked by isCatalogId.
import { contentHash } from '../labnote/port/catalogUpdate';

export interface CatalogWorkflow {
  id: string;
  name: string;
  description: string;
  category: 'Design' | 'Build' | 'Test' | 'Learn';
}

export interface CatalogUo {
  id: string;
  name: string;
  description: string;
  equipment?: string;
  software?: string;
}

const WORKFLOW_ID = /^W[DBTL]\d{3,4}$/;
const UO_ID = /^U[HS]W\d{3,4}$/;
const NAME_MAX = 200;
const DESCRIPTION_MAX = 2000;

const CATEGORY_BY_DOMAIN: Record<string, CatalogWorkflow['category']> = {
  design: 'Design',
  build: 'Build',
  test: 'Test',
  learn: 'Learn',
};
const CATEGORY_BY_PREFIX: Record<string, CatalogWorkflow['category']> = {
  WD: 'Design',
  WB: 'Build',
  WT: 'Test',
  WL: 'Learn',
};

export function isCatalogId(id: unknown, kind: 'workflow' | 'uo'): id is string {
  return typeof id === 'string' && (kind === 'workflow' ? WORKFLOW_ID : UO_ID).test(id);
}

export function categoryFor(id: string, domain: unknown): CatalogWorkflow['category'] | undefined {
  if (typeof domain === 'string') {
    const byDomain = CATEGORY_BY_DOMAIN[domain.trim().toLowerCase()];
    if (byDomain) return byDomain;
  }
  return CATEGORY_BY_PREFIX[id.slice(0, 2)];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Line breaks and tabs become spaces; every other control character is removed. Then cut to `max` code points. */
function cleanText(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  const s = v.replace(/[\t\n\r]+/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '');
  const points = Array.from(s);
  return points.length > max ? points.slice(0, max).join('') : s;
}

/** An array is joined with ', ', a string is kept, anything else is ''. */
function toolText(v: unknown): string {
  if (Array.isArray(v)) {
    return cleanText(
      v.filter((x): x is string => typeof x === 'string').join(', '),
      DESCRIPTION_MAX,
    );
  }
  return cleanText(v, DESCRIPTION_MAX);
}

function byId<T extends { id: string }>(a: T, b: T): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function mapWorkflowCatalog(rows: unknown): { workflows: CatalogWorkflow[]; skipped: string[] } {
  const workflows: CatalogWorkflow[] = [];
  const skipped: string[] = [];
  if (!Array.isArray(rows)) return { workflows, skipped };
  for (const row of rows) {
    const rawId = isRecord(row) ? row.workflow_id : undefined;
    const label = typeof rawId === 'string' ? rawId : '?';
    if (!isRecord(row) || typeof rawId !== 'string' || typeof row.name !== 'string') {
      skipped.push(label);
      continue;
    }
    if (!isCatalogId(rawId, 'workflow')) {
      skipped.push(label);
      continue;
    }
    const category = categoryFor(rawId, row.domain);
    if (!category) {
      skipped.push(label);
      continue;
    }
    workflows.push({
      id: rawId,
      name: cleanText(row.name, NAME_MAX),
      description: cleanText(row.description ?? '', DESCRIPTION_MAX),
      category,
    });
  }
  return { workflows, skipped };
}

export function mapUoCatalog(json: unknown): { hw: CatalogUo[]; sw: CatalogUo[]; skipped: string[] } {
  const hw: CatalogUo[] = [];
  const sw: CatalogUo[] = [];
  const skipped: string[] = [];
  const ops = isRecord(json) ? json.unit_operations : undefined;
  if (!isRecord(ops)) return { hw, sw, skipped };
  for (const [key, entry] of Object.entries(ops)) {
    const id = isRecord(entry) && entry.id !== undefined ? entry.id : key;
    const label = typeof id === 'string' ? id : key;
    if (!isRecord(entry) || !isCatalogId(id, 'uo') || typeof entry.name !== 'string') {
      skipped.push(label);
      continue;
    }
    const base = {
      id,
      name: cleanText(entry.name, NAME_MAX),
      description: cleanText(entry.description ?? '', DESCRIPTION_MAX),
    };
    const isSoftware =
      entry.type === 'software' ||
      (entry.type === undefined && ('software' in entry || id.startsWith('USW')));
    if (isSoftware) sw.push({ ...base, software: toolText(entry.software) });
    else hw.push({ ...base, equipment: toolText(entry.equipment) });
  }
  hw.sort(byId);
  sw.sort(byId);
  return { hw, sw, skipped };
}

/** JSON with object keys sorted, so equal content gives equal text whatever the key order. */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (isRecord(v)) {
    const keys = Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

export function mergeById<T extends { id: string }>(
  vault: readonly T[],
  server: readonly T[],
): { merged: T[]; added: number; changed: number; kept: number } {
  const byKey = new Map<string, T>();
  for (const v of vault) byKey.set(v.id, v);
  const serverIds = new Set<string>();
  let added = 0;
  let changed = 0;
  for (const s of server) {
    serverIds.add(s.id);
    const old = byKey.get(s.id);
    if (old === undefined) added++;
    else if (stableJson(old) !== stableJson(s)) changed++;
    byKey.set(s.id, s);
  }
  let kept = 0;
  for (const id of byKey.keys()) if (!serverIds.has(id)) kept++;
  return { merged: [...byKey.values()].sort(byId), added, changed, kept };
}

export function serverCatalogHash(c: { workflows: CatalogWorkflow[]; hw: CatalogUo[]; sw: CatalogUo[] }): string {
  const sorted = {
    workflows: [...c.workflows].sort(byId),
    hw: [...c.hw].sort(byId),
    sw: [...c.sw].sort(byId),
  };
  return contentHash(stableJson(sorted));
}
