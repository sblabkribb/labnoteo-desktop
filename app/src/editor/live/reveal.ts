import type { EditorState } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNodeRef } from '@lezer/common';
import { findTables } from '../table/field';

/**
 * 라이브 미리보기의 드러냄 규칙(계획 D5). 무엇을 원문으로 보일지만 정하는 순수 함수들이다.
 *
 * - 블록 표시(제목 #, 인용 >, 목록 기호, 할 일 [ ], 가로줄, 코드 울타리와 정보 문자열)는
 *   어느 선택 범위든 닿은 줄이면 그 줄 전체가 원문으로 보인다.
 * - 인라인 노드는 어느 범위든 [from, to] 와 겹치거나 맞닿으면(양 끝 포함) 원문으로 보인다.
 * - SP1 표 구역과 머리말(Frontmatter) 노드 안은 건너뛴다(`skipRanges`).
 */

/** 줄 단위로 드러나는 블록 표시. CodeMark 는 인라인 코드에도 쓰이므로 빼고 `isFenceMark` 로 따로 가린다. */
export const BLOCK_MARKS: ReadonlySet<string> = new Set([
  'HeaderMark',
  'QuoteMark',
  'ListMark',
  'TaskMarker',
  'HorizontalRule',
  'CodeInfo',
]);

/** 코드 울타리(```)의 CodeMark 인가. 인라인 코드의 백틱은 부모가 InlineCode 이다. */
export function isFenceMark(node: SyntaxNodeRef): boolean {
  return node.name === 'CodeMark' && node.node.parent?.name === 'FencedCode';
}

/** 요소 단위로 드러나는 인라인 노드. */
export const INLINE_NODES: ReadonlySet<string> = new Set([
  'Emphasis',
  'StrongEmphasis',
  'Strikethrough',
  'InlineCode',
  'Highlight',
  'Link',
  'Image',
  'WikiLink',
  'Embed',
]);

/** 어느 선택 범위든 닿은 줄 번호(1부터). 여러 줄에 걸친 범위는 그 사이 모든 줄을 넣는다. 오름차순. */
export function touchedLines(state: EditorState): Set<number> {
  const nums: number[] = [];
  for (const r of state.selection.ranges) {
    const first = state.doc.lineAt(r.from).number;
    const last = state.doc.lineAt(r.to).number;
    for (let n = first; n <= last; n++) nums.push(n);
  }
  return new Set(nums.sort((a, b) => a - b));
}

/** 줄 `lineNo`(1부터)의 블록 표시를 원문으로 보일까. `lines` 를 주면 다시 계산하지 않는다. */
export function revealLine(state: EditorState, lineNo: number, lines?: Set<number>): boolean {
  return (lines ?? touchedLines(state)).has(lineNo);
}

/** [from, to] 의 인라인 노드를 원문으로 보일까: 어느 범위 r 이든 r.from <= to && r.to >= from. */
export function revealInline(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some((r) => r.from <= to && r.to >= from);
}

/** 라이브 미리보기가 손대지 않을 구역: 맨 앞의 머리말 노드와 SP1 표 구역. 시작 위치 순. */
export function skipRanges(state: EditorState): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  const first = syntaxTree(state).topNode.firstChild;
  if (first && first.name === 'Frontmatter' && first.from === 0) out.push({ from: first.from, to: first.to });
  for (const t of findTables(state)) out.push({ from: t.from, to: t.to });
  return out.sort((a, b) => a.from - b.from);
}
