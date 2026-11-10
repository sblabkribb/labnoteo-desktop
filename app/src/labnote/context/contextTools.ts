// Read-only agent tools over one experiment folder (spec §9, §10.1):
// list_experiment, search_experiment, read_note, and the context tools
// get_experiment_context and get_unit_operation_context over the shared
// builder. Every path goes through assertInScope; another experiment is
// reachable only when the user named it (in-app: `allowedFolders` from
// scopeGate) or the call names it (MCP, no `allowedFolders`, by `experiment`
// or `notePath`). None of them writes.
import type { LabnoteFs, ToolContext, ToolDef, ToolResult } from '@labnoteo/core';
import { listUnitOpBlocks } from '@labnoteo/core';
import { listHeadings, normalizeHeadingText } from '../../../vendor/labnoteo/packages/labnoteo-core/src/sections/sectionEdit';
import type { SearchResults } from '../../search/indexApi';
import { experimentReadmes } from '../port/experiments';
import { buildChain, canonicalSection, MAX_FILE_BYTES, MAX_WORKFLOW_FILES, previousUnitOp, type UnitOpNode } from './chain';
import { buildContext, catalogFromTools, registryAliases, renderContext, type BuildInput, type BuiltContext } from './contextBuilder';
import { draftableSections, PLANNING_RULES } from './planningPrompt';
import { prefillInput } from './prefill';
import { assertInScope, experimentFolderOf, findExperiment, resolveScope, ScopeError, type ExperimentRef, type Scope } from './scope';

/** Core `ToolContext` plus what the scoped tools need (spec §9). */
export interface ScopedToolContext extends ToolContext {
  /** In-app: the active note's experiment. MCP: unset (every call names its experiment). */
  scope?: Scope;
  /** In-app: the folders the user's message named (`scopeGate`). Unset on MCP, where every name is explicit. */
  allowedFolders?: ReadonlySet<string>;
  /** Experiment folders and titles; defaults to `experimentReadmes` over `fs`. */
  experiments?: () => Promise<ExperimentRef[]>;
  /** Folder-filtered full-text search (`searchNotesIn`); the tools fall back to a scan without it. */
  searchIn?: (query: string, prefix: string, limit: number) => Promise<SearchResults>;
}

/** Characters of a note or section `read_note` returns, as core `read_section`. */
export const READ_NOTE_LIMIT = 20000;
/** Hits whose nearest heading is looked up. */
export const HEADING_LOOKUPS = 20;
/** Characters of the README goal `list_experiment` returns. */
export const GOAL_EXCERPT_CHARS = 600;
const SEARCH_LIMIT_DEFAULT = 20;
const SEARCH_LIMIT_MAX = 50;

const folderKey = (p: string): string =>
  p.normalize('NFC').replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, '').toLowerCase();

const sameFolder = (a: string, b: string): boolean => folderKey(a) === folderKey(b);

function utf8Bytes(text: string): number {
  if (text.length * 3 <= MAX_FILE_BYTES) return text.length;
  if (text.length > MAX_FILE_BYTES) return text.length;
  return new TextEncoder().encode(text).length;
}

/** The English sentence for the model; the user reads `scopeErrorText` (appTools.ts). */
export function scopeErrorMessage(code: string, params: readonly string[]): string {
  const [a = '', b = ''] = params;
  switch (code) {
    case 'outOfScope':
      return `${a} is outside the current experiment ${b}. Another experiment may be used only when the user names it.`;
    case 'scopeRequired':
      return `Name the experiment with the "experiment" argument (number, folder name or title). Experiments: ${params.join(', ') || 'none'}.`;
    case 'noExperiment':
      return 'The active note is not in an experiment folder (labnote/NNN_Name); name an experiment.';
    case 'unknownExperiment':
      return `No experiment matches "${a}".`;
    case 'ambiguousExperiment':
      return `"${a}" matches several experiments: ${params.slice(1).join(', ')}. Use the folder name.`;
    default:
      return code;
  }
}

/** A refused call carrying the scope code and params. */
export function scopeFailure(err: ScopeError): ToolResult {
  return { ok: false, error: scopeErrorMessage(err.code, err.params), code: err.code, params: [...err.params] };
}

async function experimentsOf(ctx: ScopedToolContext): Promise<ExperimentRef[]> {
  const list = ctx.experiments ? await ctx.experiments() : await experimentReadmes({ fs: ctx.fs });
  return list.map(e => ({ folder: e.folder, title: e.title }));
}

function nameArg(args: Record<string, unknown>): string | undefined {
  const v = args.experiment;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v).padStart(3, '0');
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** The experiment folder of `notePath` (an explicit note of a call), through resolveScope. Throws ScopeError. */
function folderOfNote(notePath: string, experiments: readonly ExperimentRef[]): string {
  return resolveScope({ activePath: notePath }, experiments).folder;
}

/** In-app, `folder` is allowed when it is the current experiment or one the user named; MCP allows any. */
function gate(ctx: ScopedToolContext, folder: string, asked: string): void {
  if (ctx.scope && sameFolder(folder, ctx.scope.folder)) return;
  if (ctx.allowedFolders !== undefined && ![...ctx.allowedFolders].some(f => sameFolder(f, folder))) {
    throw new ScopeError('outOfScope', [asked, ctx.scope?.folder ?? '']);
  }
}

/**
 * The experiment a call works in: the named `experiment` or the experiment of
 * `notePath` (both given must agree; allowed in-app only when it is the
 * current one or the user named it), else `ctx.scope`. Undefined when there
 * is none of them. Throws ScopeError.
 */
export async function toolScope(ctx: ScopedToolContext, args: Record<string, unknown>): Promise<Scope | undefined> {
  const name = nameArg(args);
  const notePath = str(args, 'notePath');
  if (name === undefined && notePath === undefined) return ctx.scope;
  const experiments = await experimentsOf(ctx);
  const byName = name !== undefined ? findExperiment(name, experiments).folder : undefined;
  const byNote = notePath !== undefined ? folderOfNote(notePath, experiments) : undefined;
  if (byName !== undefined && byNote !== undefined && !sameFolder(byName, byNote)) {
    throw new ScopeError('ambiguousExperiment', [name ?? '', byName, byNote]);
  }
  const folder = (byName ?? byNote)!;
  gate(ctx, folder, name ?? notePath ?? folder);
  if (ctx.scope && sameFolder(folder, ctx.scope.folder)) return ctx.scope;
  return { folder, explicit: true, named: [] };
}

async function requiredScope(ctx: ScopedToolContext, args: Record<string, unknown>): Promise<Scope> {
  const scope = await toolScope(ctx, args);
  if (!scope) throw new ScopeError('scopeRequired', (await experimentsOf(ctx)).map(e => e.folder));
  if (!experimentFolderOf(scope.folder)) throw new ScopeError('noExperiment', [scope.folder]);
  return scope;
}

/** `scope` plus the folders the user named: what a path argument may point into. */
function withAllowed(ctx: ScopedToolContext, scope: Scope): Scope {
  const named = [...scope.named, ...(ctx.allowedFolders ?? [])].filter(f => !sameFolder(f, scope.folder));
  return { ...scope, named };
}

function str(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** Wraps a handler so a ScopeError becomes a coded refusal. */
function scoped(run: (ctx: ScopedToolContext, args: Record<string, unknown>) => Promise<ToolResult>): ToolDef['handler'] {
  return async (ctx, args) => {
    try {
      return await run(ctx as ScopedToolContext, args);
    } catch (err) {
      if (err instanceof ScopeError) return scopeFailure(err);
      throw err;
    }
  };
}

// ---------------------------------------------------------------- list

async function listExperiment(ctx: ScopedToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const scope = await toolScope(ctx, args);
  const experiments = await experimentsOf(ctx);
  if (!scope) return { ok: true, data: { experiments } };
  if (!experimentFolderOf(scope.folder)) throw new ScopeError('noExperiment', [scope.folder]);
  const depth = args.depth === 'workflows' ? 'workflows' : 'unitOps';
  const chain = await buildChain(ctx.fs, scope.folder, { customTypes: ctx.customTypes });
  const title = experiments.find(e => sameFolder(e.folder, scope.folder))?.title ?? scope.folder.split('/').pop() ?? scope.folder;
  const goal = chain.goal.length > GOAL_EXCERPT_CHARS ? `${chain.goal.slice(0, GOAL_EXCERPT_CHARS)}…` : chain.goal;
  return {
    ok: true,
    data: {
      folder: chain.folder,
      title,
      goalExcerpt: goal,
      workflows: chain.workflows.map(w => ({
        path: w.path,
        label: w.label,
        listed: w.listed,
        done: w.done,
        legacy: w.legacy,
        ...(depth === 'unitOps'
          ? {
              unitOps: w.unitOps.map(u => ({
                index: u.index,
                heading: u.heading,
                opId: u.opId,
                inputIds: u.inputIds,
                outputIds: u.outputIds,
              })),
            }
          : {}),
      })),
      issues: chain.issues,
    },
  };
}

// ---------------------------------------------------------------- search

interface Hit {
  path: string;
  title: string;
  snippet: string;
  heading?: string;
}

const titleOf = (path: string): string => (path.split('/').pop() ?? path).replace(/(\.labnote)?\.md$/i, '');

/** Where `query` (else its longest word) first occurs in `text`, case-insensitively; -1 when nowhere. */
function matchAt(text: string, query: string): number {
  const hay = text.normalize('NFC').toLowerCase();
  const q = query.normalize('NFC').toLowerCase();
  const at = hay.indexOf(q);
  if (at !== -1) return at;
  const word = q
    .split(/\s+/)
    .filter(w => [...w].length >= 2)
    .sort((x, y) => y.length - x.length)[0];
  return word ? hay.indexOf(word) : -1;
}

/** The nearest `###`/`####` heading above offset `at` (outside code fences), without its `#`s. */
function headingAbove(text: string, at: number): string | undefined {
  const line = text.normalize('NFC').slice(0, at).split(/\r?\n/).length - 1;
  let found: string | undefined;
  for (const h of listHeadings(text.normalize('NFC'))) {
    if (h.line > line) break;
    if (h.level === 3 || h.level === 4) found = h.text;
  }
  return found;
}

function snippetAt(text: string, at: number): string {
  const norm = text.normalize('NFC');
  const start = Math.max(0, at - 60);
  const end = Math.min(norm.length, at + 100);
  const body = norm.slice(start, end).replace(/\s+/g, ' ').trim();
  return (start > 0 ? '…' : '') + body + (end < norm.length ? '…' : '');
}

async function readCapped(fs: LabnoteFs, path: string): Promise<string | undefined> {
  try {
    const text = await fs.read(path);
    return utf8Bytes(text) > MAX_FILE_BYTES ? undefined : text;
  } catch {
    return undefined;
  }
}

/** The `.md` notes under `folder` (dot folders skipped), at most `cap`, and whether more were left out. */
async function notesUnder(fs: LabnoteFs, folder: string, cap: number): Promise<{ paths: string[]; more: boolean }> {
  const paths: string[] = [];
  const dirs = [folder];
  while (dirs.length > 0) {
    const dir = dirs.shift()!;
    let names: string[];
    try {
      names = [...(await fs.list(dir))].sort();
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.startsWith('.')) continue;
      if (/\.md$/i.test(name)) {
        if (paths.length >= cap) return { paths, more: true };
        paths.push(`${dir}/${name}`);
      } else if (!name.includes('.')) {
        dirs.push(`${dir}/${name}`);
      }
    }
  }
  return { paths, more: false };
}

/** The fallback when the index is not available: a case-insensitive substring scan. */
async function scanFolder(fs: LabnoteFs, scope: Scope, query: string, limit: number): Promise<{ hits: Hit[]; truncated: boolean }> {
  const { paths, more } = await notesUnder(fs, scope.folder, MAX_WORKFLOW_FILES);
  const hits: Hit[] = [];
  const q = query.normalize('NFC').toLowerCase();
  for (const path of paths) {
    const text = await readCapped(fs, path);
    if (text === undefined) continue;
    const at = text.normalize('NFC').toLowerCase().indexOf(q);
    if (at === -1) continue;
    if (hits.length >= limit) return { hits, truncated: true };
    hits.push({
      path,
      title: titleOf(path),
      snippet: snippetAt(text, at),
      ...(hits.length < HEADING_LOOKUPS ? withHeading(headingAbove(text, at)) : {}),
    });
  }
  return { hits, truncated: more };
}

const withHeading = (heading: string | undefined): { heading?: string } => (heading ? { heading } : {});

function clampLimit(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : SEARCH_LIMIT_DEFAULT;
  return Math.min(SEARCH_LIMIT_MAX, Math.max(1, n));
}

async function searchExperiment(ctx: ScopedToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const query = str(args, 'query');
  if (!query || [...query].length < 2) return { ok: false, error: 'query needs at least 2 characters' };
  const scope = await requiredScope(ctx, args);
  const only: Scope = { ...scope, named: [] };
  const limit = clampLimit(args.limit);
  const inScope = (path: string): string | undefined => {
    try {
      return assertInScope(only, path);
    } catch {
      return undefined;
    }
  };

  let result: { hits: Hit[]; truncated: boolean };
  try {
    if (!ctx.searchIn) throw new Error('no index');
    const found = await ctx.searchIn(query, scope.folder, limit);
    // Rust filters by the prefix already; this re-check is the second wall (spec §13).
    const inside = found.hits.filter(h => inScope(h.path) !== undefined);
    const kept: Hit[] = inside.slice(0, limit).map(h => ({ path: h.path, title: h.title, snippet: h.snippet }));
    for (const h of kept.slice(0, HEADING_LOOKUPS)) {
      const text = await readCapped(ctx.fs, h.path);
      if (text === undefined) continue;
      const at = matchAt(text, query);
      if (at !== -1) Object.assign(h, withHeading(headingAbove(text, at)));
    }
    result = { hits: kept, truncated: found.truncated || inside.length > kept.length };
  } catch {
    result = await scanFolder(ctx.fs, only, query, limit);
  }
  return { ok: true, data: result };
}

// ---------------------------------------------------------------- read

const clip = (text: string): { content: string; truncated: boolean } =>
  text.length > READ_NOTE_LIMIT ? { content: text.slice(0, READ_NOTE_LIMIT), truncated: true } : { content: text, truncated: false };

const headingText = (line: string): string => line.replace(/^\s{0,3}#+\s*/, '').replace(/\s+#+\s*$/, '');

/** The unit-op block `wanted` names: heading text, opId, catalog name, alias or a 1-based number; first match. */
function findBlock(md: string, lines: string[], wanted: string) {
  const blocks = listUnitOpBlocks(md);
  if (/^\d+$/.test(wanted)) return blocks.find(b => b.index === Number(wanted));
  const key = normalizeHeadingText(headingText(wanted).normalize('NFC'));
  return blocks.find(
    b =>
      normalizeHeadingText(headingText(lines[b.headingLine] ?? '').normalize('NFC')) === key ||
      b.opId.toLowerCase() === key ||
      normalizeHeadingText(b.opName) === key ||
      (b.alias !== '' && normalizeHeadingText(b.alias.normalize('NFC')) === key)
  );
}

const sectionKey = (name: string): string => canonicalSection(name) ?? normalizeHeadingText(name.normalize('NFC'));

async function readNote(ctx: ScopedToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const raw = str(args, 'path');
  if (!raw) return { ok: false, error: 'path is required' };
  const scope = await requiredScope(ctx, args);
  const path = assertInScope(withAllowed(ctx, scope), raw);
  if (!(await ctx.fs.exists(path))) return { ok: false, error: `File not found: ${path}` };
  const md = await ctx.fs.read(path);
  if (utf8Bytes(md) > MAX_FILE_BYTES) return { ok: false, error: `${path} is larger than 2 MB` };
  const lines = md.split(/\r?\n/);

  const unitOp = str(args, 'unitOp');
  const section = str(args, 'section');
  let from = 0;
  let to = lines.length;
  let unitOpHeading: string | undefined;
  if (unitOp) {
    const block = findBlock(md, lines, unitOp);
    if (!block) return { ok: false, error: `No unit operation "${unitOp}" in ${path}` };
    from = block.headingLine;
    to = block.endLine;
    unitOpHeading = lines[block.headingLine];
  }
  if (!section) {
    const text = lines.slice(from, to).join('\n');
    return {
      ok: true,
      data: {
        path,
        ...(unitOpHeading !== undefined ? { unitOp: unitOpHeading } : {}),
        ...(unitOp ? {} : { headings: listHeadings(md).map(h => `${'#'.repeat(h.level)} ${h.text}`) }),
        ...clip(text),
      },
    };
  }
  const headings = listHeadings(md).filter(h => h.line >= from && h.line < to && (!unitOp || h.line > from));
  const wanted = sectionKey(section);
  const at = headings.findIndex(h => sectionKey(h.text) === wanted);
  if (at === -1) return { ok: false, error: `No "${section}" section${unitOp ? ` in unit operation "${unitOp}"` : ''} of ${path}` };
  const h = headings[at];
  const next = headings.slice(at + 1).find(n => n.level <= h.level);
  const body = lines.slice(h.line + 1, next ? next.line : to).join('\n');
  return {
    ok: true,
    data: {
      path,
      ...(unitOpHeading !== undefined ? { unitOp: unitOpHeading } : {}),
      section: h.text,
      ...clip(body),
    },
  };
}

// ---------------------------------------------------------------- context (MCP, spec §10.1)

/** `maxTokens` bounds and default of the context tools. */
export const MAX_TOKENS_MIN = 1024;
export const MAX_TOKENS_MAX = 200000;
export const MAX_TOKENS_DEFAULT = 16000;

function clampMaxTokens(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : MAX_TOKENS_DEFAULT;
  return Math.min(MAX_TOKENS_MAX, Math.max(MAX_TOKENS_MIN, n));
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map(x => x.trim()) : [];
}

/** The folders of `named` other than the scope's (in-app: only ones the user named). Throws ScopeError. */
async function namedFolders(ctx: ScopedToolContext, scope: Scope, names: readonly string[]): Promise<string[]> {
  if (names.length === 0) return [];
  const experiments = await experimentsOf(ctx);
  const out: string[] = [];
  for (const name of names) {
    const folder = findExperiment(name, experiments).folder;
    if (sameFolder(folder, scope.folder) || out.some(f => sameFolder(f, folder))) continue;
    gate(ctx, folder, name);
    out.push(folder);
  }
  return out;
}

/** The fields both context tools return. Sources without their text: `text` holds the rendered included ones. */
function contextData(built: BuiltContext): Record<string, unknown> {
  return {
    scope: { folder: built.scope.folder, named: [...built.scope.named] },
    sources: built.sources.map(s => ({
      id: s.id,
      kind: s.kind,
      label: s.label,
      ...(s.path !== undefined ? { path: s.path } : {}),
      ...(s.heading !== undefined ? { heading: s.heading } : {}),
      mode: s.mode,
      tokens: s.tokens,
      included: s.included,
      ...(s.reason !== undefined ? { reason: s.reason } : {}),
    })),
    text: renderContext(built),
    totalTokens: built.totalTokens,
    budget: built.budget,
    overBudget: built.overBudget,
    trimmed: built.trimmed,
    issues: built.issues,
    rules: PLANNING_RULES,
  };
}

function buildInput(ctx: ScopedToolContext, scope: Scope, args: Record<string, unknown>): Omit<BuildInput, 'target'> {
  return {
    fs: ctx.fs,
    scope,
    includeResults: args.includeResults === true,
    budgetTokens: clampMaxTokens(args.maxTokens),
    exclude: stringList(args.exclude),
    customTypes: ctx.customTypes,
    globalSampleFolder: ctx.globalSampleFolder,
    catalog: catalogFromTools(ctx),
  };
}

async function getExperimentContext(ctx: ScopedToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const base = await requiredScope(ctx, args);
  const named = await namedFolders(ctx, base, stringList(args.named));
  const scope: Scope = { ...base, named };
  const built = await buildContext({ ...buildInput(ctx, scope, args), exclude: [] });
  return { ok: true, data: contextData(built) };
}

/** The unit op `wanted` names among `ops`: a 1-based number, heading text, opId, title or alias; first match. */
function pickUnitOp(ops: readonly UnitOpNode[], wanted: unknown): UnitOpNode | undefined {
  if (wanted === undefined || wanted === null || (typeof wanted === 'string' && wanted.trim() === '')) return ops[ops.length - 1];
  if (typeof wanted === 'number') return Number.isInteger(wanted) ? ops[wanted - 1] : undefined;
  if (typeof wanted !== 'string') return undefined;
  const text = wanted.trim();
  if (/^\d+$/.test(text)) return ops[Number(text) - 1];
  const key = normalizeHeadingText(headingText(text).normalize('NFC'));
  return ops.find(
    u =>
      normalizeHeadingText(headingText(u.heading).normalize('NFC')) === key ||
      u.opId.toLowerCase() === key ||
      (u.title !== '' && normalizeHeadingText(u.title.normalize('NFC')) === key) ||
      (u.alias !== '' && normalizeHeadingText(u.alias.normalize('NFC')) === key)
  );
}

async function getUnitOperationContext(ctx: ScopedToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const raw = str(args, 'notePath');
  const scope = await requiredScope(ctx, args);
  if (!raw) return { ok: false, error: 'notePath is required' };
  const notePath = assertInScope({ ...scope, named: [] }, raw);
  const chain = await buildChain(ctx.fs, scope.folder, { customTypes: ctx.customTypes });
  const key = folderKey(notePath);
  const wf = chain.workflows.find(w => folderKey(w.path) === key);
  if (!wf) return { ok: false, error: `${notePath} is not a workflow note of ${scope.folder}` };
  if (wf.unitOps.length === 0) return { ok: false, error: `${notePath} has no unit operations` };
  const uo = pickUnitOp(wf.unitOps, args.unitOp);
  if (!uo) return { ok: false, error: `No unit operation "${String(args.unitOp)}" in ${notePath}` };

  const target = { workflowPath: uo.workflowPath, unitOpIndex: uo.index };
  const previous = previousUnitOp(chain, target);
  const names = await registryAliases(ctx.fs, scope.folder, ctx.globalSampleFolder, previous?.outputIds ?? [], ctx.customTypes);
  const prefill = prefillInput(chain, target, id => names.get(id));
  const built = await buildContext({ ...buildInput(ctx, scope, args), target });
  return {
    ok: true,
    data: {
      ...contextData(built),
      target: { path: uo.workflowPath, unitOpIndex: uo.index, heading: uo.heading, opId: uo.opId, kind: uo.kind },
      draftableSections: draftableSections(uo, { environment: 'Environment' in uo.sections }),
      prefill,
    },
  };
}

// ---------------------------------------------------------------- defs

const EXPERIMENT_ARG = {
  type: 'string',
  description: 'Experiment number, folder name or title. Omit for the current experiment; name another only when the user did.',
};

/** The read-only context tools (spec §9, §10.1). Their handlers take a {@link ScopedToolContext}. */
export function contextTools(): ToolDef[] {
  return [
    {
      name: 'list_experiment',
      mutates: false,
      description:
        'Outline one experiment folder: its README goal, its workflows in checklist order and their unit operations with the sample IDs of Input and Output, plus problems in the chain. ' +
        'Without a current experiment and without "experiment", it lists the experiment names only.',
      inputSchema: {
        type: 'object',
        properties: {
          experiment: EXPERIMENT_ARG,
          depth: { type: 'string', enum: ['workflows', 'unitOps'], default: 'unitOps' },
        },
      },
      handler: scoped(listExperiment),
    },
    {
      name: 'search_experiment',
      mutates: false,
      description:
        'Full-text search within one experiment folder (never other experiments). Returns matching notes with a snippet and the nearest heading.',
      inputSchema: {
        type: 'object',
        required: ['query'],
        properties: {
          query: { type: 'string', minLength: 2 },
          experiment: EXPERIMENT_ARG,
          limit: { type: 'integer', minimum: 1, maximum: SEARCH_LIMIT_MAX, default: SEARCH_LIMIT_DEFAULT },
        },
      },
      handler: scoped(searchExperiment),
    },
    {
      name: 'read_note',
      mutates: false,
      description:
        'Read a note of the experiment: the whole note, one unit operation (heading text or opId), or one section of it (e.g. "Output"). At most 20000 characters; "truncated" says when there was more.',
      inputSchema: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string', description: 'Vault-relative .md path inside the experiment' },
          unitOp: { type: 'string', description: 'Unit-op heading text or opId (first match)' },
          section: { type: 'string' },
          experiment: EXPERIMENT_ARG,
        },
      },
      handler: scoped(readNote),
    },
    {
      name: 'get_experiment_context',
      mutates: false,
      description:
        'The planning context of one experiment folder: README goal, workflows in checklist order with their unit operations, chain problems, ' +
        'rendered as <<source>> blocks within maxTokens, plus the planning rules. Name the experiment or a note in it; other experiments only in "named", and only ones the user named. ' +
        'Never write Results & Discussions, QC Metrics, Discussion or Meta.',
      inputSchema: {
        type: 'object',
        properties: {
          experiment: { type: 'string', description: 'Experiment number, folder name or title. Required unless notePath is given.' },
          notePath: { type: 'string', description: 'A vault-relative note inside the experiment' },
          named: { type: 'array', items: { type: 'string' }, description: 'Other experiments to outline; only ones the user named' },
          maxTokens: { type: 'integer', minimum: MAX_TOKENS_MIN, maximum: MAX_TOKENS_MAX, default: MAX_TOKENS_DEFAULT },
          includeResults: { type: 'boolean', default: false },
        },
      },
      handler: scoped(getExperimentContext),
    },
    {
      name: 'get_unit_operation_context',
      mutates: false,
      description:
        'The context for drafting one unit operation: its experiment chain (earlier workflows, earlier unit ops, the previous Output), samples and catalog definitions, ' +
        'the target with its current planning sections, the sections that may be drafted and the Input prefill from the previous Output. ' +
        'Draft only those planning sections; never Results & Discussions, QC Metrics, Discussion or Meta.',
      inputSchema: {
        type: 'object',
        required: ['notePath'],
        properties: {
          notePath: { type: 'string', description: 'Vault-relative workflow note inside the experiment' },
          unitOp: { type: 'string', description: 'Heading text, opId or 1-based index; default: last unit op' },
          maxTokens: { type: 'integer', minimum: MAX_TOKENS_MIN, maximum: MAX_TOKENS_MAX, default: MAX_TOKENS_DEFAULT },
          includeResults: { type: 'boolean', default: false },
          exclude: { type: 'array', items: { type: 'string' }, description: 'source ids to drop' },
        },
      },
      handler: scoped(getUnitOperationContext),
    },
  ];
}
