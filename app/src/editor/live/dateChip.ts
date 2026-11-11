import type { Extension, Range } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import {
  findMetaDateFieldInLine,
  findPairedMetaDate,
  fromDateTimeLocalValue,
  getSeoulDateTimeString,
  isPlausibleMetaDate,
  toDateTimeLocalValue,
  type MetaDateFieldMatch,
} from '@labnoteo/core/lib/dateUtils';
import { t } from '../../i18n/t';
import type { Lang } from '../../i18n/lang';
import { editorLang, langChanged } from './editorLang';
import { iconElement } from '../../ui/iconElement';
import { notify } from '../../labnote/host/toastStore';
import { checkDates } from '../../labnote/port/metaDateChecks';
import { touchedLines } from './reveal';
import { uoSectionsField } from './uoCards';

/**
 * Date chips (live preview only, spec §5.5). In a UO section, the value of `- Start_date: '…'` / `- End_date: '…'`
 * is drawn as a chip (calendar icon + mono value; a dashed "날짜 고르기 / Pick a date" when empty). On the line that
 * holds the cursor the source shows and an icon-only chip sits at the end of the line, so the picker is always one
 * click away. Clicking a chip opens a small popover with a native `datetime-local` field, "지금 / Now" and "적용 /
 * Apply". The value is written as `YYYY-MM-DD HH:mm` (the plugin format, Seoul time for Now) in one transaction, so a
 * single Ctrl+Z undoes it; the quote style is kept and an unquoted value gets single quotes, as the plugin does.
 * Enter applies, Escape closes without writing, a click elsewhere applies a changed value. A year outside 1900–2100
 * is not written (warning toast); an End_date earlier than its Start_date is written with a warning toast
 * (labnote/port/metaDateChecks.ts holds the rules).
 */

/** `YYYY-MM-DD HH:mm` in Seoul time, the format the plugin writes into Meta. */
export function formatMetaDate(d: Date): string {
  return getSeoulDateTimeString(d);
}

type Field = MetaDateFieldMatch['field'];

class DateChipWidget extends WidgetType {
  constructor(
    readonly field: Field,
    readonly value: string,
    /** Icon only: the line shows its source (cursor on it). */
    readonly iconOnly: boolean,
    /** The language the chip's words were drawn in (a switch redraws it). */
    readonly lang: Lang,
  ) {
    super();
  }

  eq(o: DateChipWidget): boolean {
    return o.field === this.field && o.value === this.value && o.iconOnly === this.iconOnly && o.lang === this.lang;
  }

  toDOM(view: EditorView): HTMLElement {
    const doc = view.dom.ownerDocument;
    const chip = doc.createElement('button');
    chip.type = 'button';
    const empty = this.value.trim() === '';
    chip.className = `lno-chip lno-date-chip${empty ? ' lno-date-empty' : ''}${this.iconOnly ? ' lno-date-icon' : ''}`;
    chip.dataset.field = this.field;
    chip.setAttribute('aria-haspopup', 'dialog');
    chip.setAttribute('aria-label', `${this.field}: ${empty ? t('date.pick') : this.value}`);
    chip.title = t('date.pick');
    chip.appendChild(iconElement(doc, 'calendar', 14));
    if (!this.iconOnly) {
      const text = doc.createElement('span');
      text.className = 'lno-date-text';
      text.textContent = empty ? t('date.pick') : this.value;
      chip.appendChild(text);
    }
    // mousedown only keeps the caret where it is; the popover opens on click
    chip.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    chip.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const pos = view.posAtDOM(chip);
      openDatePopover(view, view.state.doc.lineAt(pos).number, this.field, chip);
    });
    return chip;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

function build(view: EditorView): { decorations: DecorationSet; atomic: DecorationSet } {
  const { state } = view;
  const sections = state.field(uoSectionsField);
  if (sections.length === 0) return { decorations: Decoration.none, atomic: Decoration.none };
  const touched = touchedLines(state);
  const lang = state.facet(editorLang);
  const decos: Range<Decoration>[] = [];
  const atomic: Range<Decoration>[] = [];
  for (const { from, to } of view.visibleRanges) {
    for (const sec of sections) {
      if (sec.to < from || sec.from > to) continue;
      const lo = Math.max(state.doc.lineAt(sec.from).number, state.doc.lineAt(from).number);
      const hi = Math.min(state.doc.lineAt(sec.to).number, state.doc.lineAt(to).number);
      for (let n = lo; n <= hi; n++) {
        const line = state.doc.line(n);
        const m = findMetaDateFieldInLine(line.text.replace(/\r$/, ''));
        if (!m) continue;
        if (touched.has(n)) {
          decos.push(Decoration.widget({ widget: new DateChipWidget(m.field, m.value, true, lang), side: 1 }).range(line.to));
          continue;
        }
        const widget = new DateChipWidget(m.field, m.value, false, lang);
        const a = line.from + m.valueStart - (m.quote ? 1 : 0);
        const b = line.from + m.valueEnd + (m.quote ? 1 : 0);
        if (a === b) {
          decos.push(Decoration.widget({ widget, side: 1 }).range(a));
        } else {
          const r = Decoration.replace({ widget }).range(a, b);
          decos.push(r);
          atomic.push(r);
        }
      }
    }
  }
  return { decorations: Decoration.set(decos, true), atomic: Decoration.set(atomic, true) };
}

class DateChipPlugin {
  decorations: DecorationSet;
  atomic: DecorationSet;
  constructor(view: EditorView) {
    ({ decorations: this.decorations, atomic: this.atomic } = build(view));
  }
  update(u: ViewUpdate) {
    if (u.view.composing || u.view.compositionStarted) {
      if (u.docChanged) {
        this.decorations = this.decorations.map(u.changes);
        this.atomic = this.atomic.map(u.changes);
      }
      return;
    }
    if (u.docChanged || u.selectionSet || u.viewportChanged || langChanged(u)) ({ decorations: this.decorations, atomic: this.atomic } = build(u.view));
  }
}

const dateChipPlugin = ViewPlugin.fromClass(DateChipPlugin, { decorations: (p) => p.decorations });

export function dateChips(): Extension {
  return [dateChipPlugin, EditorView.atomicRanges.of((v) => v.plugin(dateChipPlugin)?.atomic ?? Decoration.none)];
}

// ---------------------------------------------------------------- writing

/** The Meta date line `lineNumber` still holds `field` (the document may have changed since the chip was drawn). */
function fieldLine(view: EditorView, lineNumber: number, field: Field) {
  if (lineNumber < 1 || lineNumber > view.state.doc.lines) return null;
  const line = view.state.doc.line(lineNumber);
  const m = findMetaDateFieldInLine(line.text.replace(/\r$/, ''));
  return m && m.field === field ? { line, m } : null;
}

/**
 * Write a picked `YYYY-MM-DDTHH:mm` into the Meta date on `lineNumber`, in one undoable transaction. A year outside
 * 1900–2100 is not written; an End_date earlier than its Start_date is written and warned about. True when written.
 */
export function writeMetaDate(view: EditorView, lineNumber: number, field: Field, picked: string): boolean {
  if (!isPlausibleMetaDate(picked)) {
    notify('warn', t('date.implausibleYear', picked.slice(0, Math.max(1, picked.indexOf('-')))));
    return false;
  }
  const value = fromDateTimeLocalValue(picked);
  const found = value ? fieldLine(view, lineNumber, field) : null;
  if (!found) return false;
  const { line, m } = found;
  const gap = m.valueStart > 0 && !/\s/.test(line.text[m.valueStart - 1]) ? ' ' : '';
  if (m.value !== value || !m.quote) {
    view.dispatch({
      // `- End_date:` with nothing after the colon gets a space before the quoted value
      changes: { from: line.from + m.valueStart, to: line.from + m.valueEnd, insert: m.quote ? value : `${gap}'${value}'` },
      userEvent: 'input.date',
    });
  }
  const lines = view.state.doc.toJSON();
  const other = findPairedMetaDate(lines, lineNumber - 1);
  if (other) {
    const [start, end] = field === 'End_date' ? [other.value, value] : [value, other.value];
    if (checkDates(start, end) === 'endBeforeStart') notify('warn', t('date.endBeforeStart', end, start));
  }
  return true;
}

// ---------------------------------------------------------------- popover

let openPop: { close: () => void } | null = null;

/** Close the open date popover, if any (tests, editor teardown). */
export function closeDatePopover(): void {
  openPop?.close();
}

function openDatePopover(view: EditorView, lineNumber: number, field: Field, anchor: HTMLElement): void {
  openPop?.close();
  const found = fieldLine(view, lineNumber, field);
  if (!found) return;
  const doc = view.dom.ownerDocument;
  const stored = found.m.value.trim();
  const now = () => toDateTimeLocalValue(getSeoulDateTimeString());
  const initial = toDateTimeLocalValue(stored) || now();
  if (stored && !toDateTimeLocalValue(stored)) notify('info', t('date.unreadable', stored));

  const pop = doc.createElement('div');
  pop.className = 'lno-widget lno-popover lno-date-pop';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', t('date.dialog', field));
  const input = doc.createElement('input');
  input.type = 'datetime-local';
  input.className = 'lno-date-input';
  input.value = initial;
  input.setAttribute('aria-label', field);
  const row = doc.createElement('div');
  row.className = 'lno-date-actions';
  const nowBtn = doc.createElement('button');
  nowBtn.type = 'button';
  nowBtn.className = 'lno-btn lno-date-now';
  nowBtn.appendChild(iconElement(doc, 'clock', 14));
  nowBtn.appendChild(doc.createTextNode(t('date.now')));
  const applyBtn = doc.createElement('button');
  applyBtn.type = 'button';
  applyBtn.className = 'lno-btn lno-btn-primary lno-date-apply';
  applyBtn.textContent = t('date.apply');
  row.append(nowBtn, applyBtn);
  pop.append(input, row);

  let closed = false;
  const close = (refocus: boolean) => {
    if (closed) return;
    closed = true;
    if (openPop === handle) openPop = null;
    doc.removeEventListener('pointerdown', onOutside, true);
    pop.remove();
    anchor.setAttribute('aria-expanded', 'false');
    if (refocus) view.focus();
  };
  const apply = (value: string) => {
    close(true);
    if (value) writeMetaDate(view, lineNumber, field, value);
  };
  const handle = { close: () => close(false) };
  openPop = handle;

  function onOutside(e: Event) {
    const path = e.composedPath();
    if (path.includes(pop)) return;
    // a click elsewhere keeps a changed value (the native calendar has no apply button of its own)
    const changed = input.value !== initial;
    close(false);
    if (changed && input.value) writeMetaDate(view, lineNumber, field, input.value);
  }

  pop.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key === 'Enter' && e.target === input) {
      e.preventDefault();
      e.stopPropagation();
      apply(input.value);
    }
  });
  nowBtn.addEventListener('click', () => apply(now()));
  applyBtn.addEventListener('click', () => apply(input.value));

  view.dom.appendChild(pop);
  anchor.setAttribute('aria-expanded', 'true');
  place(view, pop, anchor);
  const win = doc.defaultView ?? window;
  // armed a tick later so the click that opened the popover cannot close it
  win.setTimeout(() => {
    if (closed) return;
    doc.addEventListener('pointerdown', onOutside, true);
    input.focus();
  }, 0);
}

/** Under the chip, flipped above or left when it would leave the editor. left/top through CSSOM (CSP). */
function place(view: EditorView, pop: HTMLElement, anchor: HTMLElement): void {
  const box = view.dom.getBoundingClientRect();
  const a = anchor.getBoundingClientRect();
  const size = pop.getBoundingClientRect();
  let left = a.left;
  let top = a.bottom + 4;
  if (box.width > 0 && left + size.width > box.right) left = Math.max(box.left, box.right - size.width);
  const area = view.scrollDOM.getBoundingClientRect();
  if (area.height > 0 && top + size.height > area.bottom && a.top - size.height - 4 >= area.top) top = a.top - size.height - 4;
  pop.style.setProperty('left', `${Math.round(left - box.left)}px`);
  pop.style.setProperty('top', `${Math.round(top - box.top)}px`);
}
