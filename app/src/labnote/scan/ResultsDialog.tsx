import { useEffect, useId, useRef, useState } from 'react';
import { isPagePayload, payloadLabel } from '@labnoteo/core/lib/scanPayload';
import { DialogFrame } from '../host/DialogFrame';
import { openDialog, type DialogSpec } from '../host/dialogStore';
import { notify } from '../host/toastStore';
import { coreT } from '../i18n';
import type { ResultActions } from '../port/scanFeatureRuns';
import type { ScanPipeline, ScanResult } from '../port/scanPipeline';
import { describeResult, summarizeResults } from '../port/scanResults';

/** Open the results of a batch; resolves when the dialog closes. */
export function openResultsDialog(results: ScanResult[], pipeline: ScanPipeline, actions: ResultActions): Promise<void> {
  return openDialog<void>({ kind: 'scanResults', results, pipeline, actions }, undefined);
}

/**
 * "Scan results" (the plugin's ScanResultModal, vendor src/scan/resultModal.ts:81-152, as a React dialog): the
 * summary, then one row per page that was not skipped with what became of it. A filed or already-filed page can
 * be opened in its note; a filed page can be undone, and when it was filed before, its earlier scans deleted.
 * Undo marks the result `skipped` as the plugin does, so reopening the same results ("Show results") leaves it
 * out. `Setting` rows become `.scan-results` list items; the Undo button is `.danger`, the CTA `.primary`.
 */
export function ResultsDialog(props: {
  spec: Extract<DialogSpec, { kind: 'scanResults' }>;
  onDone: (value: unknown) => void;
  onCancel: () => void;
}) {
  const { results, pipeline, actions } = props.spec;
  const descId = useId();
  // The rows are fixed when the dialog opens: an undone row stays, saying Undone.
  const [rows] = useState(() => results.filter((x) => x.status !== 'skipped'));
  // removePrevious empties `previous`: the button stays, spent, for the rows that had earlier scans at the start.
  const [hadPrevious] = useState<ReadonlySet<ScanResult>>(() => new Set(rows.filter((x) => (x.previous?.length ?? 0) > 0)));
  const [undone, setUndone] = useState<ReadonlySet<ScanResult>>(() => new Set());
  const [cleared, setCleared] = useState<ReadonlySet<ScanResult>>(() => new Set());
  const [working, setWorking] = useState<ReadonlySet<ScanResult>>(() => new Set());
  const first = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const unmatched = results.some((r) => r.status === 'unmatched');

  // The CTA when there is one, otherwise the first row's first button: the user asked for this dialog.
  useEffect(() => (first.current ?? list.current?.querySelector('button'))?.focus(), []);

  // A spent (disabled) or removed button drops focus to <body>, outside the dialog, where Escape no longer reaches
  // it: once the buttons settle after Undo or Delete earlier scan, focus goes back in, to the row's next button, the
  // CTA, another row's button or the close button.
  const focusRow = useRef<number | null>(null);
  useEffect(() => {
    const row = focusRow.current;
    const dialog = list.current?.closest<HTMLElement>('.dialog');
    if (row === null || !dialog || working.size > 0) return;
    focusRow.current = null;
    const active = document.activeElement as HTMLButtonElement | null;
    if (active && active !== document.body && dialog.contains(active) && !active.disabled) return;
    const enabled = 'button:not([disabled])';
    const target =
      list.current?.children[row]?.querySelector<HTMLElement>(enabled) ??
      first.current ??
      list.current?.querySelector<HTMLElement>(enabled) ??
      dialog.querySelector<HTMLElement>('.dialog-close');
    target?.focus();
  }, [undone, cleared, working]);

  const busy = (r: ScanResult, on: boolean) =>
    setWorking((s) => {
      const next = new Set(s);
      if (on) next.add(r);
      else next.delete(r);
      return next;
    });

  const removePrevious = async (r: ScanResult) => {
    focusRow.current = rows.indexOf(r);
    busy(r, true);
    try {
      const n = await pipeline.removePrevious(r);
      notify('info', coreT('Removed {0} earlier scan(s).', String(n)));
      setCleared((s) => new Set(s).add(r));
    } catch (err) {
      notify('error', coreT('Command failed: {0}', err instanceof Error ? err.message : String(err)));
    } finally {
      busy(r, false);
    }
  };

  const undo = async (r: ScanResult) => {
    focusRow.current = rows.indexOf(r);
    busy(r, true);
    try {
      const ok = await pipeline.undo(r);
      r.status = 'skipped';
      notify('info', ok ? coreT('Removed the scan from {0}.', r.notePath ?? '') : coreT('The scan was no longer in the note.'));
      setUndone((s) => new Set(s).add(r));
    } catch (err) {
      notify('error', coreT('Command failed: {0}', err instanceof Error ? err.message : String(err)));
    } finally {
      busy(r, false);
    }
  };

  return (
    <DialogFrame title={coreT('Scan results')} className="scan-results-dialog" describedBy={descId} onCancel={props.onCancel}>
      <p id={descId}>{summarizeResults(coreT, results)}</p>
      <ul ref={list} className="scan-results">
        {rows.map((r, i) => {
          const name = r.sourcePage ? `${r.source} (p.${r.sourcePage})` : r.source;
          const label = r.payload ? ` — ${payloadLabel(r.payload)}` : '';
          const isUndone = undone.has(r);
          const disabled = working.has(r);
          const path = r.notePath;
          const canOpen = !isUndone && !!path && (r.status === 'filed' || r.status === 'duplicate');
          const canClear =
            !isUndone && r.status === 'filed' && !!r.payload && isPagePayload(r.payload) && hadPrevious.has(r);
          const canUndo = !isUndone && r.status === 'filed';
          return (
            <li key={i}>
              <div className="scan-result-text">
                <span className="scan-result-name">{name + label}</span>
                <span className="scan-result-desc">{isUndone ? coreT('Undone') : describeResult(coreT, r)}</span>
              </div>
              {canOpen || canClear || canUndo ? (
                <div className="scan-result-actions">
                  {canOpen ? (
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => {
                        props.onDone(undefined);
                        actions.openNote(path, r.hash);
                      }}
                    >
                      {coreT('Open note')}
                    </button>
                  ) : null}
                  {canClear ? (
                    <button
                      type="button"
                      title={coreT('This page was filed before; remove the earlier scan and its image.')}
                      disabled={disabled || cleared.has(r)}
                      onClick={() => void removePrevious(r)}
                    >
                      {coreT('Delete earlier scan')}
                    </button>
                  ) : null}
                  {canUndo ? (
                    <button type="button" className="danger" disabled={disabled} onClick={() => void undo(r)}>
                      {coreT('Undo')}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {unmatched ? (
        <div className="dialog-actions">
          <button
            ref={first}
            type="button"
            className="primary"
            onClick={() => {
              props.onDone(undefined);
              actions.openUnmatched();
            }}
          >
            {coreT('Assign unmatched scans')}
          </button>
        </div>
      ) : null}
    </DialogFrame>
  );
}
