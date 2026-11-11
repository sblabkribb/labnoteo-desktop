// MCP prompts filled in the webview (ai-context spec §10.2, plan Task 13).
// Rust lists `draft-unit-operation` and `continue-workflow`, validates a
// `prompts/get` and forwards it as the bridge call `prompt:<name>`; this module
// fills the text from the shared context builder. Scope comes from `notePath`
// only: one experiment folder, never another. The text always carries
// PLANNING_RULES, so the planning-only rule reaches a client that never loaded
// the skill, and KOREAN_TERMS_INSTRUCTION (Workflow / Unit Operation stay in
// English in a Korean answer): the client picks its own reply language. Nothing here writes.
import {
  buildChain,
  canonicalSection,
  PLANNING_SECTIONS_HW,
  type ExperimentChain,
  type UnitOpNode,
  type WorkflowNode,
} from '../context/chain';
import { buildContext, catalogFromTools, registryAliases, renderContext, workflowCatalogFromTools, type BuildInput } from '../context/contextBuilder';
import {
  folderKey,
  MAX_TOKENS_DEFAULT,
  pickUnitOp,
  scopeErrorMessage,
  toolScope,
  type ScopedToolContext,
} from '../context/contextTools';
import { draftableSections, draftableSectionsFor, PLANNING_RULES, planningRequestText } from '../context/planningPrompt';
import { assertInScope, experimentFolderOf, ScopeError, type Scope } from '../context/scope';
import { KOREAN_TERMS_INSTRUCTION } from '../port/aiCommon';

export type PromptReply =
  | { kind: 'result'; result: { description: string; messages: Array<{ role: 'user'; content: { type: 'text'; text: string } }> } }
  | { kind: 'error'; code: number; message: string };

/** JSON-RPC "invalid params": an unknown prompt, a bad scope or a note that cannot be used. */
export const INVALID_PARAMS = -32602;
/** JSON-RPC "internal error": anything unexpected while filling. */
export const INTERNAL_ERROR = -32603;

/** A refusal the caller can fix (`-32602`). */
class PromptError extends Error {}

function fail(message: string): never {
  throw new PromptError(message);
}

function reply(description: string, text: string): PromptReply {
  return { kind: 'result', result: { description, messages: [{ role: 'user', content: { type: 'text', text } }] } };
}

/** The experiment of `notePath` (and nothing else), and the note normalised inside it. Throws ScopeError or PromptError. */
async function noteScope(ctx: ScopedToolContext, args: Record<string, string>): Promise<{ scope: Scope; notePath: string }> {
  const raw = args.notePath?.trim();
  if (!raw) fail('Missing required prompt argument: notePath');
  // MCP has no current experiment: the scope is the experiment of notePath alone.
  const scope = await toolScope({ ...ctx, scope: undefined, allowedFolders: undefined }, { notePath: raw });
  if (!scope || !experimentFolderOf(scope.folder)) throw new ScopeError('noExperiment', [raw]);
  const only: Scope = { ...scope, named: [] };
  return { scope: only, notePath: assertInScope(only, raw) };
}

function buildInput(ctx: ScopedToolContext, scope: Scope): Omit<BuildInput, 'target'> {
  return {
    fs: ctx.fs,
    scope,
    budgetTokens: MAX_TOKENS_DEFAULT,
    customTypes: ctx.customTypes,
    globalSampleFolder: ctx.globalSampleFolder,
    catalog: catalogFromTools(ctx),
    workflowCatalog: workflowCatalogFromTools(ctx),
  };
}

/** The workflow note `notePath` among the chain's workflows. Throws PromptError. */
function workflowOf(chain: ExperimentChain, notePath: string): { wf: WorkflowNode; at: number } {
  const key = folderKey(notePath);
  const at = chain.workflows.findIndex(w => folderKey(w.path) === key);
  if (at === -1) fail(`${notePath} is not a workflow note of ${chain.folder}`);
  return { wf: chain.workflows[at], at };
}

/** A heading line without its `#`s. */
const label = (heading: string): string => heading.replace(/^\s{0,3}#+\s*/, '');

// ---------------------------------------------------------------- draft-unit-operation

/** The requested sections split into the draftable ones (canonical, in order) and the refused names. */
function splitSections(uo: UnitOpNode, raw: string | undefined): { requested: string[]; refused: string[] } {
  const fallback = draftableSections(uo, { environment: 'Environment' in uo.sections });
  const names = (raw ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(s => s !== '');
  if (names.length === 0) return { requested: fallback, refused: [] };
  const allowed = draftableSections(uo, { environment: true });
  const requested: string[] = [];
  const refused: string[] = [];
  for (const name of names) {
    const canon = canonicalSection(name);
    if (canon && allowed.includes(canon)) {
      if (!requested.includes(canon)) requested.push(canon);
    } else {
      const shown = canon ?? name;
      if (!refused.includes(shown)) refused.push(shown);
    }
  }
  return { requested: requested.length > 0 ? requested : fallback, refused };
}

async function draftUnitOperation(ctx: ScopedToolContext, args: Record<string, string>): Promise<PromptReply> {
  const { scope, notePath } = await noteScope(ctx, args);
  const chain = await buildChain(ctx.fs, scope.folder, { customTypes: ctx.customTypes });
  const { wf } = workflowOf(chain, notePath);
  if (wf.unitOps.length === 0) fail(`${notePath} has no unit operations`);
  const uo = pickUnitOp(wf.unitOps, args.unitOp) ?? fail(`No unit operation "${args.unitOp}" in ${notePath}`);
  const { requested, refused } = splitSections(uo, args.sections);

  const built = await buildContext({ ...buildInput(ctx, scope), target: { workflowPath: uo.workflowPath, unitOpIndex: uo.index } });
  const parts = [PLANNING_RULES, KOREAN_TERMS_INSTRUCTION];
  if (refused.length > 0) {
    parts.push(
      `Not drafted: ${refused.join(', ')}. Only the planning sections of this unit operation are drafted; ` +
        'Results & Discussions, QC Metrics, Discussion and Meta are written by the researcher.'
    );
  }
  parts.push(planningRequestText(built, requested));
  return reply(`Draft the planning sections of ${label(uo.heading)} (${notePath})`, parts.join('\n\n'));
}

// ---------------------------------------------------------------- continue-workflow

/** The last unit op before workflow `at` (the previous workflows, nearest first). */
function lastUnitOpBefore(chain: ExperimentChain, at: number): UnitOpNode | undefined {
  for (let w = at - 1; w >= 0; w--) {
    const ops = chain.workflows[w].unitOps;
    if (ops.length > 0) return ops[ops.length - 1];
  }
  return undefined;
}

/** `from`'s Output IDs as Input lines, with registry names from this experiment (then the global registry). */
async function inputLines(ctx: ScopedToolContext, scope: Scope, from: UnitOpNode): Promise<string[]> {
  const names = await registryAliases(ctx.fs, scope.folder, ctx.globalSampleFolder, from.outputIds, ctx.customTypes);
  return from.outputIds.map(id => {
    const name = names.get(id)?.trim();
    return name ? `- ${id} — ${name}` : `- ${id}`;
  });
}

async function continueWorkflow(ctx: ScopedToolContext, args: Record<string, string>): Promise<PromptReply> {
  const { scope, notePath } = await noteScope(ctx, args);
  const chain = await buildChain(ctx.fs, scope.folder, { customTypes: ctx.customTypes });
  const { wf, at } = workflowOf(chain, notePath);
  const empty = wf.unitOps.length === 0;
  const anchor = empty ? lastUnitOpBefore(chain, at) : wf.unitOps[wf.unitOps.length - 1];
  const next = chain.workflows.slice(at + 1).find(w => w.listed);

  // The anchor is the context's target; its own Input prefill is not the next step's.
  const built = await buildContext({
    ...buildInput(ctx, scope),
    ...(anchor ? { target: { workflowPath: anchor.workflowPath, unitOpIndex: anchor.index } } : {}),
    exclude: ['target:input-prefill'],
  });

  const parts = [PLANNING_RULES, KOREAN_TERMS_INSTRUCTION];
  const rendered = renderContext(built);
  if (rendered) parts.push('Context sources:', rendered);
  parts.push(`Workflow: ${wf.label} (${wf.path})`);
  parts.push(
    anchor
      ? `Last unit operation so far: ${anchor.heading} (${anchor.workflowPath}; the source with id "target" above)`
      : 'Last unit operation so far: none; this is the first unit operation of the experiment.'
  );
  parts.push(`Next workflow in the README checklist: ${next ? `${next.label} (${next.path})` : 'none'}`);

  let task: string;
  if (empty || !anchor) {
    task = `${wf.label} has no unit operations yet: propose its first unit operation.`;
  } else if (wf.done && next) {
    task = `${wf.label} is checked as done in the README checklist, so propose the first unit operation of ${next.label}.`;
  } else {
    task = `Propose the next unit operation of ${wf.label}, after ${label(anchor.heading)}.`;
    if (next) task += ` If this workflow is complete after ${label(anchor.heading)}, propose the first unit operation of ${next.label} instead.`;
  }
  parts.push(task);

  if (anchor && anchor.outputIds.length > 0) {
    parts.push([`Its Input is the Output of ${label(anchor.heading)}:`, ...(await inputLines(ctx, scope, anchor))].join('\n'));
  } else if (anchor) {
    parts.push(`The Output of ${label(anchor.heading)} has no sample IDs; leave Input for the researcher.`);
  }
  const goal = args.goal?.trim();
  if (goal) parts.push(`The researcher's goal for the next step: ${goal}`);
  parts.push(
    'Start the new unit operation with a `### [OPID Name]` heading, then write its planning sections only.',
    `Requested sections: ${PLANNING_SECTIONS_HW.join(', ')}`,
    `For a software unit operation (USW…) the sections are: ${draftableSectionsFor('sw').join(', ')}.`
  );
  const where = anchor && !empty ? ` after ${label(anchor.heading)}` : '';
  return reply(`Continue ${wf.label}${where}`, parts.join('\n\n'));
}

// ---------------------------------------------------------------- entry

/**
 * Fills the MCP prompt `name` (without the `prompt:` prefix) from `args`
 * (Rust already checked that they are strings and that `notePath` is there).
 * Scope and note problems reply `-32602`; nothing is thrown and nothing is written.
 */
export async function fillPrompt(name: string, args: Record<string, string>, deps: { toolCtx: ScopedToolContext }): Promise<PromptReply> {
  try {
    if (name === 'draft-unit-operation') return await draftUnitOperation(deps.toolCtx, args);
    if (name === 'continue-workflow') return await continueWorkflow(deps.toolCtx, args);
    return { kind: 'error', code: INVALID_PARAMS, message: `Unknown prompt: ${name}` };
  } catch (err) {
    if (err instanceof ScopeError) return { kind: 'error', code: INVALID_PARAMS, message: scopeErrorMessage(err.code, err.params) };
    if (err instanceof PromptError) return { kind: 'error', code: INVALID_PARAMS, message: err.message };
    return { kind: 'error', code: INTERNAL_ERROR, message: `Internal error: ${String(err)}` };
  }
}
