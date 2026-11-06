// @vitest-environment jsdom
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { labnoteMarkdown } from '../../markdownSyntax';
import { tableExtension } from '../../table/field';
import { livePreview } from '../index';

// jsdom 에는 레이아웃이 없다. CodeMirror 가 측정에 쓰는 API 만 빈 값으로 채운다.
const emptyRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
Range.prototype.getClientRects ??= emptyRects;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();

const views: EditorView[] = [];

/** 라이브 미리보기와 표 확장을 실은 편집기(inline.test.ts 와 같은 구성). */
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
      ],
    }),
  });
  views.push(v);
  return v;
}

afterEach(() => {
  while (views.length) views.pop()!.destroy();
  document.body.innerHTML = '';
});

const lineEl = (v: EditorView, n: number) => v.contentDOM.querySelectorAll<HTMLElement>('.cm-line')[n - 1];
const lineClasses = (v: EditorView, n: number) => Array.from(lineEl(v, n).classList);
const visibleText = (v: EditorView, n: number) => lineEl(v, n).textContent;
const move = (v: EditorView, pos: number) => v.dispatch({ selection: { anchor: pos } });

describe('라이브 미리보기: 인용, 콜아웃, 코드 블록, 가로줄, 스캔 주석', () => {
  it('"---" between paragraphs renders as lno-hr off-line and raw on the cursor line', () => {
    const v = view('a\n\n---\n\nb', 9);
    expect(lineClasses(v, 3)).toContain('lno-hr');
    expect(visibleText(v, 3)).toBe('');
    move(v, 4);
    expect(visibleText(v, 3)).toBe('---');
  });

  it('"> [!note] AI" renders as a callout and hides [!note] off-line', () => {
    const v = view('> [!note] AI\n> body\nx', 21);
    expect(visibleText(v, 1)).toBe('AI');
    expect(lineClasses(v, 1)).toContain('lno-callout-note');
    expect(lineClasses(v, 2)).toContain('lno-callout-note');
    expect(lineClasses(view('> [!foo] T\nx', 12), 1)).toContain('lno-callout-note');
  });

  it('callout title is marked, the cursor line shows source, and known types keep their own class', () => {
    const v = view('> [!warning]- Careful\n> body\nx', 30);
    expect(lineClasses(v, 1)).toEqual(expect.arrayContaining(['lno-callout', 'lno-callout-warning']));
    expect(lineEl(v, 1).querySelector('.lno-callout-title')?.textContent).toBe('Careful');
    expect(visibleText(v, 2)).toBe('body');
    move(v, 3);
    expect(visibleText(v, 1)).toBe('> [!warning]- Careful');
  });

  it('a plain blockquote gets lno-quote on every line and hides "> " off-line', () => {
    const v = view('> one\n> two\nx', 13);
    expect(lineClasses(v, 1)).toContain('lno-quote');
    expect(lineClasses(v, 2)).toContain('lno-quote');
    expect(lineClasses(v, 1)).not.toContain('lno-callout');
    expect(visibleText(v, 1)).toBe('one');
    move(v, 7);
    expect(visibleText(v, 2)).toBe('> two');
    expect(visibleText(v, 1)).toBe('one');
  });

  it('fenced code lines carry codeblock classes and nothing inside is decorated', () => {
    const v = view('```js\nconst a = **b**;\n```\nx', 28);
    expect(lineClasses(v, 1)).toEqual(expect.arrayContaining(['lno-codeblock', 'lno-codeblock-first', 'lno-fence']));
    expect(lineClasses(v, 3)).toEqual(expect.arrayContaining(['lno-codeblock-last', 'lno-fence']));
    expect(lineClasses(v, 2)).toContain('lno-codeblock');
    expect(lineClasses(v, 2)).not.toContain('lno-fence');
    expect(visibleText(v, 2)).toBe('const a = **b**;');
  });

  it('a table inside a blockquote stays source with quote styling', () => {
    const v = view('> | a |\n> | - |\nx', 17);
    expect(v.contentDOM.querySelector('.lno-table-wrap')).toBeNull();
    expect(lineClasses(v, 1)).toContain('lno-quote');
  });

  it('front-matter "---" lines are not hr', () => expect(lineClasses(view('---\na: 1\n---\nx', 14), 1)).not.toContain('lno-hr'));

  it('labnoteo-scan comments are muted', () => expect(lineClasses(view('<!-- labnoteo-scan id=1 -->\nx', 29), 1)).toContain('lno-scan-meta'));

  it('other HTML comments are not scan meta', () => expect(lineClasses(view('<!-- note -->\nx', 15), 1)).not.toContain('lno-scan-meta'));
});
