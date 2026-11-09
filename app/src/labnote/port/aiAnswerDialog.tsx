// Ported from app/vendor/labnoteo/src/modals.ts:410-471 sha256:cfb094c711a12229
// labnoteO 0.140.2, Apache-2.0.
// Changes: the Obsidian Modal (AiAnswerModal, aiAnswerModal) becomes the React DialogSpec kind 'aiAnswer' (AiAnswerDialog, drawn by DialogLayer) opened by aiAnswerDialog, which resolves when the dialog closes. MarkdownRenderer.render and its Component become plain text in <pre class="ai-answer"> (D19): model output never becomes HTML, so sourcePath is accepted but unused. Notice becomes notify ('info' for a copy, 'warn' when it fails). onInsert is optional: without it there is no "Insert into note" button. While onInsert runs the Insert button is disabled (no double insert), and a rejected onInsert counts as not inserted (the dialog stays open). Titles and labels go through coreT with the plugin's keys.
import { useEffect, useRef, useState } from 'react';
import { coreT } from '../i18n';
import { DialogFrame } from '../host/DialogFrame';
import { openDialog, type DialogSpec } from '../host/dialogStore';
import { notify } from '../host/toastStore';

/** Options for {@link aiAnswerDialog}. */
export interface AiAnswerOpts {
  /** The model's answer, shown as plain text. */
  content: string;
  /** The note the answer is about (kept for vendor parity; plain text has no links to resolve). */
  sourcePath?: string;
  /** Put the answer into the note. Resolves false when it was not inserted. */
  onInsert?: () => Promise<boolean>;
}

/**
 * Shows an AI answer (#77). The note only changes when the user presses
 * "Insert into note".
 */
export function AiAnswerDialog(props: { spec: Extract<DialogSpec, { kind: 'aiAnswer' }>; onDone: (value: unknown) => void; onCancel: () => void }) {
  const { spec } = props;
  const [inserting, setInserting] = useState(false);
  const first = useRef<HTMLButtonElement>(null);

  useEffect(() => first.current?.focus(), []);

  const insert = async () => {
    if (!spec.onInsert || inserting) return;
    setInserting(true);
    let ok = false;
    try {
      ok = await spec.onInsert();
    } catch {
      ok = false;
    }
    if (ok) props.onDone(undefined);
    else setInserting(false);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(spec.content);
      notify('info', coreT('Copied to clipboard.'));
    } catch (err) {
      notify('warn', coreT('Could not copy: {0}', err instanceof Error ? err.message : String(err)));
    }
  };

  return (
    <DialogFrame title={coreT('AI answer')} className="ai-answer-dialog" onCancel={props.onCancel}>
      <pre className="ai-answer">{spec.content}</pre>
      <div className="dialog-actions">
        {spec.onInsert && (
          <button ref={first} type="button" className="primary" disabled={inserting} onClick={() => void insert()}>
            {coreT('Insert into note')}
          </button>
        )}
        <button ref={spec.onInsert ? undefined : first} type="button" onClick={() => void copy()}>
          {coreT('Copy')}
        </button>
        <button type="button" onClick={props.onCancel}>
          {coreT('Close')}
        </button>
      </div>
    </DialogFrame>
  );
}

/** Opens the answer dialog. Resolves when it closes (after an insert, Close, Escape or a vault switch). */
export function aiAnswerDialog(opts: AiAnswerOpts): Promise<void> {
  return openDialog<void>({ kind: 'aiAnswer', content: opts.content, onInsert: opts.onInsert }, undefined);
}
