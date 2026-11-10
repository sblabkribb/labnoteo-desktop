import type { Extension, Range } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { uoSectionsField } from './uoCards';

/**
 * Template placeholders (live preview only, spec §5.5). Inside a UO section, a line that is exactly a parenthesised
 * placeholder from the plugin's template — `- (e.g. enzyme, buffer, etc.)`, `(method used in this step)` — is drawn
 * faint and italic (`lno-placeholder-line` on the line, `lno-placeholder` on the `(…)`), and a click on it selects
 * exactly the `(…)`, so typing replaces it. A second click (the placeholder already selected) places the caret as
 * usual. The file is never changed by the drawing.
 */

/** A whole line that is one parenthesised placeholder (one level of nested parentheses allowed). */
export const PLACEHOLDER_LINE = /^\s*(?:- )?\((?:[^()]|\([^()]*\))+\)\s*$/;

/** The `(…)` of a placeholder line, as offsets within the line; null when the line is not one. */
export function placeholderRange(text: string): { from: number; to: number } | null {
  if (!PLACEHOLDER_LINE.test(text)) return null;
  const from = text.indexOf('(');
  const to = text.lastIndexOf(')') + 1;
  return from >= 0 && to > from ? { from, to } : null;
}

const phMark = Decoration.mark({ class: 'lno-placeholder' });
const phLine = Decoration.line({ class: 'lno-placeholder-line' });

function build(view: EditorView): DecorationSet {
  const { state } = view;
  const sections = state.field(uoSectionsField);
  if (sections.length === 0) return Decoration.none;
  const decos: Range<Decoration>[] = [];
  for (const { from, to } of view.visibleRanges) {
    for (const sec of sections) {
      if (sec.to < from || sec.from > to) continue;
      const lo = Math.max(state.doc.lineAt(sec.from).number, state.doc.lineAt(from).number);
      const hi = Math.min(state.doc.lineAt(sec.to).number, state.doc.lineAt(to).number);
      for (let n = lo; n <= hi; n++) {
        const line = state.doc.line(n);
        const r = placeholderRange(line.text.replace(/\r$/, ''));
        if (!r) continue;
        decos.push(phLine.range(line.from));
        decos.push(phMark.range(line.from + r.from, line.from + r.to));
      }
    }
  }
  return Decoration.set(decos, true);
}

const placeholderPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view);
    }
    update(u: ViewUpdate) {
      if (u.view.composing || u.view.compositionStarted) {
        if (u.docChanged) this.decorations = this.decorations.map(u.changes);
        return;
      }
      if (u.docChanged || u.viewportChanged) this.decorations = build(u.view);
    }
  },
  { decorations: (p) => p.decorations },
);

/** A plain left click on a placeholder selects the whole `(…)`. */
const placeholderClick = EditorView.domEventHandlers({
  mousedown(e, view) {
    if (e.button !== 0 || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey || e.detail > 1) return false;
    const el = (e.target as Element | null)?.closest?.('.lno-placeholder');
    if (!el || !view.contentDOM.contains(el)) return false;
    const line = view.state.doc.lineAt(view.posAtDOM(el));
    const r = placeholderRange(line.text.replace(/\r$/, ''));
    if (!r) return false;
    const anchor = line.from + r.from;
    const head = line.from + r.to;
    const sel = view.state.selection.main;
    if (sel.from === anchor && sel.to === head) return false;
    e.preventDefault();
    view.dispatch({ selection: { anchor, head }, userEvent: 'select.pointer' });
    view.focus();
    return true;
  },
});

export function placeholders(): Extension {
  return [placeholderPlugin, placeholderClick];
}
