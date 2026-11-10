// The shared, folder-scoped AI context builder (spec §3, §5). One builder for
// the in-app drafting command and the MCP context tools: it never knows which
// path called it, since the caller passes the token budget (in-app:
// `contextBudget(window, fixed)`; MCP: `maxTokens`).
//
// Reads stay inside `scope.folder` (chain, local sample registry) plus the
// global sample registry; a folder in `scope.named` adds only its outline
// (README goal and workflow/unit-op outline), never its samples (spec §4.1, §13).
import { createLabnoteTools, runTool, type LabnoteFs, type ToolContext, type ToolDef } from '@labnoteo/core';
import { buildSampleIdPattern, SAMPLE_TYPES } from '@labnoteo/core/lib/sampleUtils';
import { loadSamplesByType, type SampleRecord } from '@labnoteo/core/lib/sampleStorage';
import { applyBudget, type BudgetResult } from './budget';
import {
  buildChain,
  isPlaceholderBody,
  PLANNING_SECTIONS_HW,
  PLANNING_SECTIONS_SW,
  previousUnitOp,
  type ChainIssue,
  type ExperimentChain,
  type UnitOpNode,
  type UnitOpTarget,
  type WorkflowNode,
} from './chain';
import type { Scope } from './scope';
import { estimateTokens } from './tokens';
import type { ContextSource, SourceKind } from './types';

/** At most this many sample registry entries become sources; further IDs stay as IDs in the notes. */
export const MAX_SAMPLE_SOURCES = 30;

/** Sections shown for an earlier unit op (template order; Environment for software ops). */
const CONTEXT_SECTIONS: readonly string[] = [...PLANNING_SECTIONS_HW, 'Environment'];
/** Sections offered as the default-excluded results source. */
const RESULT_SECTIONS: readonly string[] = ['Results & Discussions', 'QC Metrics', 'Discussion'];

export type CatalogDefinition = { name: string; description?: string; equipment?: string; software?: string };

export interface BuildInput {
  fs: LabnoteFs;
  scope: Scope;
  /** The unit op being drafted; without it the context covers the whole experiment. */
  target?: UnitOpTarget;
  /** Tick the Results/QC/Discussion sources of earlier unit ops (default: offered unticked). */
  includeResults?: boolean;
  /** Prompt budget in estimated tokens, computed by the caller. */
  budgetTokens: number;
  /** Source ids the user unticked; required ids cannot be excluded. */
  exclude?: string[];
  customTypes?: string[];
  globalSampleFolder?: string;
  /** Catalog definition of a unit-operation id, or undefined when unknown. */
  catalog: (opId: string) => Promise<CatalogDefinition | undefined>;
}

export interface BuiltContext extends BudgetResult {
  scope: Scope;
  chain: ExperimentChain;
  target?: UnitOpNode;
  issues: ChainIssue[];
}

// ---------------------------------------------------------------- helpers

const pathKey = (path: string): string => path.normalize('NFC').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

function source(
  id: string,
  kind: SourceKind,
  text: string,
  extra: Partial<ContextSource> & { label: string }
): ContextSource {
  return {
    id,
    kind,
    text,
    mode: 'verbatim',
    tokens: estimateTokens(text),
    distance: 0,
    required: false,
    included: true,
    ...extra,
  };
}

const uoId = (uo: UnitOpNode): string => `uo:${uo.workflowPath}#${uo.index}`;

function unitOpLabel(uo: UnitOpNode, wf?: WorkflowNode): string {
  const head = uo.heading.replace(/^#+\s*/, '');
  return wf ? `${wf.label} › ${head}` : head;
}

/** Characters kept of the Method line in an outline. */
const OUTLINE_LINE_CHARS = 160;

/** The first non-blank, non-fence line of Method, capped; undefined for a placeholder. */
function firstLine(body: string | undefined): string | undefined {
  if (body === undefined || isPlaceholderBody('Method', body)) return undefined;
  const line = body
    .split(/\r?\n/)
    .map(l => l.trim())
    .find(l => l !== '' && !l.startsWith('```') && !l.startsWith('~~~'));
  if (line === undefined) return undefined;
  const chars = Array.from(line);
  return chars.length <= OUTLINE_LINE_CHARS ? line : chars.slice(0, OUTLINE_LINE_CHARS).join('').trimEnd() + '…';
}

const ids = (list: readonly string[]): string => (list.length > 0 ? list.join(', ') : '(none)');

/** Heading, Input/Output IDs and the first line of Method. */
function unitOpOutlineLines(uo: UnitOpNode): string[] {
  const out = [uo.heading, `Input: ${ids(uo.inputIds)}`, `Output: ${ids(uo.outputIds)}`];
  const method = firstLine(uo.sections.Method);
  if (method) out.push(`Method: ${method}`);
  return out;
}

/** A workflow title plus a per-unit-op outline. */
function workflowOutline(wf: WorkflowNode): string {
  const parts = [`${wf.label} (${wf.fileName})`];
  if (wf.unitOps.length === 0) parts.push('(no unit operations)');
  for (const uo of wf.unitOps) parts.push(unitOpOutlineLines(uo).join('\n'));
  return parts.join('\n\n');
}

/** The heading and the given sections that hold more than a placeholder. */
function sectionsText(uo: UnitOpNode, names: readonly string[]): string | undefined {
  const blocks: string[] = [];
  for (const name of names) {
    const body = uo.sections[name];
    if (body === undefined || isPlaceholderBody(name, body)) continue;
    blocks.push(`#### ${name}\n${body}`);
  }
  return blocks.length > 0 ? [uo.heading, ...blocks].join('\n\n') : undefined;
}

function targetSections(uo: UnitOpNode): readonly string[] {
  if (uo.kind === 'hw') return PLANNING_SECTIONS_HW;
  const base = uo.kind === 'sw' ? PLANNING_SECTIONS_SW.filter(s => s !== 'Environment') : PLANNING_SECTIONS_HW;
  return 'Environment' in uo.sections ? [...base, 'Environment'] : base;
}

/** The target heading plus the current content of every planning section; placeholders are "(empty)". */
function targetText(uo: UnitOpNode): string {
  const blocks = targetSections(uo).map(name => {
    const body = uo.sections[name];
    return `#### ${name}\n${body === undefined || isPlaceholderBody(name, body) ? '(empty)' : body}`;
  });
  return [uo.heading, ...blocks].join('\n\n');
}

// ---------------------------------------------------------------- samples

interface SampleHit {
  type: string;
  id: string;
  folder: string;
  where: 'local' | 'global';
  record: SampleRecord;
}

/** The sample type of `id` among `types` (the longest that fits, so `DNA` never shadows `DNAx`). */
function typeOf(id: string, types: readonly string[]): string | undefined {
  let best: string | undefined;
  for (const t of types) {
    const m = new RegExp(`^(?:${buildSampleIdPattern(t).source})$`).exec(id);
    if (m && (!best || t.length > best.length)) best = t;
  }
  return best;
}

/**
 * Registry lookups limited to the scope folder's local `resources/labsamples`
 * and the global registry; never another experiment's registry.
 */
function sampleLookup(fs: LabnoteFs, scopeFolder: string, globalFolder: string | undefined) {
  const local = `${scopeFolder}/resources/labsamples`;
  const folders: { folder: string; where: 'local' | 'global' }[] = [{ folder: local, where: 'local' }];
  if (globalFolder && pathKey(globalFolder) !== pathKey(local)) folders.push({ folder: globalFolder, where: 'global' });
  const cache = new Map<string, Promise<Record<string, SampleRecord>>>();
  const load = (folder: string, type: string) => {
    const key = `${folder}\u0000${type}`;
    let p = cache.get(key);
    if (!p) {
      p = loadSamplesByType(fs, folder, type).catch(() => ({}));
      cache.set(key, p);
    }
    return p;
  };
  return async (type: string, id: string): Promise<SampleHit | undefined> => {
    for (const { folder, where } of folders) {
      const db = await load(folder, type);
      if (Object.prototype.hasOwnProperty.call(db, id)) return { type, id, folder, where, record: db[id] };
    }
    return undefined;
  };
}

function sampleText(hit: SampleHit): string {
  const r = hit.record;
  const lines = [`${hit.id} (${hit.type}, ${hit.where} registry)`];
  if (r.alias) lines.push(`alias: ${r.alias}`);
  const desc = (r.descriptions ?? []).filter(d => typeof d === 'string' && d.trim() !== '');
  if (desc.length > 0) lines.push(`description: ${desc.join('; ')}`);
  if (r.location) lines.push(`location: ${r.location}`);
  if (r.discarded) lines.push(`discarded: ${r.discarded}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------- catalog

function catalogText(opId: string, def: CatalogDefinition): string {
  const lines = [`${opId} ${def.name}`.trim()];
  if (def.description) lines.push(`description: ${def.description}`);
  if (def.equipment) lines.push(`equipment: ${def.equipment}`);
  if (def.software) lines.push(`software: ${def.software}`);
  return lines.join('\n');
}

let coreTools: ToolDef[] | undefined;

/** A catalog that runs the core `get_unit_operation` tool, so a vault whose catalog was updated is honoured. */
export function catalogFromTools(toolCtx: ToolContext): BuildInput['catalog'] {
  return async opId => {
    coreTools ??= createLabnoteTools();
    const res = await runTool(coreTools, 'get_unit_operation', toolCtx, { opId });
    if (!res.ok || !res.data || typeof res.data !== 'object') return undefined;
    const d = res.data as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);
    const name = str(d.name);
    if (!name) return undefined;
    return { name, description: str(d.description), equipment: str(d.equipment), software: str(d.software) };
  };
}

// ---------------------------------------------------------------- builder

function findTarget(chain: ExperimentChain, target: UnitOpTarget | undefined): { wf: number; uo: UnitOpNode } | undefined {
  if (!target) return undefined;
  const wf = chain.workflows.findIndex(w => pathKey(w.path) === pathKey(target.workflowPath));
  if (wf === -1) return undefined;
  const uo = chain.workflows[wf].unitOps.find(u => u.index === target.unitOpIndex);
  return uo ? { wf, uo } : undefined;
}

/** Outline of a named experiment: goal plus workflow/unit-op outline. Never its samples. */
async function namedSource(input: BuildInput, folder: string, distance: number): Promise<ContextSource> {
  const chain = await buildChain(input.fs, folder, { customTypes: input.customTypes });
  const parts = [`Experiment ${folder}`];
  if (chain.goal) parts.push(chain.goal);
  for (const wf of chain.workflows) parts.push(workflowOutline(wf));
  const readmeTitle = await readmeTitleOf(input.fs, chain.readmePath);
  return source(`named:${chain.folder}`, 'named', parts.join('\n\n'), {
    label: readmeTitle ?? folder,
    path: chain.readmePath,
    distance,
  });
}

async function readmeTitleOf(fs: LabnoteFs, readmePath: string | undefined): Promise<string | undefined> {
  if (!readmePath) return undefined;
  try {
    const text = await fs.read(readmePath);
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    const t = fm ? /^title:\s*(.+?)\s*$/m.exec(fm[1])?.[1] : undefined;
    return t?.replace(/^["']|["']$/g, '') || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The context of one experiment folder (spec §5.1-5.3): sources in render
 * order, then fitted into `budgetTokens` by `applyBudget`.
 */
export async function buildContext(input: BuildInput): Promise<BuiltContext> {
  const { fs, scope } = input;
  const types = [...SAMPLE_TYPES, ...(input.customTypes ?? [])];
  const chain = await buildChain(fs, scope.folder, { customTypes: input.customTypes });
  const found = findTarget(chain, input.target);
  const target = found?.uo;
  const sources: ContextSource[] = [];
  const uoById = new Map<string, UnitOpNode>();
  const wfOf = new Map(chain.workflows.flatMap(w => w.unitOps.map(u => [u, w] as const)));

  // 1. Goal.
  if (chain.goal) {
    sources.push(source('readme:goal', 'goal', chain.goal, { label: 'README goal', path: chain.readmePath }));
  }

  // 2. Earlier workflows (all of them without a target), as outlines.
  const wfEnd = found ? found.wf : chain.workflows.length;
  for (let w = 0; w < wfEnd; w++) {
    const wf = chain.workflows[w];
    sources.push(
      source(`wf:${wf.path}`, 'workflow', workflowOutline(wf), {
        label: wf.label,
        path: wf.path,
        distance: wfEnd - w,
      })
    );
  }

  // 3. Earlier unit ops: the last one of the previous workflow, then the current workflow's, in chain order.
  const earlier: UnitOpNode[] = [];
  if (found) {
    for (let w = found.wf - 1; w >= 0; w--) {
      const ops = chain.workflows[w].unitOps;
      if (ops.length > 0) {
        earlier.push(ops[ops.length - 1]);
        break;
      }
    }
    earlier.push(...chain.workflows[found.wf].unitOps.filter(u => u.index < found.uo.index));
  }
  const unitOpSources: ContextSource[] = [];
  earlier.forEach((uo, k) => {
    const distance = earlier.length - k;
    const id = uoId(uo);
    uoById.set(id, uo);
    const label = unitOpLabel(uo, wfOf.get(uo));
    const text = sectionsText(uo, CONTEXT_SECTIONS) ?? uo.heading;
    unitOpSources.push(source(id, 'unitOp', text, { label, path: uo.workflowPath, heading: uo.heading, distance }));
    const results = sectionsText(uo, RESULT_SECTIONS);
    if (results !== undefined) {
      unitOpSources.push(
        source(`${id}:results`, 'results', results, {
          label: `${label} (results)`,
          path: uo.workflowPath,
          heading: uo.heading,
          distance,
          included: input.includeResults === true,
          ...(input.includeResults ? {} : { reason: 'default' as const }),
        })
      );
    }
  });
  sources.push(...unitOpSources);

  // 4. Named folders: outlines only, never samples.
  const seenNamed = new Set([pathKey(scope.folder)]);
  let namedDistance = 0;
  for (const folder of scope.named) {
    const key = pathKey(folder);
    if (seenNamed.has(key)) continue;
    seenNamed.add(key);
    sources.push(await namedSource(input, folder.replace(/\\/g, '/').replace(/\/+$/, ''), ++namedDistance));
  }

  // 5. Samples: previous Output, then the target's Input and Output.
  const previous = target ? previousUnitOp(chain, { workflowPath: target.workflowPath, unitOpIndex: target.index }) : undefined;
  const lookup = sampleLookup(fs, chain.folder, input.globalSampleFolder);
  const sampleIds = [...new Set([...(previous?.outputIds ?? []), ...(target?.inputIds ?? []), ...(target?.outputIds ?? [])])];
  const hits = new Map<string, SampleHit>();
  for (const id of sampleIds) {
    if (hits.size >= MAX_SAMPLE_SOURCES) break;
    const type = typeOf(id, types);
    if (!type) continue;
    const hit = await lookup(type, id);
    if (hit) hits.set(id, hit);
  }
  let sampleIndex = 0;
  for (const hit of hits.values()) {
    sources.push(
      source(`sample:${hit.type}:${hit.id}`, 'sample', sampleText(hit), {
        label: hit.record.alias ? `${hit.id} (${hit.record.alias})` : hit.id,
        path: `${hit.folder}/${hit.type}.json`,
        distance: ++sampleIndex,
      })
    );
  }

  // 6. Catalog: the target op (required), then every op of the earlier unit ops.
  const opIds: { opId: string; required: boolean }[] = [];
  const seenOps = new Set<string>();
  for (const [uo, required] of [...(target ? [[target, true] as const] : []), ...earlier.map(u => [u, false] as const)]) {
    const key = uo.opId.toUpperCase();
    if (!uo.opId || seenOps.has(key)) continue;
    seenOps.add(key);
    opIds.push({ opId: uo.opId, required });
  }
  for (const { opId, required } of opIds) {
    let def: CatalogDefinition | undefined;
    try {
      def = await input.catalog(opId);
    } catch {
      def = undefined;
    }
    if (!def) continue;
    sources.push(
      source(`catalog:${opId}`, 'catalog', catalogText(opId, def), {
        label: `${opId} ${def.name}`.trim(),
        required,
      })
    );
  }

  // 7. Input prefill: the previous Output IDs with their registry names (no LLM).
  if (target && previous && previous.outputIds.length > 0) {
    const lines: string[] = [];
    for (const id of previous.outputIds) {
      const type = typeOf(id, types);
      const hit = hits.get(id) ?? (type ? await lookup(type, id) : undefined);
      lines.push(hit?.record.alias ? `- ${id} — ${hit.record.alias}` : `- ${id}`);
    }
    sources.push(
      source('target:input-prefill', 'prefill', [`Input from the previous Output (${previous.workflowPath}, ${previous.heading}):`, ...lines].join('\n'), {
        label: unitOpLabel(previous, wfOf.get(previous)),
        path: previous.workflowPath,
        heading: previous.heading,
      })
    );
  }

  // 8. Target last.
  if (target) {
    sources.push(
      source('target', 'target', targetText(target), {
        label: unitOpLabel(target, wfOf.get(target)),
        path: target.workflowPath,
        heading: target.heading,
        required: true,
      })
    );
  }

  // The user's unticks.
  const exclude = new Set(input.exclude ?? []);
  const selected = sources.map(s =>
    exclude.has(s.id) && !s.required ? { ...s, included: false, reason: 'user' as const } : s
  );

  const budgeted = applyBudget(selected, input.budgetTokens, id => uoById.get(id));
  return { ...budgeted, scope, chain, target, issues: chain.issues };
}

// ---------------------------------------------------------------- rendering

/** A JSON string with `<` and `>` escaped too, so an attribute can never look like a fence. */
function attr(value: string): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}

/** Note text with `<<source` / `<</source>>` escaped, so a note cannot open or close a block. */
function escapeFences(text: string): string {
  return text.replace(/<<(\/?source)/gi, '<\\<$1');
}

/**
 * The included sources as `<<source id=… path=… heading=…>>` blocks, in the
 * order of spec §5.3 (the builder's source order). Text inside is data, not
 * instructions; the planning prompt says so.
 */
export function renderContext(ctx: BuiltContext): string {
  return ctx.sources
    .filter(s => s.included)
    .map(s => {
      const attrs = [`id=${attr(s.id)}`];
      if (s.path) attrs.push(`path=${attr(s.path)}`);
      if (s.heading) attrs.push(`heading=${attr(s.heading)}`);
      if (s.mode !== 'verbatim') attrs.push(`mode=${attr(s.mode)}`);
      return `<<source ${attrs.join(' ')}>>\n${escapeFences(s.text)}\n<</source>>`;
    })
    .join('\n\n');
}
