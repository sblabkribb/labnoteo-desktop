import { StateField, type Extension, type Range, type Text } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { classifyMetaEndDate, findMetaDateFieldInLine, getSeoulDateTimeString } from '@labnoteo/core/lib/dateUtils';
import { UNIT_OP_HEADING_PATTERN } from '../../../vendor/labnoteo/packages/labnoteo-core/src/sections/workflowSectionParser';
import { t } from '../../i18n/t';
import { langChanged } from './editorLang';
import { iconElement } from '../../ui/iconElement';

/**
 * UO cards (live preview only, spec §5.5). Every `### [UHW010 Name] alias` section of a workflow note is drawn as a
 * soft card: each of its lines gets `cm-uo-card` (first and last line also `-first` / `-last`), and the card that
 * holds the cursor gets `cm-uo-card-active` (accent border). The heading line ends with a status chip: done when
 * End_date is filled with a date that has passed, in progress when only Start_date is (an End_date still to come or
 * unreadable counts as in progress, as everywhere End_date is judged, core #509). `####` headings inside a card get
 * `cm-uo-label` (small uppercase muted label). The code chip itself is inline.ts's (`lno-uo-code`). Only the drawing
 * changes; the file's headings and values stay as written (plugin compatibility).
 */

export interface UoSection {
  /** Start of the `###` heading line. */
  from: number;
  /** End of the section's last non-blank line (the `---` and blank lines before the next section are not in it). */
  to: number;
  code: string;
  name: string;
  /** Text after the `]`, trimmed. */
  alias: string;
  /** The first Meta Start_date / End_date value as written (no quotes); undefined when the line is missing. */
  start?: string;
  end?: string;
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const UPPER_HEADING = /^#{1,3}\s/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;

/** The UO sections of a document, in order. Headings inside fenced code do not count. */
export function uoSections(doc: Text): UoSection[] {
  const out: UoSection[] = [];
  let cur: UoSection | null = null;
  let lastContent = 0;
  let fence: string | null = null;
  const close = () => {
    if (cur) {
      cur.to = lastContent;
      out.push(cur);
    }
    cur = null;
  };
  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    const text = line.text.replace(/\r$/, '');
    const f = FENCE.exec(text);
    if (fence !== null) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && text.trim() === f[1]) fence = null;
      if (cur) lastContent = line.to;
      continue;
    }
    if (f) {
      fence = f[1];
      if (cur) lastContent = line.to;
      continue;
    }
    if (UPPER_HEADING.test(text)) {
      close();
      const m = UNIT_OP_HEADING_PATTERN.exec(text);
      if (m) {
        cur = { from: line.from, to: line.to, code: m[1], name: m[2].trim(), alias: (m[3] ?? '').trim() };
        lastContent = line.to;
      }
      continue;
    }
    if (!cur) continue;
    const section: UoSection = cur;
    if (text.trim() !== '' && !RULE.test(text)) lastContent = line.to;
    const date = findMetaDateFieldInLine(text);
    if (date?.field === 'Start_date' && section.start === undefined) section.start = date.value;
    if (date?.field === 'End_date' && section.end === undefined) section.end = date.value;
  }
  close();
  return out;
}

/** The UO sections of the current document, recomputed only when the document changes. */
export const uoSectionsField = StateField.define<UoSection[]>({
  create: (state) => uoSections(state.doc),
  update: (value, tr) => (tr.docChanged ? uoSections(tr.state.doc) : value),
});

export type UoStatus = 'done' | 'inProgress';

/** Done when End_date holds a date that has passed; in progress when Start_date (or a future End_date) is filled. */
export function uoStatus(sec: Pick<UoSection, 'start' | 'end'>, now = getSeoulDateTimeString()): UoStatus | null {
  const end = sec.end?.trim() ?? '';
  if (end) return classifyMetaEndDate(end, now) === 'ended' ? 'done' : 'inProgress';
  return sec.start?.trim() ? 'inProgress' : null;
}

class UoStatusWidget extends WidgetType {
  constructor(
    readonly status: UoStatus,
    readonly label: string,
  ) {
    super();
  }

  eq(o: UoStatusWidget): boolean {
    return o.status === this.status && o.label === this.label;
  }

  toDOM(view: EditorView): HTMLElement {
    const doc = view.dom.ownerDocument;
    const chip = doc.createElement('span');
    chip.className = `lno-chip lno-uo-status lno-status-${this.status}`;
    chip.setAttribute('title', t('uo.status', this.label));
    chip.appendChild(iconElement(doc, this.status === 'done' ? 'circle-check' : 'circle-half', 14));
    chip.appendChild(doc.createTextNode(this.label));
    return chip;
  }
}

const cardLine = Decoration.line({ class: 'cm-uo-card' });
const cardActiveLine = Decoration.line({ class: 'cm-uo-card cm-uo-card-active' });
const firstLine = Decoration.line({ class: 'cm-uo-card-first' });
const lastLine = Decoration.line({ class: 'cm-uo-card-last' });
const labelLine = Decoration.line({ class: 'cm-uo-label' });
const H4 = /^####\s/;

function build(view: EditorView): DecorationSet {
  const { state } = view;
  const sections = state.field(uoSectionsField);
  if (sections.length === 0) return Decoration.none;
  const head = state.selection.main.head;
  const now = getSeoulDateTimeString();
  const decos: Range<Decoration>[] = [];
  for (const { from, to } of view.visibleRanges) {
    for (const sec of sections) {
      if (sec.to < from || sec.from > to) continue;
      const active = head >= sec.from && head <= sec.to;
      const first = state.doc.lineAt(sec.from).number;
      const last = state.doc.lineAt(sec.to).number;
      const lo = Math.max(first, state.doc.lineAt(from).number);
      const hi = Math.min(last, state.doc.lineAt(to).number);
      for (let n = lo; n <= hi; n++) {
        const line = state.doc.line(n);
        decos.push((active ? cardActiveLine : cardLine).range(line.from));
        if (n === first) decos.push(firstLine.range(line.from));
        if (n === last) decos.push(lastLine.range(line.from));
        if (H4.test(line.text)) decos.push(labelLine.range(line.from));
      }
      const status = uoStatus(sec, now);
      if (status && first >= lo && first <= hi) {
        const label = status === 'done' ? t('status.done') : t('status.inProgress');
        const end = state.doc.line(first).to;
        decos.push(Decoration.widget({ widget: new UoStatusWidget(status, label), side: 1 }).range(end));
      }
    }
  }
  return Decoration.set(decos, true);
}

const uoCardPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view);
    }
    update(u: ViewUpdate) {
      // Composing: only move the decorations (changing a composing line's classes breaks the IME), as inline.ts does
      if (u.view.composing || u.view.compositionStarted) {
        if (u.docChanged) this.decorations = this.decorations.map(u.changes);
        return;
      }
      if (u.docChanged || u.selectionSet || u.viewportChanged || langChanged(u)) this.decorations = build(u.view);
    }
  },
  { decorations: (p) => p.decorations },
);

export function uoCards(): Extension {
  return [uoSectionsField, uoCardPlugin];
}
