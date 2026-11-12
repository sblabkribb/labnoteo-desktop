// @vitest-environment jsdom
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { history, undoDepth } from '@codemirror/commands';
import { labnoteMarkdown } from '../../markdownSyntax';
import { tableExtension } from '../../table/field';
import { livePreview, readmeEmptyState } from '../index';
import { editorLang } from '../editorLang';
import { setLang, type Lang } from '../../../i18n/lang';
import { activeCellView, focusCell } from '../../table/cellEditor';
import { openTableMenu } from '../../table/widget';

// jsdom 에는 레이아웃이 없다. CodeMirror 가 측정에 쓰는 API 만 빈 값으로 채운다.
const emptyRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
Range.prototype.getClientRects ??= emptyRects;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();
document.execCommand ??= () => false;

const views: EditorView[] = [];
const slot = new Compartment();

function view(doc: string, extra: Extension = []): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const v = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: [
        history(),
        labnoteMarkdown(),
        livePreview(),
        tableExtension({ save: () => {}, root: document }),
        slot.of(editorLang.of('ko')),
        extra,
      ],
    }),
  });
  views.push(v);
  return v;
}

/** Editor.tsx 가 하는 것과 같다: 저장소의 언어를 바꾸고 편집기의 언어 칸을 갈아 끼운다. */
function switchTo(v: EditorView, lang: Lang): void {
  setLang(lang);
  v.dispatch({ effects: slot.reconfigure(editorLang.of(lang)) });
}

beforeEach(() => setLang('ko'));
afterEach(() => {
  while (views.length) views.pop()!.destroy();
  document.body.innerHTML = '';
  setLang('ko');
});

const NOTE = [
  '## [WB150 PCR-based Target Amplification] GFP amplification',
  '',
  '### [UHW010 Liquid Handling] mix',
  '',
  '#### Meta',
  '- Experimenter: Alex',
  "- Start_date: '2020-01-03 10:15'",
  "- End_date: '2020-01-03 12:00'",
  '',
  '### [UHW020 Mixing] stir',
  '',
  '#### Meta',
  "- Start_date: ''",
  '',
  '---',
  '',
  'See [the site](https://example.org) and ![](nope.png).',
  '',
  '| A | B |',
  '| --- | --- |',
  '| 1 | 2 | 3 |',
  '',
  'end',
].join('\n');

const TABLE = ['| A | B |', '| --- | --- |', '| 1 | 2 |', '', 'end'].join('\n');

const q = (v: EditorView, sel: string) => v.dom.querySelector<HTMLElement>(sel);

describe('live preview widgets follow the editor language', () => {
  it('UO status chips, date chips, the Experimenter label, link titles, image and table text relabel ko → en → ko', () => {
    const v = view(NOTE);
    const ko = () => {
      expect(q(v, '.lno-uo-status')?.textContent).toBe('완료');
      expect(q(v, '.lno-uo-status')?.title).toBe('UO 상태: 완료');
      expect(q(v, '.lno-date-empty')?.textContent).toBe('날짜 고르기');
      expect(q(v, '.lno-meta-label')?.textContent).toBe('실험자');
      expect(q(v, '.lno-link')?.title).toBe('클릭으로 열기');
      expect(q(v, '.lno-image-missing')?.textContent).toBe('이미지를 찾을 수 없습니다: nope.png');
      expect(q(v, '.lno-cell-overflow')?.title).toContain('머리 행보다');
    };
    ko();
    const before = { doc: v.state.doc.toString(), undo: undoDepth(v.state), sel: v.state.selection.main.head };

    switchTo(v, 'en');
    expect(q(v, '.lno-uo-status')?.textContent).toBe('Done');
    expect(q(v, '.lno-uo-status')?.title).toBe('UO status: Done');
    expect(q(v, '.lno-date-empty')?.textContent).toBe('Pick a date');
    // 영어에서는 원문 그대로다(같은 낱말이라 바꿀 것이 없다)
    expect(q(v, '.lno-meta-label')).toBeNull();
    expect(v.dom.textContent).toContain('Experimenter: Alex');
    expect(q(v, '.lno-link')?.title).toBe('Click to open');
    expect(q(v, '.lno-image-missing')?.textContent).toBe('Image not found: nope.png');
    expect(q(v, '.lno-cell-overflow')?.title).toContain('Extra cell');
    expect(v.dom.textContent).not.toMatch(/완료|날짜 고르기|실험자/);
    // 본문, 되돌리기, 커서는 그대로다
    expect(v.state.doc.toString()).toBe(before.doc);
    expect(undoDepth(v.state)).toBe(before.undo);
    expect(v.state.selection.main.head).toBe(before.sel);

    switchTo(v, 'ko');
    ko();
  });

  it('the image is not reloaded on a switch: only the text changes in place', () => {
    const v = view(NOTE);
    const wrap = q(v, '.lno-image-wrap');
    switchTo(v, 'en');
    expect(q(v, '.lno-image-wrap')).toBe(wrap);
  });

  it('an open cell editor relabels and stays open in the same table', () => {
    const v = view(TABLE);
    expect(focusCell(v, 0, 1, 0)).toBe(true);
    const nested = activeCellView(v)!;
    expect(nested.contentDOM.getAttribute('aria-label')).toBe('표 칸 편집');
    const table = q(v, 'table.lno-table');

    switchTo(v, 'en');
    expect(activeCellView(v)).toBe(nested);
    expect(nested.contentDOM.getAttribute('aria-label')).toBe('Table cell');
    expect(q(v, 'table.lno-table')).toBe(table);
  });

  it('an open table menu relabels', () => {
    const v = view(TABLE);
    expect(openTableMenu(v, q(v, 'table.lno-table td')!, () => {})).toBe(true);
    expect(q(v, '.lno-table-menu')?.getAttribute('aria-label')).toBe('표 메뉴');
    switchTo(v, 'en');
    expect(q(v, '.lno-table-menu')?.getAttribute('aria-label')).toBe('Table menu');
    expect(q(v, '.lno-table-menu button[data-action="insertRowBelow"]')?.textContent).toBe('Add row below');
  });

  it('the README empty-state card relabels', () => {
    const doc = ['---', 'title: x', '---', '', '## 🗂️ Related Workflows', '', '', '## Summary', ''].join('\n');
    const v = view(doc, readmeEmptyState.of({ onAddWorkflow: () => {} }));
    expect(q(v, '.lno-empty-state-add')?.textContent).toBe('첫 Workflow 추가');
    switchTo(v, 'en');
    expect(q(v, '.lno-empty-state-add')?.textContent).toBe('Add the first workflow');
  });

  it('a language transaction changes nothing else: no text, no selection, no scroll, no undo step', () => {
    const v = view(NOTE);
    const seen: { doc: boolean; sel: boolean; scroll: boolean }[] = [];
    v.dispatch({ effects: slot.reconfigure([editorLang.of('ko'), EditorView.updateListener.of((u) => {
      for (const tr of u.transactions) seen.push({ doc: tr.docChanged, sel: !!tr.selection, scroll: tr.scrollIntoView });
    })]) });
    seen.length = 0;
    setLang('en');
    v.dispatch({ effects: slot.reconfigure([editorLang.of('en'), EditorView.updateListener.of((u) => {
      for (const tr of u.transactions) seen.push({ doc: tr.docChanged, sel: !!tr.selection, scroll: tr.scrollIntoView });
    })]) });
    expect(seen).toEqual([{ doc: false, sel: false, scroll: false }]);
    expect(undoDepth(v.state)).toBe(0);
  });
});

describe('README checklist checkboxes follow the editor language', () => {
  it('a bare Related Workflows box relabels ko → en and stays a box', () => {
    const doc = ['## Related Workflows', '', '[ ] [001 WD090 X](./001_WD090_X.labnote.md)', '', 'end'].join('\n');
    const v = view(doc);
    expect(q(v, 'input.lno-task')?.getAttribute('aria-label')).toBe('할 일 완료 전환');
    switchTo(v, 'en');
    expect(q(v, 'input.lno-task')?.getAttribute('aria-label')).toBe('Toggle task');
    expect(v.state.doc.toString()).toBe(doc);
  });
});
