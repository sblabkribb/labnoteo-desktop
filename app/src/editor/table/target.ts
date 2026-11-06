import { Transaction, type EditorState, type TransactionSpec } from '@codemirror/state';
import { isolateHistory } from '@codemirror/commands';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import type { TableSpan } from './field';
// commands.ts 가 이 파일을 가져오고 field.ts 는 commands.ts 를 가져온다. 순환이므로 placeBlock 은 함수 안에서만 쓴다.
import { placeBlock } from './commands';

/**
 * 칸에 포커스가 있는 동안 명령이 글을 넣을 자리(vendor `src/tableCellTarget.ts` 의 `noteTargetBelowTable` 과 같은 규칙):
 * 칸 안이 아니라 표 아래의 새 줄이다.
 *
 * vendor 는 표 끝에 줄바꿈 하나를 붙여 넣지만, 여기의 GFM 구문(Lezer)에서는 표 바로 다음 줄의 글이 파이프가 없어도
 * 표의 새 행이 된다. 그래서 표와 넣은 글 사이에는 늘 빈 줄 하나를 둔다(`tableAwareInsert`).
 */

/** `pos` 를 덮는 맨 위 표(격자로 그려지는 표). 표의 첫 줄 시작부터 마지막 줄 끝까지를 표 안으로 본다. */
function tableSpanAt(state: EditorState, pos: number): TableSpan | null {
  const tree = ensureSyntaxTree(state, state.doc.length, 200) ?? syntaxTree(state);
  for (let n = tree.topNode.firstChild; n; n = n.nextSibling) {
    if (n.from > pos) break;
    if (n.name !== 'Table') continue;
    const from = state.doc.lineAt(n.from).from;
    const to = state.doc.lineAt(n.to).to;
    if (from <= pos && pos <= to) return { from, to };
  }
  return null;
}

/**
 * 블록을 넣을 자리. `pos` 가 표 밖이면 그대로다. 표 안(처음·가운데·끝)이면 표 아래로 간다:
 * - 표 다음 줄이 빈 줄이면 그 줄의 시작(이미 있는 새 줄).
 * - 그렇지 않으면(문서 끝이거나 바로 글이 이어지면) 표의 끝. 새 줄은 넣는 쪽이 만든다 — `tableAwareInsert` 가 그렇게 한다.
 * 위치는 CodeMirror 의 것이다: CRLF 도 한 칸으로 센다.
 */
export function tableAwareInsertPos(state: EditorState, pos: number): number {
  const span = tableSpanAt(state, pos);
  return span ? below(state, span) : pos;
}

function below(state: EditorState, span: TableSpan): number {
  const last = state.doc.lineAt(span.to);
  if (last.number < state.doc.lines) {
    const next = state.doc.line(last.number + 1);
    if (next.text.trim() === '') return next.from;
  }
  return span.to;
}

/**
 * `text` 를 `pos` 에 넣는 트랜잭션. `pos` 가 표 안이면 표 아래에 따로 선 블록으로 넣는다: 표와는 빈 줄 하나로 떨어지고
 * 필요하면 줄을 새로 만든다(줄 구분자는 상태의 것). 표 밖이면 그 자리에 그대로 넣는다. 커서는 넣은 글의 끝.
 * 여러 줄 글은 `state.lineBreak` 로 이어서 넘긴다. 되돌리기 한 번.
 */
export function tableAwareInsert(state: EditorState, pos: number, text: string): TransactionSpec {
  const span = tableSpanAt(state, pos);
  const length = state.toText(text).length;
  const annotations = [isolateHistory.of('full'), Transaction.userEvent.of('input')];
  if (!span) return { changes: { from: pos, insert: text }, selection: { anchor: pos + length }, annotations, scrollIntoView: true };
  const at = below(state, span);
  const { change, start } = placeBlock(state, at, at, text);
  return { changes: change, selection: { anchor: start + length }, annotations, scrollIntoView: true };
}
