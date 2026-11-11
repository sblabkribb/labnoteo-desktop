// @vitest-environment jsdom
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { setLang } from '../../../i18n/lang';
import {
  aiDraftRanges,
  aiDraftReview,
  clearAiDraftReview,
  insertedRanges,
  markAiDraft,
} from '../aiDraftReview';

let views: EditorView[] = [];
function view(doc: string): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const v = new EditorView({ state: EditorState.create({ doc, extensions: aiDraftReview() }), parent });
  views.push(v);
  return v;
}
const slices = (v: EditorView) => aiDraftRanges(v.state).map((r) => v.state.sliceDoc(r.from, r.to));

beforeEach(() => setLang('en'));
afterEach(() => {
  for (const v of views) {
    v.dom.parentElement?.remove();
    v.destroy();
  }
  views = [];
});

describe('insertedRanges', () => {
  it('finds each block of inserted lines, not the researcher text between them', () => {
    const before = '#### Input\n\n#### Reagent\n- mine\n\n#### Method\n';
    const after = '#### Input\n- PRT-1\n\n#### Reagent\n- mine\n\n- LB\n\n#### Method\n1. Add\n2. Shake\n';
    const got = insertedRanges(before, after).map((r) => after.slice(r.from, r.to));
    expect(got).toEqual(['- PRT-1', '- LB', '1. Add\n2. Shake']);
  });

  it('nothing changed: no ranges; a replaced placeholder counts as inserted', () => {
    expect(insertedRanges('a\nb', 'a\nb')).toEqual([]);
    const after = '#### Method\n1. Spin\n';
    expect(insertedRanges('#### Method\n- \n', after).map((r) => after.slice(r.from, r.to))).toEqual(['1. Spin']);
  });

  it('only blank lines inserted: no ranges', () => {
    expect(insertedRanges('a\nb', 'a\n\n\nb')).toEqual([]);
  });
});

describe('aiDraftReview', () => {
  it('marks the inserted lines with a highlight and a Done button, never in the text', () => {
    const before = 'x\n\ny\n';
    const v = view(before);
    v.dispatch({ changes: { from: 2, insert: 'AI line 1\nAI line 2\n' } });
    markAiDraft(v, before);
    expect(slices(v)).toEqual(['AI line 1\nAI line 2']);
    expect(v.dom.querySelectorAll('.cm-ai-draft').length).toBe(2);
    const done = v.dom.querySelector<HTMLButtonElement>('button.cm-ai-draft-done');
    expect(done?.textContent).toBe('Done');
    expect(v.state.doc.toString()).toBe('x\nAI line 1\nAI line 2\n\ny\n');
    done!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(aiDraftRanges(v.state)).toEqual([]);
    expect(v.dom.querySelector('.cm-ai-draft')).toBeNull();
  });

  it('follows edits elsewhere and clears a range the user edits', () => {
    const before = 'a\nb\n';
    const v = view(before);
    v.dispatch({ changes: { from: 2, insert: 'AI one\n' } });
    v.dispatch({ changes: { from: v.state.doc.length, insert: 'c\nAI two\n' } });
    markAiDraft(v, before);
    expect(slices(v)).toEqual(['AI one', 'c\nAI two']);
    v.dispatch({ changes: { from: 0, insert: 'top\n' } }); // outside: both stay, moved
    expect(slices(v)).toEqual(['AI one', 'c\nAI two']);
    const at = v.state.doc.toString().indexOf('AI one') + 2;
    v.dispatch({ changes: { from: at, insert: 'X' } }); // inside the first
    expect(slices(v)).toEqual(['c\nAI two']);
  });

  it('Esc and clearAiDraftReview clear every highlight; Esc is not swallowed', () => {
    const before = 'a\n';
    const v = view(before);
    v.dispatch({ changes: { from: 2, insert: 'AI\n' } });
    markAiDraft(v, before);
    expect(slices(v)).toEqual(['AI']);
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    v.contentDOM.dispatchEvent(esc);
    expect(aiDraftRanges(v.state)).toEqual([]);
    expect(esc.defaultPrevented).toBe(false);
    v.dispatch({ changes: { from: 0, insert: 'AI2\n' } });
    markAiDraft(v, 'a\nAI\n');
    expect(slices(v)).toEqual(['AI2']);
    clearAiDraftReview(v);
    expect(aiDraftRanges(v.state)).toEqual([]);
  });

  it('markAiDraft on a view without the extension does nothing', () => {
    const parent = document.createElement('div');
    const v = new EditorView({ state: EditorState.create({ doc: 'a\nb' }), parent });
    expect(() => markAiDraft(v, 'a')).not.toThrow();
    v.destroy();
  });
});
