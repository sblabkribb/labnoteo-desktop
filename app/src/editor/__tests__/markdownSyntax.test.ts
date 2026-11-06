import { EditorState } from '@codemirror/state';
import { ensureSyntaxTree } from '@codemirror/language';
import { highlightTree, tagHighlighter, tags } from '@lezer/highlight';
import { labnoteMarkdown, labnoteParser } from '../markdownSyntax';

type Tree = ReturnType<typeof labnoteParser.parse>;

/** 트리의 노드를 `이름 from-to` 로 모두 적는다(문서 노드는 뺀다). */
function nodes(tree: Tree): Array<{ name: string; from: number; to: number }> {
  const out: Array<{ name: string; from: number; to: number }> = [];
  tree.iterate({
    enter: (n) => {
      if (n.type.isTop) return;
      out.push({ name: n.name, from: n.from, to: n.to });
    },
  });
  return out;
}
const names = (doc: string) => nodes(labnoteParser.parse(doc)).map((n) => n.name);
const find = (doc: string, name: string) => nodes(labnoteParser.parse(doc)).filter((n) => n.name === name);

describe('labnoteParser: 머리말(frontmatter)', () => {
  it('문서 맨 앞의 --- … --- 는 머리말 한 덩어리다: 표제(SetextHeading2)도 가로줄도 아니다', () => {
    const doc = '---\ntitle: x\n---\n# H';
    const fm = find(doc, 'Frontmatter');
    expect(fm).toEqual([{ name: 'Frontmatter', from: 0, to: '---\ntitle: x\n---'.length }]);
    const all = names(doc);
    expect(all).not.toContain('SetextHeading2');
    expect(all).not.toContain('HorizontalRule');
    expect(all).toContain('ATXHeading1');
  });

  it('머리말 안은 다시 파싱하지 않는다 (자식 노드가 없다)', () => {
    const doc = '---\ntitle: **x**\n# not a heading\n---\nbody';
    const [fm] = find(doc, 'Frontmatter');
    const inside = nodes(labnoteParser.parse(doc)).filter((n) => n.from >= fm.from && n.to <= fm.to && n.name !== 'Frontmatter');
    expect(inside).toEqual([]);
    expect(names(doc)).toContain('Paragraph');
  });

  it('... 로 닫아도 된다', () => {
    const doc = '---\na: 1\n...\ntext';
    expect(find(doc, 'Frontmatter')).toEqual([{ name: 'Frontmatter', from: 0, to: '---\na: 1\n...'.length }]);
  });

  it('맨 앞이 아닌 --- 는 그대로 가로줄이다', () => {
    const doc = 'para\n\n---\ntitle: x\n---\n';
    const all = names(doc);
    expect(all).not.toContain('Frontmatter');
    expect(all).toContain('HorizontalRule');
  });

  it('빈 머리말(--- 바로 다음 줄이 ---)도 머리말이다', () => {
    expect(find('---\n---\nx', 'Frontmatter')).toEqual([{ name: 'Frontmatter', from: 0, to: 7 }]);
    expect(names('---\n---\nx')).toContain('Paragraph');
  });

  it('닫는 줄이 없으면 문서 끝까지가 머리말이다 (노드가 기댄 글자를 다 덮어야 증분 파싱이 어긋나지 않는다)', () => {
    const doc = '---\ntitle: x\nbody';
    expect(find(doc, 'Frontmatter')).toEqual([{ name: 'Frontmatter', from: 0, to: doc.length }]);
  });

  it('들여 쓴 --- 나 ---- 로 시작하는 문서에는 머리말이 없다', () => {
    expect(names(' ---\na: 1\n---\n')).not.toContain('Frontmatter');
    expect(names('----\na: 1\n---\n')).not.toContain('Frontmatter');
  });

  it('머리말은 meta 로 강조된다 (테마가 이미 흐리게 그리는 태그)', () => {
    const doc = '---\ntitle: x\n---\nbody';
    const spans: Array<[number, number, string]> = [];
    highlightTree(labnoteParser.parse(doc), tagHighlighter([{ tag: tags.meta, class: 'meta' }]), (from, to, cls) => spans.push([from, to, cls]));
    expect(spans).toEqual([[0, '---\ntitle: x\n---'.length, 'meta']]);
  });

  it('CRLF 문서의 머리말도 알아본다', () => {
    const doc = '---\r\ntitle: x\r\n---\r\n# H';
    expect(find(doc, 'Frontmatter')).toHaveLength(1);
    expect(names(doc)).not.toContain('SetextHeading2');
  });
});

describe('labnoteParser: GFM', () => {
  it('표는 Table · TableHeader · TableDelimiter · TableRow 로 나온다', () => {
    const all = names('| a | b |\n| --- | --- |\n| 1 | 2 |');
    for (const n of ['Table', 'TableHeader', 'TableDelimiter', 'TableRow']) expect(all).toContain(n);
  });

  it('할 일 목록은 Task 다', () => {
    expect(names('- [ ] x')).toContain('Task');
  });

  it('~~취소선~~ 은 Strikethrough 다', () => {
    expect(names('~~s~~')).toContain('Strikethrough');
  });

  it('단위 조작 표제 `### [UHW100 PCR] alias` 는 여전히 ATXHeading3 이다', () => {
    expect(names('### [UHW100 PCR] alias')).toContain('ATXHeading3');
  });
});

describe('labnoteMarkdown(): 편집기 확장', () => {
  const editorTree = (doc: string) => {
    const state = EditorState.create({ doc, extensions: [labnoteMarkdown()] });
    return nodes(ensureSyntaxTree(state, state.doc.length, 5000)!).map((n) => n.name);
  };

  it('편집기 언어는 GFM 이다: 표 · 할 일 · 취소선', () => {
    const all = editorTree('| a | b |\n| --- | --- |\n| 1 | 2 |\n\n- [ ] x\n\n~~s~~\n');
    for (const n of ['Table', 'Task', 'Strikethrough']) expect(all).toContain(n);
  });

  it('편집기 상태의 구문 트리에 표와 머리말이 나온다', () => {
    const doc = '---\ntitle: x\n---\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n';
    const state = EditorState.create({ doc, extensions: [labnoteMarkdown()] });
    const tree = ensureSyntaxTree(state, state.doc.length, 5000)!;
    const all = nodes(tree).map((n) => n.name);
    expect(all).toContain('Frontmatter');
    expect(all).toContain('Table');
    expect(all).not.toContain('SetextHeading2');
  });
});
