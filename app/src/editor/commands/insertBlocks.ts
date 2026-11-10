/**
 * 넣기 명령의 블록(UI 재설계 Task 12, 명세 §5.5): 콜아웃, 코드 블록, 가로줄, 수식 블록. 팔레트와 편집기 맥락 메뉴(Task 16)가 함께 쓴다.
 * 빌더는 순수하다: 커서 줄 다음에 따로 선 블록으로 넣고(빈 줄이면 그 줄에), 문단과는 빈 줄로 떼고, 커서를 블록 안 쓸 자리에 둔다.
 * - 커서가 표 안이면 표 아래에, 머리말 안이면 머리말 뒤에 넣는다(머리말을 깨지 않게).
 * - 가로줄은 문단 바로 아래(setext 제목)나 문서 첫 줄(머리말)이 되지 않게 앞에 빈 줄을 둔다.
 * - 코드 블록은 선택이 있으면 선택한 줄을 감싼다(서식의 코드 블록과 같다).
 */
import { isolateHistory } from '@codemirror/commands';
import { EditorSelection, Transaction, type EditorState, type TransactionSpec } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { FRONTMATTER_CLOSE, FRONTMATTER_OPEN } from '../markdownSyntax';
import { wrapCodeBlock } from '../live/format';
import { tableAwareInsertPos } from '../table/target';

export type BlockKind = 'callout' | 'codeBlock' | 'hr' | 'mathBlock';

/** 블록의 줄들과 커서 자리(줄 번호 0부터, 그 줄의 끝). `after` 면 블록 다음 새 줄. */
const BLOCKS: Record<BlockKind, { lines: readonly string[]; caret: number | 'after' }> = {
  callout: { lines: ['> [!note]', '> '], caret: 1 },
  codeBlock: { lines: ['```', '', '```'], caret: 1 },
  hr: { lines: ['---'], caret: 'after' },
  mathBlock: { lines: ['$$', '', '$$'], caret: 1 },
};

const blank = (text: string) => text.trim() === '';

/** 머리말의 닫는 줄 번호(1부터). 머리말이 없으면 0. */
function frontMatterEnd(state: EditorState): number {
  const doc = state.doc;
  if (doc.lines < 2 || !FRONTMATTER_OPEN.test(doc.line(1).text)) return 0;
  for (let n = 2; n <= doc.lines; n++) if (FRONTMATTER_CLOSE.test(doc.line(n).text)) return n;
  return 0;
}

export function insertBlock(state: EditorState, kind: BlockKind): TransactionSpec | null {
  if (state.readOnly || !state.facet(EditorView.editable)) return null;
  const main = state.selection.main;
  if (kind === 'codeBlock' && !main.empty) return wrapCodeBlock(state);
  const br = state.lineBreak;
  const doc = state.doc;
  let line = doc.lineAt(tableAwareInsertPos(state, main.head));
  const fm = frontMatterEnd(state);
  if (fm > 0 && line.number <= fm) line = doc.line(fm);
  const { lines, caret } = BLOCKS[kind];
  const block = lines.join(br);
  const nextBlank = line.number < doc.lines ? blank(doc.line(line.number + 1).text) : true;
  const last = line.number === doc.lines;
  let from: number;
  let before: string;
  if (blank(line.text) && line.number > fm) {
    from = line.from;
    const prevText = line.number > 1 ? doc.line(line.number - 1).text : undefined;
    // 문서 첫 줄의 --- 는 머리말이 되고, 문단 바로 아래의 --- 는 제목 밑줄이 된다
    before = (prevText !== undefined && !blank(prevText)) || (kind === 'hr' && line.number === 1) ? br : '';
  } else {
    from = line.to;
    before = br + br;
  }
  const after = !nextBlank ? br : kind === 'hr' && last ? br : '';
  // 빈 줄에 넣을 때 그 줄의 공백은 바꿔 쓴다
  const to = from === line.from ? line.to : from;
  const insert = before + block + after;
  const blockStart = from + before.length;
  let head: number;
  if (caret === 'after') head = blockStart + block.length + (after ? br.length : 0);
  else head = blockStart + lines.slice(0, caret + 1).join(br).length;
  return {
    changes: { from, to, insert },
    selection: EditorSelection.cursor(head),
    annotations: [isolateHistory.of('full'), Transaction.userEvent.of('input')],
    scrollIntoView: true,
  };
}
