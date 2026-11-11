// Draft-planning and prefill orchestration (spec §6.4, §7; plan Task 10).
// Non-UI: the context-source dialog (`pickSources`) and the draft preview
// (`showDraft`) are passed in, so every step here is testable with fakes.
//
// Nothing is written until the user presses Insert (the draft) or runs the
// prefill command; the model never writes Results & Discussions, QC Metrics,
// Discussion or Meta (parsePlanningReply drops them, applyPlanningDraft never
// touches them). Reads stay inside the active note's experiment folder: the
// scope comes from the active note alone, so no other experiment is listed or read.
import { listUnitOpBlocks, minimalReplacement } from '@labnoteo/core';
import type { AiEnv } from '../../ai/aiEnv';
import { t } from '../../i18n/t';
import { NoteBusyError, processNote } from '../openNotes';
import { pathKey } from '../paths';
import { complete, toolContext } from '../port/aiCommon';
import { aiAnswerDialog } from '../port/aiAnswerDialog';
import { draftHeader, keepDraftNote, withAiDraftReview } from '../port/aiDraftMethod';
import { overrideOr } from '../i18n';
import { LLM_CONTEXT_WINDOW_DEFAULT } from '../settings';
import { contextBudget } from './budget';
import { buildChain, previousUnitOp, unitOpAtLine, type ExperimentChain, type UnitOpNode } from './chain';
import { buildContext, catalogFromTools, registryAliases, type BuiltContext } from './contextBuilder';
import { applyPlanningDraft, parsePlanningReply } from './planningGuard';
import { buildPlanningMessages, draftableSections } from './planningPrompt';
import { applyPrefill, prefillInput, type PrefillResult } from './prefill';
import { resolveScope, ScopeError, type Scope } from './scope';
import { estimateTokens } from './tokens';
import type { ContextSource } from './types';

/** A parsed planning draft: the sections to write and the names the guard dropped. */
export interface PlanningDraft {
  sections: Map<string, string>;
  dropped: string[];
}

export interface DraftDeps {
  env: AiEnv;
  /** The context-sources dialog (Task 16): the sources to send and the window for this run; null = Cancel. */
  pickSources(model: BuiltContext, window: number): Promise<{ sources: ContextSource[]; window: number } | null>;
  /** Shows the draft; `insert` writes it and resolves false when nothing was written. See {@link answerDialogShowDraft}. */
  showDraft(draft: PlanningDraft, insert: () => Promise<boolean>): Promise<void>;
}

/** The unit op under the cursor of the active note, inside an experiment folder. */
interface Located {
  path: string;
  /** 0-based unit op index. */
  unitOpIndex: number;
  /** The unit op's heading line as the editor shows it now. */
  heading: string;
  scope: Scope;
}

const baseName = (path: string): string => path.split('/').pop() ?? path;
const headingLabel = (heading: string): string => heading.replace(/^#+\s*/, '');
const info = (env: AiEnv, message: string): void => env.host.notify('info', message);

/**
 * The active note, the unit op under its cursor and its experiment scope, or
 * undefined after a notice. The scope comes from the active note's path only:
 * no experiment list is read, so no other folder is touched.
 */
async function locate(env: AiEnv): Promise<Located | undefined> {
  const target = env.ctx.host.editTarget();
  if (!target) {
    info(env, t('aiCtx.openNote'));
    return undefined;
  }
  const text = await target.getText();
  const offset = target.getCursorOffset ? await target.getCursorOffset() : undefined;
  const line = offset === undefined ? -1 : text.slice(0, offset).split('\n').length - 1;
  const unitOpIndex = line < 0 ? undefined : unitOpAtLine(text, line);
  if (unitOpIndex === undefined) {
    info(env, t('aiCtx.notInUnitOp'));
    return undefined;
  }
  let scope: Scope;
  try {
    scope = resolveScope({ activePath: target.path }, []);
  } catch (err) {
    if (!(err instanceof ScopeError)) throw err;
    info(env, t('aiCtx.err.noExperiment'));
    return undefined;
  }
  const block = listUnitOpBlocks(text)[unitOpIndex];
  const heading = text.split(/\r?\n/)[block.headingLine];
  return { path: target.path, unitOpIndex, heading, scope };
}

/** The node of the located unit op in `chain`, or undefined after a notice (a note outside the chain). */
function chainNode(env: AiEnv, chain: ExperimentChain, at: Located): UnitOpNode | undefined {
  const wf = chain.workflows.find(w => pathKey(w.path).normalize('NFC') === pathKey(at.path).normalize('NFC'));
  const uo = wf?.unitOps.find(u => u.index === at.unitOpIndex);
  if (!uo) info(env, t('aiCtx.notInChain'));
  return uo;
}

/** The prefill of `uo` with registry names from the scope folder's registry, then the global one. */
async function prefillFor(env: AiEnv, chain: ExperimentChain, uo: UnitOpNode, scope: Scope): Promise<PrefillResult> {
  const previous = previousUnitOp(chain, { workflowPath: uo.workflowPath, unitOpIndex: uo.index });
  const names = await registryAliases(
    env.host.fs,
    scope.folder,
    env.sampleEnv().globalFolder(),
    previous?.outputIds ?? [],
    env.settings().customSampleTypes
  );
  return prefillInput(chain, { workflowPath: uo.workflowPath, unitOpIndex: uo.index }, id => names.get(id));
}

type WriteOutcome = 'written' | 'unchanged' | 'moved';

/**
 * Applies `transform` to the note at `path`: through the open editor's
 * EditTarget when it is the active note (undoable), else through processNote
 * (the open buffer, or compare-and-swap for a closed note), as writeMethodDraft
 * does. `transform` returns null when the note moved under the command.
 */
async function writeNote(env: AiEnv, path: string, transform: (md: string) => string | null): Promise<WriteOutcome> {
  const target = env.ctx.host.editTarget();
  if (target && pathKey(target.path) === pathKey(path)) {
    const latest = await target.getText();
    const next = transform(latest);
    if (next === null) return 'moved';
    const edit = minimalReplacement(latest, next);
    if (!edit) return 'unchanged';
    await target.replaceRange(edit.start, edit.end, edit.text);
    return 'written';
  }
  let moved = false;
  const changed = await processNote(env.host.fs, path, md => {
    const next = transform(md);
    if (next === null) {
      moved = true;
      return md;
    }
    return next;
  });
  return moved ? 'moved' : changed ? 'written' : 'unchanged';
}

/** The system and fixed user text of a request, in estimated tokens (no sources). */
function fixedTokens(env: AiEnv, scope: Scope, chain: ExperimentChain, uo: UnitOpNode, sections: string[]): number {
  const empty: BuiltContext = {
    sources: [],
    totalTokens: 0,
    budget: 0,
    overBudget: false,
    trimmed: [],
    scope,
    chain,
    target: uo,
    issues: [],
  };
  return buildPlanningMessages(empty, sections, env.lang()).reduce((n, m) => n + estimateTokens(m.content), 0);
}

/**
 * "AI: Draft unit operation planning". Builds the experiment context for the
 * unit op under the cursor, lets the user pick the sources, asks the model for
 * the planning sections only, and shows the draft; Insert writes the Input
 * prefill (unless unticked) and the draft into that unit op.
 */
export async function draftPlanningCommand(deps: DraftDeps): Promise<void> {
  const { env } = deps;
  if (!env.provider) {
    info(env, overrideOr('ai.configureFirst'));
    return;
  }
  const at = await locate(env);
  if (!at) return;

  const settings = env.settings();
  const fs = env.host.fs;
  const customTypes = settings.customSampleTypes;
  let model: BuiltContext;
  let prefill: PrefillResult;
  let uo: UnitOpNode;
  let sections: string[];
  const window = settings.llmContextWindow || LLM_CONTEXT_WINDOW_DEFAULT;
  try {
    const chain = await buildChain(fs, at.scope.folder, { customTypes });
    const node = chainNode(env, chain, at);
    if (!node) return;
    uo = node;
    sections = draftableSections(uo, { environment: 'Environment' in uo.sections });
    prefill = await prefillFor(env, chain, uo, at.scope);
    model = await buildContext({
      fs,
      scope: at.scope,
      target: { workflowPath: uo.workflowPath, unitOpIndex: uo.index },
      budgetTokens: contextBudget(window, fixedTokens(env, at.scope, chain, uo, sections)),
      customTypes,
      globalSampleFolder: env.sampleEnv().globalFolder(),
      catalog: catalogFromTools(toolContext(env, { scope: at.scope })),
    });
  } catch (err) {
    if (!(err instanceof ScopeError)) throw err;
    info(env, t('aiCtx.err.noExperiment'));
    return;
  }

  const picked = await deps.pickSources(model, window);
  if (!picked) return;
  const chosen: BuiltContext = { ...model, sources: picked.sources };
  const out = await complete(env, buildPlanningMessages(chosen, sections, env.lang()), { contextWindow: picked.window });
  if (!out) return;

  const draft = parsePlanningReply(out.content, sections);
  if (draft.sections.size === 0) {
    env.host.notify('warn', t('aiCtx.draftEmpty'));
    return;
  }

  // The prefill goes in with the draft unless the user unticked its source.
  const prefillSource = picked.sources.find(s => s.id === 'target:input-prefill');
  const withPrefill = prefillSource?.reason !== 'user';
  const where = { unitOpIndex: at.unitOpIndex, heading: at.heading, kind: uo.kind };
  const path = at.path;

  const insert = async (): Promise<boolean> => {
    // The marker line goes into the note only with the setting on; otherwise the
    // open editor highlights what was inserted, without writing anything (2026-11-11).
    const header = keepDraftNote(env) ? draftHeader(env) : null;
    let outcome: WriteOutcome;
    try {
      outcome = await withAiDraftReview(path, () =>
        writeNote(env, path, md => {
          const base = withPrefill ? (applyPrefill(md, where, prefill) ?? md) : md;
          return applyPlanningDraft(base, where, draft.sections, header);
        })
      );
    } catch (err) {
      if (!(err instanceof NoteBusyError)) throw err;
      info(env, t('aiCtx.noteBusy'));
      return false;
    }
    if (outcome === 'moved') {
      info(env, t('aiCtx.draftMoved'));
      return false;
    }
    info(env, t('aiCtx.draftInserted', baseName(path)));
    return true;
  };
  await deps.showDraft(draft, insert);
}

/** The draft as the preview shows it: each section under its heading, then the dropped list. */
export function formatDraft(draft: PlanningDraft): string {
  const parts = [...draft.sections].map(([name, body]) => `#### ${name}\n${body}`);
  if (draft.dropped.length > 0) parts.push(t('aiCtx.droppedSections', draft.dropped.join(', ')));
  return parts.join('\n\n');
}

/** The default `showDraft`: the answer dialog with "Insert into note". Resolves when it closes. */
export function answerDialogShowDraft(draft: PlanningDraft, insert: () => Promise<boolean>): Promise<void> {
  return aiAnswerDialog({ content: formatDraft(draft), onInsert: insert });
}

/**
 * "AI: Prefill Input from previous step" (`ai-prefill-input`). Writes the
 * previous unit op's Output IDs into the Input of the unit op under the
 * cursor and names the source unit op. Never calls the model.
 */
export async function prefillInputCommand(env: AiEnv): Promise<void> {
  const at = await locate(env);
  if (!at) return;
  let result: PrefillResult;
  let chain: ExperimentChain;
  let uo: UnitOpNode;
  try {
    chain = await buildChain(env.host.fs, at.scope.folder, { customTypes: env.settings().customSampleTypes });
    const node = chainNode(env, chain, at);
    if (!node) return;
    uo = node;
    result = await prefillFor(env, chain, uo, at.scope);
  } catch (err) {
    if (!(err instanceof ScopeError)) throw err;
    info(env, t('aiCtx.err.noExperiment'));
    return;
  }
  if ('reason' in result) {
    if (result.reason === 'noPrevious') {
      info(env, t('aiCtx.prefillNoPrevious'));
    } else {
      const previous = previousUnitOp(chain, { workflowPath: uo.workflowPath, unitOpIndex: uo.index });
      info(env, t('aiCtx.prefillNoOutput', headingLabel(previous?.heading ?? '')));
    }
    return;
  }
  const where = { unitOpIndex: at.unitOpIndex, heading: at.heading };
  let outcome: WriteOutcome;
  try {
    outcome = await writeNote(env, at.path, md => applyPrefill(md, where, result) ?? md);
  } catch (err) {
    if (!(err instanceof NoteBusyError)) throw err;
    info(env, t('aiCtx.noteBusy'));
    return;
  }
  if (outcome !== 'written') {
    info(env, t('aiCtx.prefillNothing'));
    return;
  }
  info(env, t('aiCtx.prefillDone', headingLabel(result.from.heading), baseName(result.from.path)));
}
