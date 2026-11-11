// Context-source preview before AI drafting (spec §8; plan Task 16). It only
// renders the model of sourcesModel.ts: unticking and the window select
// re-budget through budget.ts. Nothing is sent or written from here; Send
// resolves the chosen sources and window, Cancel and Escape resolve null.
// CSP: the bar width goes through CSSOM (`--ai-ctx-fill`), never a style attribute.
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { t } from '../../i18n/t';
import { DialogFrame } from '../host/DialogFrame';
import { openDialog, type DialogSpec } from '../host/dialogStore';
import type { ChainIssue, ChainIssueCode } from './chain';
import type { BuiltContext } from './contextBuilder';
import { fillPercent, fixedTokensOf, rebudget, tickSource, windowChoices } from './sourcesModel';
import type { ContextSource, SourceMode, SourceReason } from './types';

/** What Send resolves: the sources to send (with their budgeted forms) and the window for this run. */
export interface PickedSources {
  sources: ContextSource[];
  window: number;
}

type Spec = Extract<DialogSpec, { kind: 'aiContextSources' }>;

// Literal keys only (catalogs.test.ts checks every translation key exists in ko and en).
const MODE_LABEL: Record<SourceMode, () => string> = {
  verbatim: () => t('aiCtx.mode.verbatim'),
  summary: () => t('aiCtx.mode.summary'),
  outline: () => t('aiCtx.mode.outline'),
};

const REASON_LABEL: Record<SourceReason, () => string> = {
  default: () => t('aiCtx.reason.default'),
  user: () => t('aiCtx.reason.user'),
  trimmed: () => t('aiCtx.reason.trimmed'),
};

const ISSUE_LABEL: Record<ChainIssueCode, () => string> = {
  missingReadme: () => t('aiCtx.issue.missingReadme'),
  emptyChecklist: () => t('aiCtx.issue.emptyChecklist'),
  brokenLink: () => t('aiCtx.issue.brokenLink'),
  unlistedWorkflow: () => t('aiCtx.issue.unlistedWorkflow'),
  noUnitOps: () => t('aiCtx.issue.noUnitOps'),
  noOutput: () => t('aiCtx.issue.noOutput'),
  duplicateEntry: () => t('aiCtx.issue.duplicateEntry'),
  unreadable: () => t('aiCtx.issue.unreadable'),
};

const issueText = (i: ChainIssue): string =>
  [ISSUE_LABEL[i.code](), i.path, i.detail ? `(${i.detail})` : ''].filter(Boolean).join(' ');

/**
 * The row label. The Input prefill is labelled by the unit op whose Output it carries, which also has its own row,
 * so it says what it is (real-server check, 2026-11-11: two rows read the same). A catalog row says it is the catalog
 * description (what the Workflow tab shows), not a note.
 */
const rowLabel = (s: ContextSource): string =>
  s.kind === 'prefill'
    ? `${s.label} › ${t('aiCtx.sources.previousOutput')}`
    : s.kind === 'catalog'
      ? `${s.label} › ${t('aiCtx.sources.catalog')}`
      : s.label;

function SourceRow(props: { source: ContextSource; onToggle: (on: boolean) => void }) {
  const s = props.source;
  const id = useId();
  const where = [s.path, s.heading].filter(Boolean).join(' › ');
  const state = s.included ? MODE_LABEL[s.mode]() : REASON_LABEL[s.reason ?? 'trimmed']();
  return (
    <li data-source-id={s.id}>
      <label>
        <input
          type="checkbox"
          checked={s.included}
          disabled={s.required}
          aria-describedby={`${id}-state`}
          onChange={e => props.onToggle(e.currentTarget.checked)}
        />
        <span>
          <span>{rowLabel(s)}</span>
          {where ? <span className="picker-desc"> {where}</span> : null}
        </span>
      </label>
      <span id={`${id}-state`} className="worksheet-kind">
        {s.required ? `${t('aiCtx.sources.required')} · ` : ''}
        {state} · {t('aiCtx.sources.tokens', String(s.tokens))}
      </span>
    </li>
  );
}

export function ContextSourcesDialog(props: { spec: Spec; onDone: (value: unknown) => void; onCancel: () => void }) {
  const { spec } = props;
  const id = useId();
  const fixed = useMemo(() => fixedTokensOf(spec.built, spec.window), [spec]);
  const [windowSize, setWindowSize] = useState(spec.window);
  const [model, setModel] = useState<BuiltContext>(spec.built);
  const send = useRef<HTMLButtonElement>(null);
  const fill = useRef<HTMLDivElement>(null);

  useEffect(() => send.current?.focus(), []);
  useLayoutEffect(() => {
    fill.current?.style.setProperty('--ai-ctx-fill', `${fillPercent(model.totalTokens, model.budget)}%`);
  }, [model]);

  const toggle = (sourceId: string, on: boolean) => setModel(m => tickSource(m, sourceId, on, windowSize, fixed));
  const changeWindow = (next: number) => {
    setWindowSize(next);
    setModel(m => rebudget(m, next, fixed));
  };
  const done = () => {
    const picked: PickedSources = { sources: model.sources, window: windowSize };
    props.onDone(picked);
  };

  return (
    <DialogFrame title={t('aiCtx.sources.title')} className="worksheet ai-ctx" describedBy={`${id}-hint`} onCancel={props.onCancel}>
      <div className="worksheet-body">
        <p id={`${id}-hint`} className="prompt-hint">
          {t('aiCtx.sources.hint')}
        </p>
        <p className="prompt-hint">{t('aiCtx.sources.scope', model.scope.folder)}</p>
        <p className="prompt-hint">{t('aiCtx.sources.provider', spec.providerLabel, spec.model)}</p>
        <ul className="worksheet-ops">
          {model.sources.map(s => (
            <SourceRow key={s.id} source={s} onToggle={on => toggle(s.id, on)} />
          ))}
        </ul>
        {model.issues.length > 0 ? (
          <div className="ai-ctx-issues">
            <p className="prompt-hint">{t('aiCtx.sources.issues')}</p>
            <ul className="picker-note">
              {model.issues.map((i, k) => (
                <li key={k}>{issueText(i)}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <label className="worksheet-paper">
          <span>{t('aiCtx.sources.window')}</span>
          <select value={windowSize} onChange={e => changeWindow(Number(e.currentTarget.value))}>
            {windowChoices(spec.window).map(n => (
              <option key={n} value={n}>
                {t('aiCtx.sources.windowOption', String(n))}
              </option>
            ))}
          </select>
        </label>
        <div className="ai-ctx-bar" aria-hidden="true">
          <div ref={fill} className="ai-ctx-bar-fill" />
        </div>
        <p className="prompt-hint ai-ctx-total">{t('aiCtx.sources.total', String(model.totalTokens), String(model.budget))}</p>
        {model.overBudget ? (
          <p role="alert" className="prompt-hint warn">
            {t('aiCtx.sources.overBudget')}
          </p>
        ) : null}
        <div className="dialog-actions">
          <button type="button" onClick={props.onCancel}>
            {t('aiCtx.sources.cancel')}
          </button>
          <button ref={send} type="button" className="primary" onClick={done}>
            {t('aiCtx.sources.send')}
          </button>
        </div>
      </div>
    </DialogFrame>
  );
}

/** Opens the context-sources dialog. Resolves the picked sources and window, or null on Cancel, Escape or a vault switch. */
export function contextSourcesDialog(built: BuiltContext, window: number, providerLabel: string, model: string): Promise<PickedSources | null> {
  return openDialog<PickedSources | null>({ kind: 'aiContextSources', built, window, providerLabel, model }, null);
}
