// The model behind the context-sources dialog (spec §8; plan Task 16). Pure:
// the dialog only renders what these functions return. Unticking and window
// changes go through budget.ts (`toggleSource`, `applyBudget`), so the preview
// shows exactly what will be sent.
import { applyBudget, contextBudget, PROMPT_SHARE, toggleSource } from './budget';
import type { ExperimentChain, UnitOpNode } from './chain';
import type { BuiltContext } from './contextBuilder';
import type { ContextSource } from './types';

/** Context-window sizes offered by the dialog (tokens); the current window is added when it is not one of them. */
export const WINDOW_PRESETS: readonly number[] = [4096, 8192, 16384, 32768, 65536, 131072, 200000];

/** The presets plus `current`, ascending and unique. */
export function windowChoices(current: number): number[] {
  return [...new Set([...WINDOW_PRESETS, current])].sort((a, b) => a - b);
}

/**
 * The fixed (system + instructions) tokens the caller subtracted when it made
 * `built.budget` for `window` (`contextBudget(window, fixed)`). When the budget
 * was clamped to 0 the true value is unknown and this over-estimates it, which
 * only makes a re-budget more conservative.
 */
export function fixedTokensOf(built: { budget: number }, window: number): number {
  return Math.max(0, Math.floor(window * PROMPT_SHARE) - built.budget);
}

/** `uo:<path>#<i>` source ids (as the builder makes them) to their chain nodes. */
export function unitOpLookup(chain: ExperimentChain): (id: string) => UnitOpNode | undefined {
  const map = new Map<string, UnitOpNode>();
  for (const wf of chain.workflows) for (const uo of wf.unitOps) map.set(`uo:${uo.workflowPath}#${uo.index}`, uo);
  return id => map.get(id);
}

/** `built` with `sources` fitted into the budget of `window`. Scope, chain, target and issues are kept. */
export function rebudget(built: BuiltContext, window: number, fixed: number, sources: ContextSource[] = built.sources): BuiltContext {
  const result = applyBudget(sources, contextBudget(window, fixed), unitOpLookup(built.chain));
  return { ...built, ...result };
}

/** `built` with source `id` ticked or unticked by the user, then re-budgeted. A required id stays ticked. */
export function tickSource(built: BuiltContext, id: string, on: boolean, window: number, fixed: number): BuiltContext {
  return rebudget(built, window, fixed, toggleSource(built.sources, id, on));
}

/** How full the budget is, 0–100 (an empty budget with anything in it is full). */
export function fillPercent(total: number, budget: number): number {
  if (budget <= 0) return total > 0 ? 100 : 0;
  return Math.min(100, Math.max(0, Math.round((total / budget) * 100)));
}

/** The provider as the integration settings name it. */
export function providerLabel(provider: string): string {
  if (provider === 'ollama') return 'Ollama';
  if (provider === 'openai') return 'OpenAI-compatible';
  return provider;
}
