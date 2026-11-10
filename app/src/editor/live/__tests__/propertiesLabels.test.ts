// @vitest-environment jsdom
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { history } from '@codemirror/commands';
import { labnoteMarkdown } from '../../markdownSyntax';
import { tableExtension } from '../../table/field';
import { livePreview } from '../index';
import { propertyLabel } from '../properties';
import { setLang } from '../../../i18n/lang';
import { editorThemeSpec } from '../../theme';

// jsdom 에는 레이아웃이 없다. CodeMirror 가 측정에 쓰는 API 만 빈 값으로 채운다.
const emptyRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
Range.prototype.getClientRects ??= emptyRects;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();
document.execCommand ??= () => false;

const views: EditorView[] = [];

function view(doc: string, pos: number): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const v = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor: Math.min(pos, doc.length) },
      extensions: [history(), labnoteMarkdown(), livePreview(), tableExtension({ save: () => {}, root: document })],
    }),
  });
  views.push(v);
  return v;
}

afterEach(() => {
  while (views.length) views.pop()!.destroy();
  document.body.innerHTML = '';
  setLang('ko');
});

const rowEl = (v: EditorView, key: string) =>
  [...v.contentDOM.querySelectorAll<HTMLElement>('.lno-props-row')].find((r) => r.dataset.key === key)!;
const keyText = (v: EditorView, key: string) => {
  const k = rowEl(v, key).querySelector('.lno-props-key');
  return k instanceof HTMLInputElement ? k.value : (k?.textContent ?? '');
};
const valueText = (v: EditorView, key: string) => {
  const el = rowEl(v, key).querySelector('.lno-props-value');
  return el instanceof HTMLInputElement ? el.value : (el?.textContent ?? '');
};

const README = [
  '---',
  'title: 효소 반응',
  'author: 이서연',
  'experiment_type: labnote',
  'status: in-progress',
  'project:',
  "created_date: '2026-11-10 06:57'",
  'last_updated_date: 2026-11-10',
  'tags: [a, b]',
  '---',
  'body',
].join('\n');

describe('propertyLabel', () => {
  it('maps the known keys and leaves unknown keys raw', () => {
    setLang('ko');
    expect(['author', 'experimenter', 'status', 'created', 'created_date', 'date', 'last_updated', 'last_updated_date', 'tags', 'experiment', 'project'].map(propertyLabel)).toEqual(
      ['실험자', '실험자', '상태', '만든 날', '만든 날', '만든 날', '마지막 수정', '마지막 수정', '태그', '실험', '프로젝트'],
    );
    expect(['title', 'labnote_id', 'end_date', 'experiment_type', 'sample_tracking'].map(propertyLabel)).toEqual(['제목', '노트 ID', '끝난 날', '노트 종류', '샘플 추적']);
    expect(propertyLabel('담당')).toBe('담당');
    setLang('en');
    expect(['author', 'status', 'created_date', 'last_updated_date', 'tags', 'experiment', 'project'].map(propertyLabel)).toEqual(
      ['Experimenter', 'Status', 'Created', 'Last updated', 'Tags', 'Experiment', 'Project'],
    );
  });
});

describe('properties card', () => {
  it('shows localised labels; the raw key stays in data-key and the tooltip', () => {
    const v = view(README, README.length);
    expect(keyText(v, 'author')).toBe('실험자');
    expect(keyText(v, 'status')).toBe('상태');
    expect(keyText(v, 'created_date')).toBe('만든 날');
    expect(keyText(v, 'last_updated_date')).toBe('마지막 수정');
    expect(keyText(v, 'tags')).toBe('태그');
    expect(keyText(v, 'project')).toBe('프로젝트');
    expect(keyText(v, 'experiment_type')).toBe('노트 종류');
    expect(keyText(v, 'title')).toBe('제목');
    expect(rowEl(v, 'author').querySelector<HTMLElement>('.lno-props-key')!.title).toBe('author');
  });

  it('the document text is byte-identical after a render and after editing another field', () => {
    const v = view(README, README.length);
    expect(v.state.doc.toString()).toBe(README);
    const title = rowEl(v, 'title').querySelector<HTMLInputElement>('input.lno-props-value')!;
    title.focus();
    title.value = '효소 반응 2';
    title.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(v.state.doc.toString()).toBe(README.replace('title: 효소 반응', 'title: 효소 반응 2'));
    expect(keyText(v, 'author')).toBe('실험자');
  });

  it('status shows a localised chip; the stored value is unchanged', () => {
    const v = view(README, README.length);
    const chip = rowEl(v, 'status').querySelector<HTMLElement>('.lno-chip')!;
    expect(chip.textContent).toBe('진행 중');
    expect(chip.classList.contains('lno-status-inProgress')).toBe(true);
    expect(v.state.doc.toString()).toContain('status: in-progress');
    // a programmatic change redraws the chip in place, still localised
    const at = v.state.doc.toString().indexOf('in-progress');
    v.dispatch({ changes: { from: at, to: at + 'in-progress'.length, insert: 'done' } });
    const after = rowEl(v, 'status').querySelector<HTMLElement>('.lno-chip')!;
    expect(after.textContent).toBe('완료');
    expect(after.classList.contains('lno-status-done')).toBe(true);
  });

  it('a quoted value is shown without its quotes', () => {
    const v = view(README, README.length);
    expect(valueText(v, 'created_date')).toBe('2026-11-10 06:57');
    const doc = "---\nnote: '2026-11-10 06:57'\nother: \"x y\"\n---\nb";
    const w = view(doc, doc.length);
    expect(valueText(w, 'note')).toBe('2026-11-10 06:57');
    expect(valueText(w, 'other')).toBe('x y');
  });

  it('the card has the two-col class and the theme drops to one column below 680px', () => {
    const v = view(README, README.length);
    expect(v.contentDOM.querySelector('.lno-props')!.classList.contains('two-col')).toBe(true);
    const spec = editorThemeSpec as Record<string, unknown>;
    const query = spec['@container (max-width: 680px)'] as Record<string, Record<string, string>> | undefined;
    expect(query).toBeDefined();
    expect(query!['.lno-props.two-col']).toMatchObject({ gridTemplateColumns: '1fr' });
    expect((spec['.lno-props-wrap'] as Record<string, string>).containerType).toBe('inline-size');
  });
});

describe('UO Meta Experimenter label', () => {
  const UO = ['### [UHW010 Liquid Handling] 분주', '#### Meta', '- Experimenter: 이서연', "- Start_date: '2026-11-10 06:57'", 'end'].join('\n');
  const line = (v: EditorView, n: number) => v.contentDOM.querySelectorAll<HTMLElement>('.cm-line')[n - 1].textContent;

  it('shows 실험자 for "Experimenter:" (display only)', () => {
    const v = view(UO, UO.length);
    expect(line(v, 3)).toContain('실험자: 이서연');
    expect(line(v, 3)).not.toContain('Experimenter');
    expect(v.state.doc.toString()).toBe(UO);
  });

  it('shows the source on the line holding the cursor', () => {
    const at = UO.indexOf('이서연');
    const v = view(UO, at);
    expect(line(v, 3)).toContain('Experimenter: 이서연');
  });

  it('shows Experimenter in English', () => {
    setLang('en');
    const v = view(UO, UO.length);
    expect(line(v, 3)).toContain('Experimenter: 이서연');
  });
});
