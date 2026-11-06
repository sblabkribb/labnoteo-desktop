import { EditorSelection, EditorState } from '@codemirror/state';
import { ensureSyntaxTree } from '@codemirror/language';
import type { SyntaxNodeRef } from '@lezer/common';
import { labnoteMarkdown } from '../../markdownSyntax';
import {
  BLOCK_MARKS,
  INLINE_NODES,
  isFenceMark,
  revealInline,
  revealLine,
  skipRanges,
  touchedLines,
} from '../reveal';

const make = (doc: string, selection: EditorSelection) =>
  EditorState.create({ doc, selection, extensions: [labnoteMarkdown(), EditorState.allowMultipleSelections.of(true)] });
const st = (doc: string, pos: number) => make(doc, EditorSelection.single(pos));
const sel = (doc: string, from: number, to: number) => make(doc, EditorSelection.single(from, to));
const multi = (doc: string, cursors: number[]) =>
  make(doc, EditorSelection.create(cursors.map((p) => EditorSelection.cursor(p))));

/** 이름이 `name` 인 노드들(문서 순서). 노드 참조는 반복이 끝나면 바뀌므로 노드 자체를 모은다. */
function nodesNamed(state: EditorState, name: string): SyntaxNodeRef[] {
  const tree = ensureSyntaxTree(state, state.doc.length, 5000)!;
  const out: SyntaxNodeRef[] = [];
  tree.iterate({ enter: (n) => void (n.name === name && out.push(n.node)) });
  return out;
}

describe('reveal rule', () => {
  it('names the block marks and inline nodes', () => {
    expect([...BLOCK_MARKS].sort()).toEqual(['CodeInfo', 'HeaderMark', 'HorizontalRule', 'ListMark', 'QuoteMark', 'TaskMarker']);
    expect(BLOCK_MARKS.has('CodeMark')).toBe(false);
    expect([...INLINE_NODES].sort()).toEqual(
      ['Embed', 'Emphasis', 'Highlight', 'Image', 'InlineCode', 'Link', 'Strikethrough', 'StrongEmphasis', 'WikiLink'].sort(),
    );
  });

  it('inline reveal is inclusive at both edges', () => {
    expect(revealInline(st('a **b** c', 7), 2, 7)).toBe(true); // cursor right after the closing **
    expect(revealInline(st('a **b** c', 2), 2, 7)).toBe(true); // cursor right before the opening **
    expect(revealInline(st('a **b** c', 8), 2, 7)).toBe(false);
    expect(revealInline(st('a **b** c', 1), 2, 7)).toBe(false);
  });

  it('inline reveal looks at every selection range', () => {
    expect(revealInline(multi('a **b** c', [0, 4]), 2, 7)).toBe(true);
    expect(revealInline(sel('ab **b** c', 0, 1), 3, 8)).toBe(false);
    expect(revealInline(sel('a **b** c', 0, 9), 2, 7)).toBe(true);
  });

  it('multi-range selections reveal every touched line', () =>
    expect([...touchedLines(multi('# a\n# b\n# c', [0, 8]))]).toEqual([1, 3]));

  it('a range spanning lines touches all of them', () => expect([...touchedLines(sel('a\nb\nc', 0, 4))]).toEqual([1, 2, 3]));

  it('revealLine answers from the touched lines, computed or given', () => {
    const s = multi('# a\n# b\n# c', [0, 8]);
    expect([1, 2, 3].map((n) => revealLine(s, n))).toEqual([true, false, true]);
    expect(revealLine(s, 2, new Set([2]))).toBe(true);
    expect(revealLine(s, 1, new Set([2]))).toBe(false);
  });

  it('isFenceMark tells a fence CodeMark from an InlineCode one', () => {
    const marks = nodesNamed(st('```\na\n```\n`b`', 0), 'CodeMark');
    expect(marks.map(isFenceMark)).toEqual([true, true, false, false]);
  });

  it('skipRanges returns front matter and table spans', () =>
    expect(skipRanges(st('---\na: 1\n---\n| a |\n| - |\n', 0))).toEqual([
      { from: 0, to: 12 },
      { from: 13, to: 24 },
    ]));

  it('skipRanges is empty for a plain note and ignores a later ---', () => {
    expect(skipRanges(st('# a\n\nb', 0))).toEqual([]);
    expect(skipRanges(st('a\n\n---\nb: 1\n---\n', 0))).toEqual([]);
  });
});
