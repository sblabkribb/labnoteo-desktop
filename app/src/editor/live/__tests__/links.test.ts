// @vitest-environment jsdom
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { labnoteMarkdown } from '../../markdownSyntax';
import { tableExtension } from '../../table/field';
import { livePreview } from '../index';
import { linkClickHandler, resolveNoteLink, unitOpHeading } from '../links';
import { t } from '../../../i18n/t';

// jsdom 에는 레이아웃이 없다. CodeMirror 가 측정에 쓰는 API 만 빈 값으로 채운다.
const emptyRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
Range.prototype.getClientRects ??= emptyRects;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();

const views: EditorView[] = [];
let opened: Array<{ path: string; anchor?: string }> = [];
let toasts: string[] = [];
let revealed: number[] = [];

/** 'exp/a.labnote.md' 노트를 연 편집기: 라이브 미리보기, 표, Ctrl+클릭 처리. */
function view(doc: string, pos: number): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const v = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor: Math.min(pos, doc.length) },
      extensions: [
        EditorState.lineSeparator.of('\n'),
        labnoteMarkdown(),
        livePreview(),
        tableExtension({ save: () => {}, root: document }),
        linkClickHandler({
          notePath: () => 'exp/a.labnote.md',
          onOpenLink: (target) => opened.push(target),
          toast: (m) => toasts.push(m),
          reveal: (line) => revealed.push(line),
        }),
      ],
    }),
  });
  views.push(v);
  return v;
}

beforeEach(() => {
  opened = [];
  toasts = [];
  revealed = [];
});
afterEach(() => {
  while (views.length) views.pop()!.destroy();
  document.body.innerHTML = '';
});

const lineEl = (v: EditorView, n: number) => v.contentDOM.querySelectorAll<HTMLElement>('.cm-line')[n - 1];
const visibleText = (v: EditorView, n: number) => lineEl(v, n).textContent;
function ctrlDown(el: Element): MouseEvent {
  const ev = new MouseEvent('mousedown', { bubbles: true, cancelable: true, ctrlKey: true, button: 0 });
  el.dispatchEvent(ev);
  return ev;
}

describe('라이브 미리보기: 링크와 유닛 오퍼레이션 제목', () => {
  it('### [UHW010 PCR] alias renders a chip, never a link', () => {
    const v = view('### [UHW010 PCR] alias\nx', 24);
    const chip = v.contentDOM.querySelector('.lno-uo-code')!;
    expect(chip.textContent).toBe('UHW010');
    expect(chip.classList.contains('lno-chip')).toBe(true);
    expect(chip.classList.contains('lno-uo-uhw')).toBe(true);
    expect(v.contentDOM.querySelector('.lno-link')).toBeNull();
    expect(visibleText(v, 1)).toBe('UHW010 PCR alias');
  });

  it('the cursor on a unit-operation heading line shows its source, still with the chip', () => {
    const v = view('### [UHW010 PCR] alias\nx', 5);
    expect(visibleText(v, 1)).toBe('### [UHW010 PCR] alias');
    expect(v.contentDOM.querySelector('.lno-uo-code')!.textContent).toBe('UHW010');
  });

  it('## [WB010 name] gets the WB chip', () => {
    const v = view('## [WB010 DNA 올리고머 조립] 별칭\nx', 26);
    expect(v.contentDOM.querySelector('.lno-uo-wb')!.textContent).toBe('WB010');
    expect(visibleText(v, 1)).toBe('WB010 DNA 올리고머 조립 별칭');
  });

  it('[label](./b.labnote.md) shows the label; Ctrl+click opens the vault path and keeps one selection', () => {
    const v = view('[label](./b.labnote.md)\nx', 25);
    expect(visibleText(v, 1)).toBe('label');
    const link = v.contentDOM.querySelector('.lno-link')!;
    expect(link.getAttribute('title')).toBe(t('live.link.title'));
    const ev = ctrlDown(link);
    expect(opened).toEqual([{ path: 'exp/b.labnote.md' }]);
    expect(ev.defaultPrevented).toBe(true);
    expect(v.state.selection.ranges.length).toBe(1);
    expect(v.state.selection.main.head).toBe(25);
  });

  it('a link to another note with #anchor passes the anchor', () => {
    const v = view('[s](./b.labnote.md#step-1)\nx', 28);
    ctrlDown(v.contentDOM.querySelector('.lno-link')!);
    expect(opened).toEqual([{ path: 'exp/b.labnote.md', anchor: 'step-1' }]);
  });

  it('an #anchor link reveals the heading in this note', () => {
    const v = view('[go](#step-2)\n\n## Step 2\nx', 25);
    ctrlDown(v.contentDOM.querySelector('.lno-link')!);
    expect(revealed).toEqual([2]);
    expect(opened).toEqual([]);
  });

  it('an #anchor link to a missing heading toasts instead of doing nothing', () => {
    const v = view('[go](#nowhere)\n\n## Step 2\nx', 26);
    ctrlDown(v.contentDOM.querySelector('.lno-link')!);
    expect(revealed).toEqual([]);
    expect(toasts).toEqual([t('live.link.anchorMissing')]);
  });

  it('a plain click on a rendered link does nothing special', () => {
    const v = view('[label](./b.labnote.md)\nx', 25);
    const ev = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 });
    v.contentDOM.querySelector('.lno-link')!.dispatchEvent(ev);
    expect(opened).toEqual([]);
  });

  it('[[target|alias]] shows the alias only, styled, with no navigation', () => {
    const v = view('[[target|alias]]\nx', 18);
    expect(visibleText(v, 1)).toBe('alias');
    expect(v.contentDOM.querySelector('.lno-wikilink')!.textContent).toBe('alias');
    ctrlDown(v.contentDOM.querySelector('.lno-wikilink')!);
    expect(opened).toEqual([]);
  });

  it('[[target]] shows the target, and the cursor touching it shows the source', () => {
    const v = view('a [[target]] b\nx', 16);
    expect(visibleText(v, 1)).toBe('a target b');
    v.dispatch({ selection: { anchor: 3 } });
    expect(visibleText(v, 1)).toBe('a [[target]] b');
  });

  it("'see [1] here' renders unchanged", () => {
    const v = view('see [1] here\nx', 14);
    expect(visibleText(v, 1)).toBe('see [1] here');
    expect(v.contentDOM.querySelector('.lno-link')).toBeNull();
  });

  it('Ctrl+click on an external link shows the later-version toast and opens nothing', () => {
    const v = view('[d](https://doi.org/10.1/x)\nx', 29);
    ctrlDown(v.contentDOM.querySelector('.lno-link')!);
    expect(toasts).toEqual([t('live.link.externalLater')]);
    expect(opened).toEqual([]);
  });

  it('a reference link renders and opens its definition target', () => {
    const v = view('[x][ref]\n\n[ref]: ./c.labnote.md\nz', 31);
    expect(visibleText(v, 1)).toBe('x');
    ctrlDown(v.contentDOM.querySelector('.lno-link')!);
    expect(opened).toEqual([{ path: 'exp/c.labnote.md' }]);
  });

  it('resolveNoteLink rejects escapes and classifies external', () => {
    expect(resolveNoteLink('a/n.md', '../../x.md')).toBeNull();
    expect(resolveNoteLink('a/n.md', 'https://x')).toEqual({ kind: 'external' });
    expect(resolveNoteLink('a/n.md', '#h')).toEqual({ kind: 'anchor', anchor: 'h' });
    expect(resolveNoteLink('a/n.md', '../x.md')).toEqual({ kind: 'note', path: 'x.md' });
    expect(resolveNoteLink('a/n.md', 'b%20c.md')).toEqual({ kind: 'note', path: 'a/b c.md' });
    expect(resolveNoteLink('a/n.md', 'C:/x.md')).toBeNull();
    expect(resolveNoteLink('a/n.md', '..\\x.md')).toBeNull();
  });

  it('unitOpHeading finds the code span and kind', () => {
    expect(unitOpHeading('### [USW020 분석] a\r')).toMatchObject({ codeFrom: 5, codeTo: 11, kind: 'USW' });
    expect(unitOpHeading('## [WT010 x]')).toMatchObject({ codeFrom: 4, codeTo: 9, kind: 'other' });
    expect(unitOpHeading('### plain')).toBeNull();
  });

  it('unitOpHeading puts close on the bracket when the name is only whitespace', () => {
    expect(unitOpHeading('### [UHW010  ]')).toMatchObject({ open: 4, close: 13 });
    expect(unitOpHeading('## [WB010  ]')).toMatchObject({ open: 3, close: 11 });
    expect(unitOpHeading('### [UHW010 　]')).toMatchObject({ open: 4, close: 13 });
    expect(unitOpHeading('### [UHW010  ]]')).toMatchObject({ close: 14 });
  });

  it.each(['### [UHW010  ]', '## [WB010  ]', '### [UHW010 　]'])(
    'whitespace-only name %j does not crash, cursor off the line or moving off it',
    (head) => {
      const doc = `${head}\nx`;
      const v = view(doc, doc.length);
      expect(lineEl(v, 1).textContent).not.toContain(']');
      const w = view(doc, 2);
      expect(() => w.dispatch({ selection: { anchor: doc.length } })).not.toThrow();
      expect(lineEl(w, 1).textContent).not.toContain(']');
    },
  );
});
