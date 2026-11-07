import { Facet, type Compartment, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { isSelfLinkName, splitLinktext } from '../../links/resolve';

/**
 * Link resolution for live preview (plan SP4 Task 8, decisions D1 and D2).
 * The editor puts one `LinkResolution` in a compartment (Editor.tsx `resolutionSlot`); the inline
 * plugin reads it through the `linkResolution` facet to draw missing targets faded (`lno-unresolved`).
 * Resolution depends only on the file universe, so the value changes only with `linkIndex.filesVersion`
 * or readiness, never while typing. A new value is never dispatched while an IME composition is running:
 * `scheduleResolution` defers it and `resolutionFlusher` applies it on the first non-composing update.
 */
export interface LinkResolution {
  /** linkIndex.filesVersion: resolution depends only on the file universe. */
  version: number;
  resolveWiki(linkpath: string, source: string): string | null;
  resolveMd(href: string, source: string): string | null;
  isUnknownTarget(linkpath: string): boolean;
}

/** The last value wins; null (no value, or an index that is not ready) draws nothing unresolved. */
export const linkResolution = Facet.define<LinkResolution | null, LinkResolution | null>({
  combine: (values) => (values.length > 0 ? values[values.length - 1] : null),
});

export type LinkState = 'resolved' | 'unresolved' | 'unknown';

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** The decoded Markdown path before '#', for the attachment check. */
function mdPath(href: string): string {
  let h = href.trim();
  if (h.startsWith('<') && h.endsWith('>')) h = h.slice(1, -1).trim();
  const hash = h.indexOf('#');
  if (hash >= 0) h = h.slice(0, hash);
  try {
    return decodeURIComponent(h).normalize('NFC');
  } catch {
    return h.normalize('NFC');
  }
}

/**
 * How to draw a link. `target` is the WikiTarget text (`note#heading`) or the Markdown URL text.
 * - `unknown`: no resolution yet, or an attachment the app does not list (D1).
 * - `resolved`: an existing file, an empty wikilink path or a self link, a scheme link, a `#…` Markdown link.
 */
export function linkStateOf(res: LinkResolution | null, kind: 'wiki' | 'md', target: string, notePath: string): LinkState {
  if (!res) return 'unknown';
  if (kind === 'wiki') {
    const { path } = splitLinktext(target);
    if (path === '') return 'resolved';
    if (res.resolveWiki(path, notePath) !== null) return 'resolved';
    // A self link resolves even before the note is in the file list (a note just created)
    if (isSelfLinkName(path, notePath)) return 'resolved';
    return res.isUnknownTarget(path) ? 'unknown' : 'unresolved';
  }
  let h = target.trim();
  if (h.startsWith('<') && h.endsWith('>')) h = h.slice(1, -1).trim();
  if (h === '' || h.startsWith('#') || SCHEME.test(h)) return 'resolved';
  if (res.resolveMd(target, notePath) !== null) return 'resolved';
  return res.isUnknownTarget(mdPath(target)) ? 'unknown' : 'unresolved';
}

/** A value waiting for the composition to end, per view. */
const deferred = new WeakMap<EditorView, { slot: Compartment; value: LinkResolution | null }>();

const composing = (view: EditorView) => view.composing || view.compositionStarted;

/** Puts `value` in `slot` now, or after the running composition (a reconfigure mid-composition breaks the IME). */
export function scheduleResolution(view: EditorView, slot: Compartment, value: LinkResolution | null): void {
  if (composing(view)) {
    deferred.set(view, { slot, value });
    return;
  }
  deferred.delete(view);
  view.dispatch({ effects: slot.reconfigure(linkResolution.of(value)) });
}

/** Dispatches a deferred value on the first update after the composition ends. */
export const resolutionFlusher: Extension = EditorView.updateListener.of((u) => {
  const pending = deferred.get(u.view);
  if (!pending || composing(u.view)) return;
  deferred.delete(u.view);
  u.view.dispatch({ effects: pending.slot.reconfigure(linkResolution.of(pending.value)) });
});
