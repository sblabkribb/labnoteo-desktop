import { Facet, StateField, type EditorState, type Extension } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import { parseWorkflowChecklistFromReadme, workflowChecklistSectionRange } from '@labnoteo/core/lib/workflowStructure';
import { t } from '../../i18n/t';
import type { Lang } from '../../i18n/lang';
import { editorLang, langChanged } from './editorLang';
import { iconElement } from '../../ui/iconElement';

/**
 * README empty-state card (live preview only, UI redesign Task 19, spec §5.5 and §7.1). In an experiment README whose
 * "Related Workflows" checklist has no entries, a card under that heading reads "아직 워크플로가 없습니다" with a
 * primary "첫 워크플로 추가 / Add the first workflow" button. The button calls `onAddWorkflow` (the app opens the
 * catalog workflow picker scoped to this experiment). The file is never changed by the drawing, and the card goes away
 * as soon as the checklist has an entry.
 */
export interface ReadmeEmptyState {
  onAddWorkflow(): void;
}

/** Set by the editor only for an experiment README; absent (null) everywhere else, so no card is drawn. */
export const readmeEmptyState = Facet.define<ReadmeEmptyState | null, ReadmeEmptyState | null>({
  combine: (values) => values.find((v) => v !== null) ?? null,
});

class EmptyStateWidget extends WidgetType {
  /** `lang`: the language the card's words were drawn in (a switch redraws it). */
  constructor(readonly lang: Lang) {
    super();
  }

  eq(o: EmptyStateWidget): boolean {
    return o.lang === this.lang;
  }

  toDOM(view: EditorView): HTMLElement {
    const doc = view.dom.ownerDocument;
    const card = doc.createElement('div');
    card.className = 'lno-widget lno-empty-state';
    card.setAttribute('role', 'group');
    card.setAttribute('aria-label', t('emptyState.title'));
    const icon = doc.createElement('span');
    icon.className = 'lno-empty-state-icon';
    icon.appendChild(iconElement(doc, 'workflow', 18));
    const text = doc.createElement('div');
    text.className = 'lno-empty-state-text';
    const title = doc.createElement('p');
    title.className = 'lno-empty-state-title';
    title.textContent = t('emptyState.title');
    const body = doc.createElement('p');
    body.className = 'lno-empty-state-body';
    body.textContent = t('emptyState.body');
    text.append(title, body);
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'lno-btn lno-btn-primary lno-empty-state-add';
    button.appendChild(iconElement(doc, 'plus', 14));
    button.appendChild(doc.createTextNode(t('emptyState.add')));
    button.addEventListener('mousedown', (e) => e.preventDefault());
    button.addEventListener('click', (e) => {
      e.preventDefault();
      view.state.facet(readmeEmptyState)?.onAddWorkflow();
    });
    card.append(icon, text, button);
    return card;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

const cards = new Map<Lang, Decoration>();
const cardFor = (lang: Lang): Decoration => {
  let card = cards.get(lang);
  if (!card) cards.set(lang, (card = Decoration.widget({ widget: new EmptyStateWidget(lang), block: true, side: 1 })));
  return card;
};

/** Where the card goes: the end of the "Related Workflows" heading line, when the checklist is empty. */
export function emptyStateAt(state: EditorState): number | null {
  if (!state.facet(readmeEmptyState)) return null;
  const text = state.doc.toString();
  const range = workflowChecklistSectionRange(text);
  if (!range || parseWorkflowChecklistFromReadme(text).length > 0) return null;
  return state.doc.line(range.header + 1).to;
}

function build(state: EditorState): DecorationSet {
  const at = emptyStateAt(state);
  return at === null ? Decoration.none : Decoration.set([cardFor(state.facet(editorLang)).range(at)]);
}

const emptyStateField = StateField.define<DecorationSet>({
  create: build,
  update(value, tr) {
    if (tr.docChanged || tr.startState.facet(readmeEmptyState) !== tr.state.facet(readmeEmptyState) || langChanged(tr)) return build(tr.state);
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export function emptyState(): Extension {
  return emptyStateField;
}
