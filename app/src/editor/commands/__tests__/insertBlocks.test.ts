import { EditorSelection, EditorState } from '@codemirror/state';
import { insertBlock, type BlockKind } from '../insertBlocks';

/** `|` 가 커서 자리인 문서에 블록을 넣고, 결과를 같은 꼴(`|` = 새 커서)로 돌려준다. */
function run(doc: string, kind: BlockKind, anchorEnd?: number): string | null {
  const at = doc.indexOf('|');
  const text = doc.replace('|', '');
  const state = EditorState.create({
    doc: text,
    selection: anchorEnd === undefined ? EditorSelection.cursor(at) : EditorSelection.range(at, anchorEnd),
  });
  const spec = insertBlock(state, kind);
  if (!spec) return null;
  const next = state.update(spec).state;
  const head = next.selection.main.head;
  return next.doc.sliceString(0, head) + '|' + next.doc.sliceString(head);
}

describe('insertBlock', () => {
  it('puts a callout on an empty line with the caret on its body line', () => {
    expect(run('a\n\n|', 'callout')).toBe('a\n\n> [!note]\n> |');
  });

  it('after a paragraph line it leaves one blank line before the block and keeps the next paragraph apart', () => {
    expect(run('abc|\nnext', 'mathBlock')).toBe('abc\n\n$$\n|\n$$\n\nnext');
  });

  it('a code block on an empty line puts the caret inside the fence', () => {
    expect(run('|', 'codeBlock')).toBe('```\n|\n```');
  });

  it('a code block around a selection wraps the selected lines', () => {
    const out = run('|one\ntwo', 'codeBlock', 7);
    expect(out?.replace('|', '')).toBe('```\none\ntwo\n```');
  });

  it('a horizontal rule is never read as a setext heading or front matter, and the caret goes below it', () => {
    expect(run('text|', 'hr')).toBe('text\n\n---\n|');
    // 문서 첫 줄의 --- 는 머리말이 된다: 빈 줄을 앞에 둔다
    expect(run('|', 'hr')).toBe('\n---\n|');
  });

  it('inside front matter it inserts after the closing fence', () => {
    expect(run('---\nti|tle: x\n---\nbody', 'callout')).toBe('---\ntitle: x\n---\n\n> [!note]\n> |\n\nbody');
  });

  it('does nothing in a read-only editor', () => {
    const state = EditorState.create({ doc: 'x', extensions: EditorState.readOnly.of(true) });
    expect(insertBlock(state, 'hr')).toBeNull();
  });
});
