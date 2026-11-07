// @vitest-environment jsdom
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { labnoteMarkdown } from '../../markdownSyntax';
import { tableExtension } from '../../table/field';
import { livePreview } from '../index';
import {
  followLinkAtCursor,
  linkAt,
  linkClickHandler,
  resolveNoteLink,
  targetOf,
  unitOpHeading,
  type LinkOpenDeps,
  type OpenTarget,
} from '../links';
import { linkResolution, type LinkResolution } from '../linkResolution';
import { imageLoader } from '../imageWidget';
import { vaultImages } from '../vaultImages';
import { createResolver } from '../../../links/resolve';
import { setComposing } from '../../__tests__/composing';
import { t } from '../../../i18n/t';

// jsdom 에는 레이아웃이 없다. CodeMirror 가 측정에 쓰는 API 만 빈 값으로 채운다.
const emptyRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
Range.prototype.getClientRects ??= emptyRects;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();

const views: EditorView[] = [];
let opened: OpenTarget[] = [];
let toasts: string[] = [];
let revealed: number[] = [];

const res = (files: string[]): LinkResolution => {
  const r = createResolver(files);
  return { version: 1, resolveWiki: r.resolveWiki, resolveMd: r.resolveMd, isUnknownTarget: r.isUnknownTarget };
};

interface ViewOpts {
  notePath?: string;
  files?: string[] | null;
}

let currentNote = 'n.md';
const deps: LinkOpenDeps = {
  notePath: () => currentNote,
  onOpen: (target) => opened.push(target),
  toast: (m) => toasts.push(m),
  reveal: (line) => revealed.push(line),
};

function makeView(doc: string, pos: number, live: boolean, opts: ViewOpts = {}): EditorView {
  const notePath = opts.notePath ?? 'n.md';
  currentNote = notePath;
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const liveExt: Extension = live ? [livePreview(), tableExtension({ save: () => {}, root: document })] : [];
  const files = opts.files === undefined ? ['n.md', 'Home.md'] : opts.files;
  const v = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor: Math.min(pos, doc.length) },
      extensions: [
        EditorState.lineSeparator.of('\n'),
        labnoteMarkdown(),
        liveExt,
        linkResolution.of(files === null ? null : res(files)),
        imageLoader.of({ notePath, images: vaultImages }),
        linkClickHandler(deps),
      ],
    }),
  });
  views.push(v);
  return v;
}

/** 라이브 미리보기 편집기(기본: 노트 'n.md', 파일 'n.md'·'Home.md'). */
const view = (doc: string, pos: number, opts?: ViewOpts) => makeView(doc, pos, true, opts);
/** 소스 보기 편집기. */
const sourceView = (doc: string, pos: number, opts?: ViewOpts) => makeView(doc, pos, false, opts);

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
function down(el: Element, init: MouseEventInit = {}): MouseEvent {
  const ev = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, ...init });
  el.dispatchEvent(ev);
  return ev;
}
function click(el: Element, init: MouseEventInit = {}): MouseEvent {
  const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init });
  el.dispatchEvent(ev);
  return ev;
}
/** CodeMirror started its own mouse selection (a caret placement) for the last mousedown. */
const caretPlacement = (v: EditorView) => !!(v as unknown as { inputState: { mouseSelection: unknown } }).inputState.mouseSelection;
const ctrlDown = (el: Element) => down(el, { ctrlKey: true });
/** 마우스 단추를 눌렀다 뗀다(같은 자리). */
const plainClick = (el: Element) => {
  const ev = down(el);
  click(el);
  return ev;
};

describe('link clicks (SP4 Task 9)', () => {
  it('plain click on a rendered wikilink opens it and keeps the caret', () => {
    const v = view('[[Home#Intro|home]]\nx', 21);
    const el = v.contentDOM.querySelector('.lno-wikilink')!;
    const ev = down(el, {});
    expect(caretPlacement(v)).toBe(false);
    click(el);
    expect(ev.defaultPrevented).toBe(true);
    expect(opened).toEqual([{ kind: 'note', path: 'Home.md', subpath: 'Intro' }]);
    expect(v.state.selection.main.head).toBe(21);
  });

  it('plain click on an unresolved wikilink asks to create it', () => {
    const v = view('[[New idea]]\nx', 14);
    const el = v.contentDOM.querySelector('.lno-wikilink')!;
    down(el, {});
    click(el);
    expect(opened).toEqual([{ kind: 'create', linkpath: 'New idea' }]);
  });

  it('a plain click on [[a]] opens a.labnote.md (the .labnote fallback) instead of asking to create a.md', () => {
    const v = view('[[a#Step]] [[a]]\nx', 18, { notePath: 'exp/n.labnote.md', files: ['exp/n.labnote.md', 'exp/a.labnote.md'] });
    const els = [...v.contentDOM.querySelectorAll('.lno-wikilink')];
    expect(els.map((e) => e.classList.contains('lno-unresolved'))).toEqual([false, false]);
    plainClick(els[0]);
    plainClick(els[1]);
    expect(opened).toEqual([
      { kind: 'note', path: 'exp/a.labnote.md', subpath: 'Step' },
      { kind: 'note', path: 'exp/a.labnote.md' },
    ]);
  });

  it('[[a]] in a.labnote.md is a self link even before the note is listed', () => {
    const v = view('## H\n[[a#H]]\nx', 14, { notePath: 'exp/a.labnote.md', files: ['Home.md'] });
    expect(v.contentDOM.querySelector('.lno-unresolved')).toBeNull();
    plainClick(v.contentDOM.querySelector('.lno-wikilink')!);
    expect(opened).toEqual([]);
    expect(revealed).toEqual([0]);
  });

  it('a plain click on a revealed link only places the caret', () => {
    const v = view('[[Home]]\nx', 3); // cursor inside: revealed
    const el = v.contentDOM.querySelector('.lno-wikilink')!;
    down(el, {});
    // CodeMirror itself prevents the default of every mousedown it turns into a caret placement, so the
    // observable is that its mouse selection started (the link handler did not consume the event)
    expect(caretPlacement(v)).toBe(true);
    click(el);
    expect(opened).toEqual([]);
  });

  it('ctrl+click opens even when revealed, and in source mode', () => {
    const v = view('[[Home]]\nx', 3);
    down(v.contentDOM.querySelector('.lno-wikilink')!, { ctrlKey: true });
    const s = sourceView('[[Home]]\nx', 10);
    down(s.contentDOM.querySelector('.cm-line')!, { ctrlKey: true });
    expect(opened).toEqual([
      { kind: 'note', path: 'Home.md' },
      { kind: 'note', path: 'Home.md' },
    ]);
  });

  it('a plain click while composing does nothing', () => {
    const v = view('[[Home]]\nx', 10);
    setComposing(v, true);
    const el = v.contentDOM.querySelector('.lno-wikilink')!;
    down(el, {});
    expect(caretPlacement(v)).toBe(true);
    click(el);
    expect(opened).toEqual([]);
  });

  it('a drag does not open', () => {
    const v = view('[[Home]]\nx', 10);
    const el = v.contentDOM.querySelector('.lno-wikilink')!;
    down(el, { clientX: 0, clientY: 0 });
    click(el, { clientX: 20, clientY: 0 });
    expect(opened).toEqual([]);
  });

  it('a click without its own mousedown does not open', () => {
    const v = view('[[Home]]\nx', 10);
    click(v.contentDOM.querySelector('.lno-wikilink')!);
    expect(opened).toEqual([]);
  });

  it('external links open as external, anchors reveal', () => {
    const v = view('[d](https://doi.org/x) [s](#intro)\n# Intro\nx', 40);
    const [ext, anc] = v.contentDOM.querySelectorAll('.lno-link');
    down(ext, {});
    click(ext);
    down(anc, {});
    click(anc);
    expect(opened).toEqual([{ kind: 'external', url: 'https://doi.org/x' }]);
    expect(revealed).toEqual([1]);
  });

  it('Alt+Enter follows the link under the cursor', () => {
    const v = view('a [[Home]] b', 5);
    expect(followLinkAtCursor(deps)(v)).toBe(true);
    expect(opened).toEqual([{ kind: 'note', path: 'Home.md' }]);
    expect(followLinkAtCursor(deps)(view('plain', 2))).toBe(false);
  });

  it('Alt+Enter while composing does nothing', () => {
    const v = view('a [[Home]] b', 5);
    setComposing(v, true);
    expect(followLinkAtCursor(deps)(v)).toBe(false);
    expect(opened).toEqual([]);
  });

  it('a plain click on a bare URL opens it externally; Ctrl+click works in source mode', () => {
    const v = view('see https://doi.org/10.1038/x\nq', 31);
    const el = v.contentDOM.querySelector('.lno-link')!;
    down(el, {});
    click(el);
    const s = sourceView('<https://a.b/c>\nq', 17);
    down(s.contentDOM.querySelector('.cm-line')!, { ctrlKey: true, clientX: 5 });
    expect(opened).toEqual([
      { kind: 'external', url: 'https://doi.org/10.1038/x' },
      { kind: 'external', url: 'https://a.b/c' },
    ]);
  });

  it('linkAt finds bare URLs but not the URL inside a markdown link', () => {
    const st = EditorState.create({ doc: 'x https://a.b [t](https://c.d)', extensions: [labnoteMarkdown()] });
    expect(linkAt(st, 4)).toMatchObject({ kind: 'md', href: 'https://a.b' });
    expect(linkAt(st, 25)).toMatchObject({ kind: 'md', href: 'https://c.d', from: 14 });
  });

  it('linkAt skips images, image embeds and plain text', () => {
    const st = EditorState.create({ doc: '![a](p.png) ![[gel.png]] text', extensions: [labnoteMarkdown()] });
    expect(linkAt(st, 2)).toBeNull();
    expect(linkAt(st, 16)).toBeNull();
    expect(linkAt(st, 27)).toBeNull();
  });

  it('linkAt reads a wikilink and a note embed', () => {
    const st = EditorState.create({ doc: '[[a b#c|x]] ![[Home]]', extensions: [labnoteMarkdown()] });
    expect(linkAt(st, 3)).toEqual({ kind: 'wiki', from: 0, to: 11, linkpath: 'a b', subpath: 'c', embed: false });
    expect(linkAt(st, 16)).toEqual({ kind: 'wiki', from: 12, to: 21, linkpath: 'Home', subpath: '', embed: true });
  });

  it('targetOf: markdown create paths drop ./, keep folders relative, and skip attachments', () => {
    const st = EditorState.create({ doc: '', extensions: [labnoteMarkdown(), linkResolution.of(res(['n.md']))] });
    const md = (href: string) => targetOf(st, { kind: 'md', from: 0, to: 0, href }, 'n.md');
    expect(md('./New%20one.md')).toEqual({ kind: 'create', linkpath: 'New one.md' });
    expect(md('sub/x.md')).toEqual({ kind: 'create', linkpath: './sub/x.md' });
    expect(md('spec.pdf')).toBeNull();
    expect(md('n.md#top')).toEqual({ kind: 'note', path: 'n.md', anchor: 'top' });
  });

  it('an empty wikilink path reveals the heading in this note', () => {
    const v = view('[[#Step]]\n## Step\nx', 18);
    plainClick(v.contentDOM.querySelector('.lno-wikilink')!);
    expect(revealed).toEqual([1]);
    expect(opened).toEqual([]);
  });

  it('an unknown attachment target opens nothing', () => {
    const v = view('[[spec.pdf]]\nx', 14);
    plainClick(v.contentDOM.querySelector('.lno-wikilink')!);
    expect(opened).toEqual([]);
  });
});

describe('라이브 미리보기: 링크와 유닛 오퍼레이션 제목', () => {
  const exp = { notePath: 'exp/a.labnote.md', files: ['exp/a.labnote.md', 'exp/b.labnote.md', 'exp/c.labnote.md'] };

  it('### [UHW010 PCR] alias renders a chip, never a link', () => {
    const v = view('### [UHW010 PCR] alias\nx', 24, exp);
    const chip = v.contentDOM.querySelector('.lno-uo-code')!;
    expect(chip.textContent).toBe('UHW010');
    expect(chip.classList.contains('lno-chip')).toBe(true);
    expect(chip.classList.contains('lno-uo-uhw')).toBe(true);
    expect(v.contentDOM.querySelector('.lno-link')).toBeNull();
    expect(visibleText(v, 1)).toBe('UHW010 PCR alias');
  });

  it('the cursor on a unit-operation heading line shows its source, still with the chip', () => {
    const v = view('### [UHW010 PCR] alias\nx', 5, exp);
    expect(visibleText(v, 1)).toBe('### [UHW010 PCR] alias');
    expect(v.contentDOM.querySelector('.lno-uo-code')!.textContent).toBe('UHW010');
  });

  it('## [WB010 name] gets the WB chip', () => {
    const v = view('## [WB010 DNA 올리고머 조립] 별칭\nx', 26, exp);
    expect(v.contentDOM.querySelector('.lno-uo-wb')!.textContent).toBe('WB010');
    expect(visibleText(v, 1)).toBe('WB010 DNA 올리고머 조립 별칭');
  });

  it('[label](./b.labnote.md) shows the label; Ctrl+click opens the vault path and keeps one selection', () => {
    const v = view('[label](./b.labnote.md)\nx', 25, exp);
    expect(visibleText(v, 1)).toBe('label');
    const link = v.contentDOM.querySelector('.lno-link')!;
    expect(link.getAttribute('title')).toBe(t('live.link.title'));
    const ev = ctrlDown(link);
    expect(opened).toEqual([{ kind: 'note', path: 'exp/b.labnote.md' }]);
    expect(ev.defaultPrevented).toBe(true);
    expect(v.state.selection.ranges.length).toBe(1);
    expect(v.state.selection.main.head).toBe(25);
  });

  it('a link to another note with #anchor passes the anchor', () => {
    const v = view('[s](./b.labnote.md#step-1)\nx', 28, exp);
    ctrlDown(v.contentDOM.querySelector('.lno-link')!);
    expect(opened).toEqual([{ kind: 'note', path: 'exp/b.labnote.md', anchor: 'step-1' }]);
  });

  it('an #anchor link reveals the heading in this note', () => {
    const v = view('[go](#step-2)\n\n## Step 2\nx', 25, exp);
    ctrlDown(v.contentDOM.querySelector('.lno-link')!);
    expect(revealed).toEqual([2]);
    expect(opened).toEqual([]);
  });

  it('an #anchor link to a missing heading toasts instead of doing nothing', () => {
    const v = view('[go](#nowhere)\n\n## Step 2\nx', 26, exp);
    ctrlDown(v.contentDOM.querySelector('.lno-link')!);
    expect(revealed).toEqual([]);
    expect(toasts).toEqual([t('live.link.anchorMissing')]);
  });

  it('a plain click on a rendered markdown link opens it', () => {
    const v = view('[label](./b.labnote.md)\nx', 25, exp);
    const ev = plainClick(v.contentDOM.querySelector('.lno-link')!);
    expect(ev.defaultPrevented).toBe(true);
    expect(opened).toEqual([{ kind: 'note', path: 'exp/b.labnote.md' }]);
  });

  it('[[target|alias]] shows the alias only, styled, and a click asks to create the missing target', () => {
    const v = view('[[target|alias]]\nx', 18, exp);
    expect(visibleText(v, 1)).toBe('alias');
    expect(v.contentDOM.querySelector('.lno-wikilink')!.textContent).toBe('alias');
    ctrlDown(v.contentDOM.querySelector('.lno-wikilink')!);
    expect(opened).toEqual([{ kind: 'create', linkpath: 'target' }]);
  });

  it('before the link index is ready an unresolved wikilink opens nothing, a markdown note link still opens', () => {
    const v = view('[[target]] [s](./b.labnote.md)\nx', 33, { notePath: 'exp/a.labnote.md', files: null });
    plainClick(v.contentDOM.querySelector('.lno-wikilink')!);
    plainClick(v.contentDOM.querySelector('.lno-link')!);
    expect(opened).toEqual([{ kind: 'note', path: 'exp/b.labnote.md' }]);
  });

  it('[[x.labnote]] reads x, [[a.labnote#H]] reads a#H; an alias, other names and a revealed link are unchanged', () => {
    const doc = '[[콜로니 PCR.labnote]] [[a.labnote#H]] [[b.LabNote]] [[a.labnote|별칭]] [[c.labnote.md]] [[x.labnoteZ]]';
    const v = view(`${doc}\nx`, doc.length + 2, { notePath: 'exp/n.labnote.md', files: ['exp/콜로니 PCR.labnote.md', 'exp/a.labnote.md'] });
    expect(visibleText(v, 1)).toBe('콜로니 PCR a#H b 별칭 c.labnote.md x.labnoteZ');
    expect(v.state.doc.line(1).text).toBe(doc);
    const els = [...v.contentDOM.querySelectorAll('.lno-wikilink')];
    expect(els[0].textContent).toBe('콜로니 PCR');
    expect(els[0].classList.contains('lno-unresolved')).toBe(false);
    plainClick(els[0]);
    expect(opened).toEqual([{ kind: 'note', path: 'exp/콜로니 PCR.labnote.md' }]);
    // the cursor touching a link reveals its whole source
    v.dispatch({ selection: { anchor: 3 } });
    expect(visibleText(v, 1)).toBe('[[콜로니 PCR.labnote]] a#H b 별칭 c.labnote.md x.labnoteZ');
  });

  it('[[target]] shows the target, and the cursor touching it shows the source', () => {
    const v = view('a [[target]] b\nx', 16, exp);
    expect(visibleText(v, 1)).toBe('a target b');
    v.dispatch({ selection: { anchor: 3 } });
    expect(visibleText(v, 1)).toBe('a [[target]] b');
  });

  it("'see [1] here' renders unchanged", () => {
    const v = view('see [1] here\nx', 14, exp);
    expect(visibleText(v, 1)).toBe('see [1] here');
    expect(v.contentDOM.querySelector('.lno-link')).toBeNull();
  });

  it('Ctrl+click on an external link opens it externally without a toast', () => {
    const v = view('[d](https://doi.org/10.1/x)\nx', 29, exp);
    ctrlDown(v.contentDOM.querySelector('.lno-link')!);
    expect(toasts).toEqual([]);
    expect(opened).toEqual([{ kind: 'external', url: 'https://doi.org/10.1/x' }]);
  });

  it('a reference link renders and opens its definition target', () => {
    const v = view('[x][ref]\n\n[ref]: ./c.labnote.md\nz', 31, exp);
    expect(visibleText(v, 1)).toBe('x');
    ctrlDown(v.contentDOM.querySelector('.lno-link')!);
    expect(opened).toEqual([{ kind: 'note', path: 'exp/c.labnote.md' }]);
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
      const v = view(doc, doc.length, exp);
      expect(lineEl(v, 1).textContent).not.toContain(']');
      const w = view(doc, 2, exp);
      expect(() => w.dispatch({ selection: { anchor: doc.length } })).not.toThrow();
      expect(lineEl(w, 1).textContent).not.toContain(']');
    },
  );
});
