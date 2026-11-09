import { useEffect, useId, useRef, useState, type DragEvent } from 'react';
import { DialogFrame } from '../host/DialogFrame';
import { openDialog, type DialogSpec } from '../host/dialogStore';
import { coreT } from '../i18n';
import type { ScanInput } from '../port/scanPipeline';

/** The plugin's file list (vendor src/scan/importModal.ts ACCEPT). */
export const SCAN_ACCEPT =
  '.jpg,.jpeg,.png,.webp,.gif,.bmp,.pdf,.zip,.heic,.heif,.tif,.tiff,image/*,application/pdf,application/zip';

/**
 * "Import scanned pages" (the plugin's ImportScansModal, vendor src/scan/importModal.ts:8-73, as a React dialog).
 * Drop photos, scanner PDFs or zips on the zone, or click it to pick them. The files' bytes are read here
 * (File.arrayBuffer: the window's own drag and drop is off, `dragDropEnabled: false`), then the dialog closes with
 * them and the caller runs them as one batch. Inline drop-zone styles become `.scan-drop` / `.scan-drop.over`.
 * With `processFolder`, a second row runs the scan folder now instead.
 */
export function openImportDialog(opts: { processFolder?: () => void } = {}): Promise<ScanInput[] | undefined> {
  return openDialog<ScanInput[] | undefined>({ kind: 'scanImport', ...opts }, undefined);
}

export function ImportDialog(props: {
  spec: Extract<DialogSpec, { kind: 'scanImport' }>;
  onDone: (value: unknown) => void;
  onCancel: () => void;
}) {
  const { processFolder } = props.spec;
  const descId = useId();
  const input = useRef<HTMLInputElement>(null);
  const zone = useRef<HTMLButtonElement>(null);
  const busy = useRef(false);
  const [over, setOver] = useState(false);

  useEffect(() => zone.current?.focus(), []);

  const take = async (files: File[]) => {
    if (busy.current || files.length === 0) return;
    busy.current = true;
    const inputs = await Promise.all(files.map(async (f) => ({ name: f.name, bytes: await f.arrayBuffer() })));
    props.onDone(inputs);
  };

  const onDragOver = (e: DragEvent) => {
    e.preventDefault();
    setOver(true);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    void take(Array.from(e.dataTransfer?.files ?? []));
  };

  return (
    <DialogFrame title={coreT('Import scanned pages')} className="scan-import" describedBy={descId} onCancel={props.onCancel}>
      <p id={descId}>
        {coreT(
          'Drop photos or scans of printed worksheets here: JPEG, PNG, PDF (several pages are fine) or a zip of them. Each page is filed in its note by its QR code.',
        )}
      </p>
      <button
        ref={zone}
        type="button"
        className={over ? 'scan-drop over' : 'scan-drop'}
        onClick={() => input.current?.click()}
        onDragOver={onDragOver}
        onDragEnter={onDragOver}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
      >
        {coreT('Drop files here, or click to choose')}
      </button>
      <input
        ref={input}
        type="file"
        multiple
        accept={SCAN_ACCEPT}
        hidden
        onChange={(e) => void take(Array.from(e.currentTarget.files ?? []))}
      />
      {processFolder ? (
        <div className="scan-import-folder">
          <p className="prompt-hint">{coreT('Files put in the scan folder are picked up on their own every 30 seconds.')}</p>
          <button
            type="button"
            onClick={() => {
              props.onDone(undefined);
              processFolder();
            }}
          >
            {coreT('Process scan folder now')}
          </button>
        </div>
      ) : null}
    </DialogFrame>
  );
}
