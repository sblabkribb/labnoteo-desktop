import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { MIME, extOf } from '../../editor/live/imagePath';
import { DialogFrame } from '../host/DialogFrame';
import { openDialog, type DialogSpec } from '../host/dialogStore';
import { notify } from '../host/toastStore';
import { coreT } from '../i18n';
import { unmatchedInfoFromName } from '../port/imageStore';
import type { UnmatchedItem } from '../port/scanPipeline';
import { unmatchedReasonText } from '../port/scanResults';

/** What the queue dialog reads and changes: the queue list, an image's bytes, and the Recycle Bin. */
export interface UnmatchedIo {
  list(): Promise<UnmatchedItem[]>;
  read(path: string): Promise<ArrayBuffer>;
  trash(path: string): Promise<void>;
}

/** Open the unmatched queue; resolves with the page the user chose to assign, or undefined when closed. */
export function openUnmatchedDialog(io: UnmatchedIo): Promise<UnmatchedItem | undefined> {
  return openDialog<UnmatchedItem | undefined>({ kind: 'scanUnmatched', io }, undefined);
}

/**
 * "Assign unmatched scans" (the Modal half of the plugin's UnmatchedModal, vendor src/scan/unmatchedModal.ts, as a
 * React dialog; the assignment itself is port/unmatchedScans.ts): one row per queued page with its name, why it was
 * not filed, a thumbnail, Assign and Delete. Thumbnails are blob URLs of the image bytes, revoked when the row goes
 * or the dialog closes; a click zooms inside the dialog (the plugin used window.open). Assign closes the dialog with
 * the page (the pickers that follow are dialogs too, and only one shows at a time); Delete sends the image to the
 * Recycle Bin and drops the row.
 */
export function UnmatchedDialog(props: {
  spec: Extract<DialogSpec, { kind: 'scanUnmatched' }>;
  onDone: (value: unknown) => void;
  onCancel: () => void;
}) {
  const { io } = props.spec;
  const descId = useId();
  const [items, setItems] = useState<UnmatchedItem[] | undefined>(undefined);
  const [urls, setUrls] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [zoom, setZoom] = useState<UnmatchedItem | undefined>(undefined);
  const [working, setWorking] = useState<ReadonlySet<string>>(() => new Set());
  /** Every URL made and not yet revoked, so closing gives them all back. */
  const made = useRef(new Map<string, string>());
  const list = useRef<HTMLUListElement>(null);
  const zoomRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let alive = true;
    const urlsMade = made.current;
    void (async () => {
      let found: UnmatchedItem[];
      try {
        found = await io.list();
      } catch (err) {
        notify('error', coreT('Command failed: {0}', err instanceof Error ? err.message : String(err)));
        found = [];
      }
      if (!alive) return;
      setItems(found);
      for (const item of found) {
        let bytes: ArrayBuffer;
        try {
          bytes = await io.read(item.path);
        } catch {
          continue; // the row stays, without a thumbnail
        }
        if (!alive) return;
        const url = URL.createObjectURL(new Blob([bytes], { type: MIME[extOf(item.path)] ?? 'application/octet-stream' }));
        urlsMade.set(item.path, url);
        setUrls(new Map(urlsMade));
      }
    })();
    return () => {
      alive = false;
      for (const url of urlsMade.values()) URL.revokeObjectURL(url);
      urlsMade.clear();
    };
  }, [io]);

  // The user asked for this dialog: the first row's Assign once the list is there.
  const loaded = items !== undefined;
  useEffect(() => {
    if (loaded) (list.current?.querySelector<HTMLButtonElement>('button.primary') ?? undefined)?.focus();
  }, [loaded]);

  useEffect(() => {
    if (zoom) zoomRef.current?.focus();
  }, [zoom]);

  const remove = async (item: UnmatchedItem) => {
    setWorking((s) => new Set(s).add(item.path));
    try {
      await io.trash(item.path);
      const url = made.current.get(item.path);
      if (url !== undefined) {
        URL.revokeObjectURL(url);
        made.current.delete(item.path);
        setUrls(new Map(made.current));
      }
      setItems((xs) => xs?.filter((x) => x.path !== item.path));
    } catch (err) {
      notify('error', coreT('Command failed: {0}', err instanceof Error ? err.message : String(err)));
    } finally {
      setWorking((s) => {
        const next = new Set(s);
        next.delete(item.path);
        return next;
      });
    }
  };

  const leaveZoom = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== 'Escape' || e.nativeEvent.isComposing) return;
    // Escape leaves the zoom only; DialogFrame would close the whole dialog.
    e.preventDefault();
    e.stopPropagation();
    setZoom(undefined);
  };

  const zoomUrl = zoom ? urls.get(zoom.path) : undefined;
  return (
    <DialogFrame
      title={coreT('Assign unmatched scans')}
      className="scan-unmatched-dialog"
      describedBy={descId}
      onCancel={props.onCancel}
    >
      {items !== undefined && items.length === 0 ? (
        <p id={descId}>{coreT('No unmatched scans.')}</p>
      ) : (
        <p id={descId}>
          {coreT('These pages could not be filed on their own. Choose the note and unit operation for each, or delete it.')}
        </p>
      )}
      {zoom && zoomUrl ? (
        <button ref={zoomRef} type="button" className="scan-zoom" aria-label={coreT('Close')} onClick={() => setZoom(undefined)} onKeyDown={leaveZoom}>
          <img src={zoomUrl} alt={zoom.name} />
        </button>
      ) : null}
      <ul ref={list} className="scan-unmatched" hidden={!!(zoom && zoomUrl)}>
        {(items ?? []).map((item) => {
          const info = unmatchedInfoFromName(item.name);
          const url = urls.get(item.path);
          const disabled = working.has(item.path);
          return (
            <li key={item.path}>
              <div className="scan-result-text">
                <span className="scan-result-name">{item.name}</span>
                {info.reason ? (
                  <span className="scan-result-desc">{unmatchedReasonText(coreT, info.reason, info.noteId)}</span>
                ) : null}
                {url ? (
                  <button type="button" className="scan-thumb-button" onClick={() => setZoom(item)}>
                    <img className="scan-thumb" src={url} alt={item.name} />
                  </button>
                ) : null}
              </div>
              <div className="scan-result-actions">
                <button type="button" className="primary" disabled={disabled} onClick={() => props.onDone(item)}>
                  {coreT('Assign')}
                </button>
                <button type="button" className="danger" disabled={disabled} onClick={() => void remove(item)}>
                  {coreT('Delete')}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </DialogFrame>
  );
}
