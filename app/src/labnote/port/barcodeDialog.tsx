// Ported from app/vendor/labnoteo/src/barcode/barcodeModal.ts:1-65 sha256:3d8e29b8ec734f0d
// labnoteO 0.140.2, Apache-2.0.
// Changes: Modal becomes a React dialog (BarcodeDialog in DialogLayer, opened through dialogStore as kind 'barcode' by openBarcodeDialog, which resolves when it closes); the QR SVG is parsed with DOMParser, sanitized with sanitizePrintTree and appended through a ref (no innerHTML); Object.assign(box.style) becomes the .barcode-qr class and the ID label the .barcode-id class (app.css, SP7 Part A block); Notice becomes the toast notify, and a refused clipboard write is reported instead of thrown; the Translator is coreT; Setting buttons become a .dialog-actions row whose CTA is .primary and gets the first focus.
/** "Show note barcode": the note's QR code and ID, large enough to scan from the screen. */
import { useEffect, useId, useLayoutEffect, useRef } from 'react';
import { encodeNotePayload } from '@labnoteo/core/lib/scanPayload';
import { DialogFrame } from '../host/DialogFrame';
import { openDialog, type DialogSpec } from '../host/dialogStore';
import { notify } from '../host/toastStore';
import { coreT } from '../i18n';
import { sanitizePrintTree } from '../print/sanitize';
import { qrSvg } from './qr';

/** What the window can print: a workflow note's worksheet, and any note in full. */
export interface BarcodePrintActions {
  worksheet?: () => void;
  wholeNote: () => void;
}

/** Open the barcode window for `note`; resolves when it closes (a print button closes it before running). */
export function openBarcodeDialog(note: { title: string; id: string }, actions: BarcodePrintActions): Promise<void> {
  return openDialog<void>({ kind: 'barcode', title: note.title, id: note.id, actions }, undefined);
}

/** The QR of `LN1:<id>` as an SVG element of this document: parsed apart, pruned to the print allow-list, then imported. */
function qrElement(id: string): Element {
  const parsed = new DOMParser().parseFromString(qrSvg(encodeNotePayload(id), id), 'image/svg+xml');
  sanitizePrintTree(parsed);
  return document.importNode(parsed.documentElement, true);
}

export function BarcodeDialog(props: {
  spec: Extract<DialogSpec, { kind: 'barcode' }>;
  onDone: (value: unknown) => void;
  onCancel: () => void;
}) {
  const { spec } = props;
  const { actions: print } = spec;
  const descId = useId();
  const box = useRef<HTMLDivElement>(null);
  const cta = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const svg = qrElement(spec.id);
    el.replaceChildren(svg);
    return () => el.replaceChildren();
  }, [spec.id]);

  useEffect(() => cta.current?.focus(), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(spec.id);
      notify('info', coreT('Copied {0}.', spec.id));
    } catch (err) {
      notify('error', coreT('Command failed: {0}', err instanceof Error ? err.message : String(err)));
    }
  };

  const action = (run: () => void) => () => {
    props.onDone(undefined);
    run();
  };

  return (
    <DialogFrame title={coreT('Note barcode')} className="barcode" describedBy={descId} onCancel={props.onCancel}>
      <p className="barcode-title">{spec.title}</p>
      <div ref={box} className="barcode-qr" />
      <p className="barcode-id">{spec.id}</p>
      {/* Only a workflow note has worksheets; any other note is printed whole (#465). */}
      <p id={descId} className="prompt-hint">
        {print.worksheet
          ? coreT('Printed worksheets carry this ID with the unit operation and page, so photos of them find their way back to this note.')
          : coreT(
              'Pages printed with "{0}" carry this ID and their page number, so photos of them find their way back to this note.',
              coreT('Print whole note with barcodes'),
            )}
      </p>
      <div className="dialog-actions">
        <button type="button" onClick={() => void copy()}>
          {coreT('Copy ID')}
        </button>
        <button
          ref={print.worksheet ? undefined : cta}
          type="button"
          className={print.worksheet ? undefined : 'primary'}
          onClick={action(print.wholeNote)}
        >
          {coreT('Print whole note with barcodes')}
        </button>
        {print.worksheet ? (
          <button ref={cta} type="button" className="primary" onClick={action(print.worksheet)}>
            {coreT('Print experiment worksheet')}
          </button>
        ) : null}
      </div>
    </DialogFrame>
  );
}
