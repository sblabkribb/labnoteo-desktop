// @vitest-environment jsdom
/**
 * 실제 Editor 로 속성이 있는 README 를 열고 ko → en → ko 로 바꾼다. 글을 그리는 위젯이 모두 바뀌는지, 그리고 본문, 저장 안 됨 표시,
 * 되돌리기 기록(바꾼 뒤의 되돌리기가 바로 앞 편집을 되돌린다), 선택, 스크롤이 그대로인지 한 번에 본다.
 */
import { createRef } from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
import { isolateHistory, redo, undo, undoDepth } from '@codemirror/commands';
import { Editor, type EditorHandle } from '../Editor';
import { ERROR_KINDS_FIXTURE } from '../../__tests__/fixtures';
import { setLang } from '../../i18n/lang';
import { setMode } from '../live/mode';
import { sampleTypesFor } from '../../samples/types';
import type { SampleEditorConfig } from '../../samples/editorConfig';
import { KNOWN } from '../../samples/__tests__/fixtures';

const emptyRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
Range.prototype.getClientRects ??= emptyRects;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();
document.execCommand ??= () => false;

const P = 'labnote/001_x/README.labnote.md';

const README = [
  '---',
  'title: Demo',
  'author: Kim',
  'status: Planned',
  '---',
  '# Demo',
  '',
  '## 🗂️ Related Workflows',
  '',
  '',
  '## Summary',
  '',
  '- [ ] task one',
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
  'See [the site](https://example.org) and ![](nope.png). Uses DNA-9.',
  '',
  '| A | B |',
  '| --- | --- |',
  '| 1 | 2 | 3 |',
  '',
  'end',
  '',
].join('\n');

const samples: SampleEditorConfig = {
  enabled: () => true,
  types: sampleTypesFor({ customSampleTypes: [] }),
  known: () => KNOWN,
  version: KNOWN.version,
};

function mount() {
  const files: Record<string, string> = { [P]: README };
  const invoke = (async (cmd: string, args: Record<string, unknown>) => {
    const path = args.path as string;
    if (cmd === 'vault_read' && path in files) return files[path];
    if (cmd === 'vault_modify') {
      files[path] = args.content as string;
      return { kind: 'ok' };
    }
    throw { kind: ERROR_KINDS_FIXTURE.notFound, message: `${cmd} ${path}` };
  }) as never;
  const listen = (async () => () => undefined) as never;
  const ref = createRef<EditorHandle>();
  const utils = render(
    <Editor ref={ref} path={P} invoke={invoke} listen={listen} autosaveMs={60_000} samples={samples} onAddWorkflow={() => {}} />,
  );
  const root = () => (utils.container.querySelector('.editor-frame') as HTMLElement).shadowRoot!;
  const view = () => EditorView.findFromDOM(root().querySelector('.cm-editor') as HTMLElement)!;
  return { files, ref, root, view };
}

type Lang = 'ko' | 'en';
const switchTo = (lang: Lang) => act(async () => setLang(lang));
const tick = () => act(async () => new Promise((r) => setTimeout(r, 0)));

/** 확인하는 위젯과 언어별 기대값. 이름이 곧 보고서 목록이다. */
const WIDGETS: { name: string; read: (r: ShadowRoot) => string | null | undefined; ko: string | RegExp; en: string | RegExp }[] = [
  { name: 'editor area aria-label', read: (r) => r.querySelector('.cm-content')?.getAttribute('aria-label'), ko: /[가-힣]/, en: /^[^가-힣]+$/ },
  { name: 'properties grid aria-label', read: (r) => r.querySelector('.lno-props')?.getAttribute('aria-label'), ko: /[가-힣]/, en: 'Properties' },
  { name: 'properties "Edit as YAML" button', read: (r) => r.querySelector('.lno-props-head button')?.textContent, ko: 'YAML로 편집', en: 'Edit as YAML' },
  { name: 'properties "Add property"', read: (r) => (r.querySelector('.lno-props')?.textContent?.includes('속성 추가') ? '속성 추가' : r.querySelector('.lno-props')?.textContent?.includes('Add property') ? 'Add property' : null), ko: '속성 추가', en: 'Add property' },
  { name: 'properties key label (author)', read: (r) => r.querySelector('.lno-props-row[data-key="author"] .lno-props-key')?.textContent, ko: '실험자', en: 'Experimenter' },
  { name: 'README empty-state card button', read: (r) => r.querySelector('.lno-empty-state-add')?.textContent, ko: '첫 Workflow 추가', en: 'Add the first workflow' },
  { name: 'task checkbox aria-label', read: (r) => r.querySelector('input.lno-task')?.getAttribute('aria-label'), ko: '할 일 완료 전환', en: 'Toggle task' },
  { name: 'UO status chip text', read: (r) => r.querySelector('.lno-uo-status')?.textContent, ko: '완료', en: 'Done' },
  { name: 'UO status chip title', read: (r) => r.querySelector<HTMLElement>('.lno-uo-status')?.title, ko: 'UO 상태: 완료', en: 'UO status: Done' },
  { name: 'empty date chip', read: (r) => r.querySelector('.lno-date-empty')?.textContent, ko: '날짜 고르기', en: 'Pick a date' },
  { name: 'Meta "Experimenter" label', read: (r) => r.querySelector('.lno-meta-label')?.textContent ?? (r.querySelector('.cm-content')?.textContent?.includes('Experimenter: Alex') ? 'raw:Experimenter' : null), ko: '실험자', en: 'raw:Experimenter' },
  { name: 'link title', read: (r) => r.querySelector<HTMLElement>('.lno-link')?.title, ko: '클릭으로 열기', en: 'Click to open' },
  { name: 'missing-image text', read: (r) => r.querySelector('.lno-image-missing')?.textContent, ko: '이미지를 찾을 수 없습니다: nope.png', en: 'Image not found: nope.png' },
  { name: 'table extra-cell title', read: (r) => r.querySelector<HTMLElement>('.lno-cell-overflow')?.title, ko: /머리 행보다/, en: /Extra cell/ },
  { name: 'table toolbar aria-label', read: (r) => r.querySelector('.lno-table-toolbar')?.getAttribute('aria-label'), ko: '표 도구', en: 'Table tools' },
  { name: 'table toolbar button aria-label', read: (r) => r.querySelector('.lno-table-toolbar button[data-action="insertRowBelow"]')?.getAttribute('aria-label'), ko: '아래에 행 추가', en: 'Add row below' },
  { name: 'sample ID title (not in registry)', read: (r) => r.querySelector('.lno-sample-id-missing')?.getAttribute('title'), ko: /[가-힣]/, en: 'Not in the sample registry' },
];

function checkAll(root: ShadowRoot, lang: Lang): string[] {
  const report: string[] = [];
  for (const w of WIDGETS) {
    const got = w.read(root);
    const want = w[lang];
    if (want instanceof RegExp) expect(got, w.name).toMatch(want);
    else expect(got, w.name).toBe(want);
    report.push(`${lang} | ${w.name} = ${JSON.stringify(got)}`);
  }
  return report;
}

beforeEach(() => {
  setLang('ko');
  setMode('live');
});
afterAll(() => setLang('ko'));

describe('real Editor: README with properties, ko → en → ko', () => {
  it('every widget flips; doc, dirty, undo history, selection and scroll stay', async () => {
    const m = mount();
    await waitFor(() => expect(m.root().querySelector('.lno-props')).not.toBeNull());
    await waitFor(() => expect(m.root().querySelector('.lno-image-missing')).not.toBeNull());
    await waitFor(() => expect(m.root().querySelector('.lno-sample-id-missing')).not.toBeNull());
    const v = m.view();

    // 두 번의 따로 된 편집: 되돌리기 한 번이 둘째만 되돌려야 한다
    await act(async () => v.dispatch({ changes: { from: v.state.doc.length, insert: 'A' }, userEvent: 'input.type', annotations: isolateHistory.of('full') }));
    const afterA = v.state.doc.toString();
    await act(async () => v.dispatch({ changes: { from: v.state.doc.length, insert: 'B' }, userEvent: 'input.type', annotations: isolateHistory.of('full') }));
    const afterB = v.state.doc.toString();
    expect(undoDepth(v.state)).toBe(2);

    // 선택(범위)과 스크롤 자리
    const anchor = v.state.doc.line(8).from; // '## 🗂️ Related Workflows' 줄 안의 범위
    await act(async () => v.dispatch({ selection: { anchor, head: anchor + 3 } }));
    v.scrollDOM.scrollTop = 137;
    v.scrollDOM.scrollLeft = 11;
    const scrollBefore = { top: v.scrollDOM.scrollTop, left: v.scrollDOM.scrollLeft };

    const scrollTx: boolean[] = [];
    const seen = (tr: { scrollIntoView: boolean; docChanged: boolean; selection: unknown }) => scrollTx.push(tr.scrollIntoView || tr.docChanged || !!tr.selection);
    // 언어 바꾸기가 보내는 트랜잭션을 엿본다(본문·선택·스크롤 요청이 없어야 한다)
    const spy = vi.spyOn(v, 'update').mockImplementation(function (this: EditorView, trs) {
      for (const tr of trs) seen(tr);
      return EditorView.prototype.update.call(this, trs);
    });

    const report: string[] = [];
    report.push(...checkAll(m.root(), 'ko'));
    const snap = () => ({
      doc: v.state.doc.toString(),
      dirty: m.ref.current!.isDirty(),
      undo: undoDepth(v.state),
      sel: [v.state.selection.main.anchor, v.state.selection.main.head],
      scroll: { top: v.scrollDOM.scrollTop, left: v.scrollDOM.scrollLeft },
    });
    const before = snap();
    expect(before.doc).toBe(afterB);
    expect(before.dirty).toBe(true);
    expect(before.scroll).toEqual(scrollBefore);

    await switchTo('en');
    await tick();
    expect(m.view()).toBe(v);
    report.push(...checkAll(m.root(), 'en'));
    expect(m.root().textContent).not.toMatch(/YAML로 편집|속성 추가|첫 Workflow 추가|날짜 고르기|이미지를 찾을 수 없습니다/);
    expect(snap()).toEqual(before);

    await switchTo('ko');
    await tick();
    expect(m.view()).toBe(v);
    report.push(...checkAll(m.root(), 'ko'));
    expect(m.root().textContent).not.toMatch(/Edit as YAML|Add property|Add the first workflow|Pick a date|Image not found/);
    expect(snap()).toEqual(before);

    // 언어 트랜잭션은 본문도 선택도 스크롤 요청도 담지 않았다
    expect(scrollTx.length).toBeGreaterThanOrEqual(2);
    expect(scrollTx.every((x) => !x)).toBe(true);
    spy.mockRestore();

    // 바꾼 뒤 되돌리기: 바로 앞 편집(B)만 되돌린다. 영어로 한 번 더 바꾼 뒤 다시 하기도 된다.
    await act(async () => void undo(v));
    expect(v.state.doc.toString()).toBe(afterA);
    expect(m.ref.current!.isDirty()).toBe(true);
    await switchTo('en');
    await tick();
    await act(async () => void redo(v));
    expect(v.state.doc.toString()).toBe(afterB);
    await act(async () => void undo(v));
    await act(async () => void undo(v));
    expect(v.state.doc.toString()).toBe(README);
    expect(m.ref.current!.isDirty()).toBe(false);

    // eslint-disable-next-line no-console
    console.log(`WIDGETS CHECKED (${WIDGETS.length}):\n${report.join('\n')}\nSTATE before/after: ${JSON.stringify({ ...before, doc: `${before.doc.length} chars` })}`);
  });
});
