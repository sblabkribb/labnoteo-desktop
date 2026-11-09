// "bfworkflow: Open design in browser" and "bfworkflow: Design usage" (SP6 Task 41). Written fresh (D5).
//
// Both are read-only: they call only `read`-scope GET endpoints and open a page in the default browser.
// Pushing this note's usage to bfworkflow (spec §8 point 3) waits for a server endpoint that accepts it (D3);
// until then the app only looks usage up.
import type { PickItem } from '@labnoteo/core';
import * as posix from '@labnoteo/core/posix';
import { parseWorkflowFileName } from '@labnoteo/core/lib/workflowStructure';
import { t } from '../i18n/t';
import type { CommandContext } from '../labnote/commands/context';
import { openNote } from '../labnote/openNotes';
import { bfwBase, bfwRequest, NetError, type InvokeFn } from '../integrations/netIpc';
import { openExternal, tauriExternalDeps } from '../links/openExternal';
import { bfwErrorText } from './bfwApp';
import { isCatalogId } from './catalogMap';

type OpenFn = typeof openExternal;

/** One design that uses a catalog workflow (`used_by` of `/api/design-usage/catalog-workflows`). */
interface UsageRef {
  serviceId: string;
  serviceName: string;
  archived: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function records(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.filter(isRecord) : [];
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

const trimBase = (base: string): string => base.replace(/\/+$/, '');

/** The designer page of a service: `<base>/designer?service=<id>`. */
export function designUrl(base: string, serviceId: string): string {
  return `${trimBase(base)}/designer?service=${encodeURIComponent(serviceId)}`;
}

/** The detail page of a service: `<base>/services/<id>`. */
export function serviceUrl(base: string, serviceId: string): string {
  return `${trimBase(base)}/services/${encodeURIComponent(serviceId)}`;
}

/** The catalog workflow id of a workflow note (`NNN_<id>_<name>.labnote.md`), or undefined. */
export function workflowIdOfNote(path: string | undefined): string | undefined {
  if (!path) return undefined;
  return parseWorkflowFileName(posix.basename(path))?.id;
}

/** The designs that use catalog workflow `id`, in the server's order. */
async function usageRefs(id: string, invoke: InvokeFn | undefined): Promise<UsageRef[]> {
  const all = records(await bfwRequest({ path: '/api/design-usage/catalog-workflows' }, invoke));
  const entry = all.find((e) => e.catalog_id === id);
  if (!entry) return [];
  return records(entry.used_by)
    .filter((r) => typeof r.service_id === 'string' && r.service_id !== '')
    .map((r) => ({ serviceId: r.service_id as string, serviceName: text(r.service_name), archived: r.archived === true }));
}

/** `name`, or `name (archived)`. */
function refLabel(r: UsageRef): string {
  const name = r.serviceName || r.serviceId;
  return r.archived ? `${name} (${t('bfw.archived')})` : name;
}

/** The note's text: the open editor's (unsaved typing included), otherwise the vault's. Unreadable is empty. */
async function noteText(ctx: CommandContext, path: string): Promise<string> {
  const view = openNote(path)?.view();
  if (view) return view.state.doc.toString();
  try {
    return await ctx.host.fs.read(path);
  } catch {
    return '';
  }
}

/** The catalog UO ids of the note's `### [UHWxxx …]` headings, each once, in order. */
function uoIdsOf(note: string): string[] {
  const ids: string[] = [];
  for (const m of note.matchAll(/^###\s+\[(\S+)/gm)) {
    if (isCatalogId(m[1], 'uo') && !ids.includes(m[1])) ids.push(m[1]);
  }
  return ids;
}

/** For each UO id: service id → the number of times that design's workflows use it. */
function uoCounts(usage: unknown): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const u of records(usage)) {
    if (typeof u.uo_id !== 'string') continue;
    const byService = new Map<string, number>();
    for (const s of records(u.services)) {
      if (typeof s.id !== 'string') continue;
      const n = records(s.workflows).reduce((sum, w) => sum + (typeof w.count === 'number' ? w.count : 0), 0);
      byService.set(s.id, (byService.get(s.id) ?? 0) + n);
    }
    out.set(u.uo_id, byService);
  }
  return out;
}

function notifyFailure(ctx: CommandContext, e: unknown): void {
  if (!(e instanceof NetError)) throw e;
  if (e.kind === 'cancelled') return;
  ctx.host.notify('warn', bfwErrorText(e, { connection: ctx.settings.bfwConnection, url: ctx.settings.bfwUrl, scope: 'read' }));
}

function externalDeps(ctx: CommandContext) {
  return tauriExternalDeps((kind, message) => ctx.host.notify(kind, message));
}

/**
 * Run "bfworkflow: Open design in browser". On a workflow note it offers the designs that use the note's workflow;
 * otherwise it offers every design. The chosen one opens in the default browser at the connection's base
 * (`bfw_base`: the server, or the desktop app's loopback address).
 */
export async function runOpenDesign(ctx: CommandContext, invoke?: InvokeFn, open: OpenFn = openExternal): Promise<void> {
  const { host } = ctx;
  try {
    const base = await bfwBase(invoke);
    const id = workflowIdOfNote(ctx.activePath());
    let items: PickItem<string>[];
    if (id) {
      const refs = await usageRefs(id, invoke);
      if (refs.length === 0) {
        host.notify('info', t('bfw.unusedWorkflow', id));
        return;
      }
      items = refs.map((r) => ({ label: refLabel(r), value: r.serviceId }));
    } else {
      items = records(await bfwRequest({ path: '/api/services' }, invoke))
        .filter((s) => typeof s.id === 'string' && s.id !== '' && typeof s.name === 'string')
        .map((s) => ({ label: s.name as string, detail: text(s.code) || undefined, value: s.id as string }));
      if (items.length === 0) {
        host.notify('info', t('bfw.noDesigns'));
        return;
      }
    }
    const chosen = await host.pick(items, { placeholder: t('bfw.pickDesign') });
    if (!chosen) return;
    await open(designUrl(base, chosen), externalDeps(ctx));
  } catch (e) {
    notifyFailure(ctx, e);
  }
}

/**
 * Run "bfworkflow: Design usage" on the open workflow note: the designs that use its workflow, each with its code
 * and how often it uses the note's unit operations. Picking one opens its page. Read-only (see the file header).
 */
export async function runDesignUsage(ctx: CommandContext, invoke?: InvokeFn, open: OpenFn = openExternal): Promise<void> {
  const { host } = ctx;
  const path = ctx.activePath();
  const id = workflowIdOfNote(path);
  if (!path || !id) {
    host.notify('info', t('bfw.notWorkflowNote'));
    return;
  }
  try {
    const base = await bfwBase(invoke);
    const refs = await usageRefs(id, invoke);
    if (refs.length === 0) {
      host.notify('info', t('bfw.unusedWorkflow', id));
      return;
    }
    // `used_by` carries no code: join on the service id (archived designs included).
    const codes = new Map<string, string>();
    for (const s of records(await bfwRequest({ path: '/api/services', query: [['include_archived', 'true']] }, invoke))) {
      if (typeof s.id === 'string' && text(s.code)) codes.set(s.id, text(s.code));
    }
    const uoIds = uoIdsOf(await noteText(ctx, path));
    const counts = uoIds.length > 0
      ? uoCounts(await bfwRequest({ path: '/api/design-usage/catalog-unit-operations' }, invoke))
      : new Map<string, Map<string, number>>();
    const items: PickItem<string>[] = refs.map((r) => {
      const parts: string[] = [];
      const code = codes.get(r.serviceId);
      if (code) parts.push(code);
      for (const uo of uoIds) parts.push(t('bfw.uoUsage', uo, counts.get(uo)?.get(r.serviceId) ?? 0));
      return { label: refLabel(r), detail: parts.length > 0 ? parts.join(' · ') : undefined, value: r.serviceId };
    });
    const chosen = await host.pick(items, { placeholder: t('bfw.pickDesign') });
    if (!chosen) return;
    await open(serviceUrl(base, chosen), externalDeps(ctx));
  } catch (e) {
    notifyFailure(ctx, e);
  }
}
