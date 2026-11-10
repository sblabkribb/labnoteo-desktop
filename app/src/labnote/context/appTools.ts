// The app's agent tool list (spec §9): the core tools plus the read-only
// context tools. In-app (with a scope) every core tool that takes a
// `documentPath` is checked against the experiment before it runs and before
// any approval is asked, and sample lookups stay in the experiment's local
// registry plus the global one. MCP uses the list unscoped (spec §10.1).
import { createLabnoteTools, type ToolContext, type ToolDef, type ToolPreview, type ToolResult } from '@labnoteo/core';
import { t } from '../../i18n/t';
import { contextTools, scopeFailure, type ScopedToolContext } from './contextTools';
import { assertInScope, ScopeError, type Scope } from './scope';

export interface AppToolsOptions {
  scope?: Scope;
  allowedFolders?: ReadonlySet<string>;
}

const folderKey = (p: string): string =>
  p.normalize('NFC').replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, '').toLowerCase();

/** Sample read tools whose missing `documentPath` would search every experiment. */
const SAMPLE_LOOKUPS = new Set(['get_sample', 'list_samples']);

/**
 * `documentPath` checked against `scope` (plus named folders): a note must be
 * a `.md` inside it; any other path (a folder, as `create_workflow` takes) must
 * lie inside it or be the folder itself. Throws `outOfScope` with the path as given.
 */
function checkDocumentPath(scope: Scope, path: string): void {
  try {
    if (/\.md$/i.test(path)) assertInScope(scope, path);
    else assertInScope(scope, `${path.replace(/[\\/]+$/, '')}/__scope__.md`);
  } catch (err) {
    if (err instanceof ScopeError) throw new ScopeError('outOfScope', [path, scope.folder]);
    throw err;
  }
}

function hasDocumentPath(tool: ToolDef): boolean {
  return Object.prototype.hasOwnProperty.call(tool.inputSchema.properties, 'documentPath');
}

/** A core tool refused outside the scope, before its handler or `describe` runs. */
function wrapCore(tool: ToolDef, scope: Scope, pathScope: Scope): ToolDef {
  const refusal = (args: Record<string, unknown>): ToolResult | undefined => {
    const raw = args.documentPath;
    if (typeof raw !== 'string' || !raw.trim()) return undefined;
    try {
      checkDocumentPath(pathScope, raw);
      return undefined;
    } catch (err) {
      if (err instanceof ScopeError) return scopeFailure(err);
      throw err;
    }
  };
  const argsFor = (args: Record<string, unknown>): Record<string, unknown> =>
    SAMPLE_LOOKUPS.has(tool.name) && (typeof args.documentPath !== 'string' || !args.documentPath.trim())
      ? { ...args, documentPath: `${scope.folder}/README.labnote.md` }
      : args;
  const wrapped: ToolDef = {
    ...tool,
    async handler(ctx, args) {
      const refused = refusal(args);
      if (refused) return refused;
      return tool.handler(ctx, argsFor(args));
    },
  };
  if (tool.describe || tool.mutates) {
    wrapped.describe = async (ctx, args) => {
      const refused = refusal(args);
      if (refused) return { error: refused.error ?? 'outOfScope', code: refused.code, params: refused.params };
      return tool.describe ? tool.describe(ctx, argsFor(args)) : (undefined as unknown as ToolPreview);
    };
  }
  return wrapped;
}

/** `search_samples` reads every registry; scoped, only the experiment's local and the global matches are returned. */
function wrapSampleSearch(tool: ToolDef, scope: Scope): ToolDef {
  const own = folderKey(scope.folder);
  return {
    ...tool,
    async handler(ctx, args) {
      const res = await tool.handler(ctx, args);
      if (!res.ok || !res.data || typeof res.data !== 'object') return res;
      const data = res.data as { matches?: Array<{ scope?: string; experiment?: string | null }> };
      if (!Array.isArray(data.matches)) return res;
      const matches = data.matches.filter(m => m.scope === 'global' || (typeof m.experiment === 'string' && folderKey(m.experiment) === own));
      return { ...res, data: { ...data, matches } };
    },
  };
}

/** Context tools that see `opts` when the tool context carries no scope of its own. */
function withDefaults(tool: ToolDef, opts: AppToolsOptions): ToolDef {
  return {
    ...tool,
    handler: (ctx: ToolContext, args) => {
      const c = ctx as ScopedToolContext;
      return tool.handler(
        { ...c, scope: c.scope ?? opts.scope, allowedFolders: c.allowedFolders ?? opts.allowedFolders } as ScopedToolContext,
        args
      );
    },
  };
}

/**
 * Core tools plus {@link contextTools}. With `opts.scope`, core tools taking a
 * `documentPath` are limited to `scope.folder` ∪ `allowedFolders`; without it
 * they are the core tools unchanged.
 */
export function appTools(opts: AppToolsOptions = {}): ToolDef[] {
  const core = createLabnoteTools();
  const ctxTools = contextTools();
  const scope = opts.scope;
  if (!scope) return [...core, ...(opts.allowedFolders ? ctxTools.map(tl => withDefaults(tl, opts)) : ctxTools)];
  const pathScope: Scope = {
    ...scope,
    named: [...scope.named, ...(opts.allowedFolders ?? [])].filter(f => folderKey(f) !== folderKey(scope.folder)),
  };
  return [
    ...core.map(tool => {
      if (tool.name === 'search_samples') return wrapSampleSearch(tool, scope);
      return hasDocumentPath(tool) ? wrapCore(tool, scope, pathScope) : tool;
    }),
    ...ctxTools.map(tl => withDefaults(tl, opts)),
  ];
}

/**
 * The user's wording of a scope refusal (spec §9), in the interface language.
 * Undefined for other codes. Each key is written out for the catalog test.
 */
export function scopeErrorText(code: string, params: readonly string[]): string | undefined {
  const [a = '', b = ''] = params;
  switch (code) {
    case 'outOfScope':
      return t('aiCtx.err.outOfScope', a, b);
    case 'scopeRequired':
      return t('aiCtx.err.scopeRequired', params.join(', '));
    case 'noExperiment':
      return t('aiCtx.err.noExperiment');
    case 'unknownExperiment':
      return t('aiCtx.err.unknownExperiment', a);
    case 'ambiguousExperiment':
      return t('aiCtx.err.ambiguousExperiment', a, params.slice(1).join(', '));
    default:
      return undefined;
  }
}
