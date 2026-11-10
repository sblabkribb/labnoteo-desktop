// Read-only agent tools over one experiment folder (spec §9): list_experiment,
// search_experiment and read_note. Every path goes through assertInScope;
// another experiment is reachable only when the user named it (in-app:
// `allowedFolders` from scopeGate) or the call names it (MCP, no
// `allowedFolders`). None of them writes.
import type { LabnoteFs, ToolContext, ToolDef, ToolResult } from '@labnoteo/core';
import { listUnitOpBlocks } from '@labnoteo/core';
import { listHeadings, normalizeHeadingText } from '../../../vendor/labnoteo/packages/labnoteo-core/src/sections/sectionEdit';
import type { SearchResults } from '../../search/indexApi';
import { experimentReadmes } from '../port/experiments';
import { buildChain, canonicalSection, MAX_FILE_BYTES, MAX_WORKFLOW_FILES } from './chain';
import { assertInScope, experimentFolderOf, findExperiment, ScopeError, type ExperimentRef, type Scope } from './scope';

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

/**
 * The experiment a call works in: the named `experiment` (allowed in-app only
 * when it is the current one or the user named it), else `ctx.scope`.
 * Undefined when there is neither. Throws ScopeError.
 */
export async function toolScope(ctx: ScopedToolContext, args: Record<string, unknown>): Promise<Scope | undefined> {
  const name = nameArg(args);
  if (name === undefined) return ctx.scope;
  const ref = findExperiment(name, await experimentsOf(ctx));
  if (ctx.scope && sameFolder(ref.folder, ctx.scope.folder)) return ctx.scope;
  if (ctx.allowedFolders !== undefined && ![...ctx.allowedFolders].some(f => sameFolder(f, ref.folder))) {
    throw new ScopeError('outOfScope', [name, ctx.scope?.folder ?? '']);
  }
  return { folder: ref.folder, explicit: true, named: [] };
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

// ---------------------------------------------------------------- defs

const EXPERIMENT_ARG = {
  type: 'string',
  description: 'Experiment number, folder name or title. Omit for the current experiment; name another only when the user did.',
};

/** The read-only context tools (spec §9). Their handlers take a {@link ScopedToolContext}. */
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
  ];
}
