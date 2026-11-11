// Shared types of the AI context builder (spec §5.1).

export type SourceKind = 'goal' | 'workflow' | 'unitOp' | 'results' | 'sample' | 'catalog' | 'target' | 'prefill' | 'named';

export type SourceMode = 'verbatim' | 'summary' | 'outline';

/** Why a source is not included: excluded by default (results), unticked by the user, or cut by the budget. */
export type SourceReason = 'default' | 'user' | 'trimmed';

export interface ContextSource {
  /**
   * Stable id: 'readme:goal', 'wf:<path>', 'uo:<path>#<i>', 'uo:<path>#<i>:results',
   * 'sample:<type>:<id>', 'catalog:<opId>', 'catalog:wf:<workflowId>', 'target', 'target:input-prefill', 'named:<folder>'.
   */
  id: string;
  kind: SourceKind;
  path?: string;
  heading?: string;
  /** Label shown in the preview (Korean titles kept verbatim). */
  label: string;
  text: string;
  mode: SourceMode;
  /** `estimateTokens(text)`. */
  tokens: number;
  /** Chain distance from the target (0 = target, 1 = the previous unit op). */
  distance: number;
  /** Target and the catalog definition of the target op; cannot be unticked. */
  required: boolean;
  /** False when excluded by default (results), by the user, or by trimming. */
  included: boolean;
  reason?: SourceReason;
  /**
   * The full text, kept by `applyBudget` when it shortened `text` (summary,
   * outline, goal or target cut), so a later rebudget with a larger window can
   * restore it. Absent when `text` is the full text.
   */
  fullText?: string;
}
