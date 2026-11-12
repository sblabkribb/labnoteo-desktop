// @vitest-environment jsdom
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { history, undo } from '@codemirror/commands';
import { labnoteMarkdown } from '../../markdownSyntax';
import { livePreview, readmeEmptyState } from '../index';
import { toggleTaskAt } from '../widgets';
import { setLang } from '../../../i18n/lang';
import { checklistTickWatch, type ChecklistCounts } from '../../../labnote/commands/statusNudge';

const emptyRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
Range.prototype.getClientRects ??= emptyRects;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();

const views: EditorView[] = [];

function view(doc: string, extra: Extension, live = true): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const v = new EditorView({
    parent,
    state: EditorState.create({ doc, extensions: [history(), labnoteMarkdown(), ...(live ? [livePreview()] : []), extra] }),
  });
  views.push(v);
  return v;
}

beforeEach(() => setLang('ko'));
afterEach(() => {
  while (views.length) views.pop()!.destroy();
  document.body.innerHTML = '';
});

const README = (entries: string[], status = 'planned') =>
  [
    '---',
    'title: GFP assay',
    `status: ${status}`,
    '---',
    '',
    '## 🎯 Experiment Objective',
    '> Briefly describe the main objective and hypothesis of this experiment.',
    '',
    '## 🗂️ Related Workflows',
    '',
    ...entries,
    '',
    '## Summary and Discussion',
    '',
  ].join('\n');

const ENTRY = (n: number, box = ' ') => `- [${box}] [[00${n}_WB030_DNA_Assembly.labnote.md|WB030 step ${n}]]`;
const card = (v: EditorView) => v.dom.querySelector('.lno-empty-state');

describe('README empty-state card', () => {
  it('shows under Related Workflows while the checklist is empty, and its button calls onAddWorkflow', () => {
    const onAddWorkflow = vi.fn();
    const v = view(README([]), readmeEmptyState.of({ onAddWorkflow }));
    const c = card(v);
    expect(c).not.toBeNull();
    expect(c!.textContent).toContain('아직 Workflow가 없습니다');
    const button = c!.querySelector('button')!;
    expect(button.textContent).toBe('첫 Workflow 추가');
    expect(button.getAttribute('style')).toBeNull();
    button.click();
    expect(onAddWorkflow).toHaveBeenCalledTimes(1);
    // the file is not changed by the drawing
    expect(v.state.doc.toString()).toBe(README([]));
  });

  it('goes away when the checklist gets an entry', () => {
    const v = view(README([]), readmeEmptyState.of({ onAddWorkflow: () => {} }));
    const at = v.state.doc.toString().indexOf('## Summary');
    v.dispatch({ changes: { from: at, insert: `${ENTRY(1)}\n\n` } });
    expect(card(v)).toBeNull();
  });

  it('is not drawn for notes without the facet, with entries, or in source mode', () => {
    expect(card(view(README([]), []))).toBeNull();
    expect(card(view(README([ENTRY(1)]), readmeEmptyState.of({ onAddWorkflow: () => {} })))).toBeNull();
    expect(card(view(README([]), readmeEmptyState.of({ onAddWorkflow: () => {} }), false))).toBeNull();
  });

  it('is not drawn when the checklist only has legacy lines (.md links, wikilinks without .labnote) or bare core lines', () => {
    const facet = readmeEmptyState.of({ onAddWorkflow: () => {} });
    expect(card(view(README(['[x] [WD090 Old design](./001_WD090_Old_design.md)']), facet))).toBeNull();
    expect(card(view(README(['[ ] [[002_WB010_Old_assembly]]']), facet))).toBeNull();
    expect(card(view(README(['[ ] [001 WD090 Design](./001_WD090_Design.labnote.md)']), facet))).toBeNull();
    // 체크리스트 줄이 아닌 글만 있으면 카드는 그대로
    expect(card(view(README(['Some text, [x] not an entry']), facet))).not.toBeNull();
  });
});

describe('checklistTickWatch', () => {
  it('reports a checkbox tick with the counts before and after; undo is not reported', () => {
    const ticks: Array<[ChecklistCounts, ChecklistCounts]> = [];
    const doc = README([ENTRY(1), ENTRY(2), ENTRY(3)]);
    const v = view(doc, checklistTickWatch((a, b) => ticks.push([a, b])));
    toggleTaskAt(v, doc.indexOf('- [ ]') + 2);
    expect(ticks).toEqual([[{ done: 0, total: 3, status: 'planned' }, { done: 1, total: 3, status: 'planned' }]]);
    undo(v);
    expect(ticks).toHaveLength(1);
  });

  it('ignores command writes (input.labnote) and edits elsewhere', () => {
    const ticks: unknown[] = [];
    const doc = README([ENTRY(1)]);
    const v = view(doc, checklistTickWatch((a, b) => ticks.push([a, b])));
    const box = doc.indexOf('- [ ]') + 3;
    v.dispatch({ changes: { from: box, to: box + 1, insert: 'x' }, userEvent: 'input.labnote' });
    v.dispatch({ changes: { from: doc.length, insert: 'more' }, userEvent: 'input.type' });
    expect(ticks).toEqual([]);
  });
});
