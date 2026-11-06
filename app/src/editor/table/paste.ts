import { EditorState, Transaction, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { isolateHistory } from '@codemirror/commands';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import { pasteRect } from './model';
import { isTabular, parseTSV } from './tsv';
import { locateTable, placeTable, shiftChanges, tableFromGrid } from './commands';
import { findTables } from './field';
import { activeCell, cellExtras, focusCell, outerOf } from './cellEditor';

/**
 * Excel·TSV 붙여 넣기(연구 문서 §4.4).
 *
 * - Excel 은 text/plain 에 TSV 를 넣는다(칸은 탭, 줄은 CRLF, 탭·줄바꿈·따옴표가 든 칸은 `"…"`). text/html 의 표는 v1 에서 보지 않는다.
 * - 칸 안: 칸이 둘 이상인 TSV 는 그 칸부터 사각형을 채운다(`pasteRect`, 모자라면 행과 열을 늘린다). 되돌리기 한 번.
 *   값 하나는 보통 글자처럼 붙고, 셀 편집기의 거르개가 파이프와 줄바꿈을 escape 한다.
 * - 바깥 편집기(표 밖): 칸이 둘 이상인 TSV 는 첫 행이 머리 행인 새 표가 된다. 앞뒤 글과는 빈 줄로 떨어진다. 되돌리기 한 번.
 *   코드(울타리·들여쓴 블록, 인라인)와 머리말 안에서는 표로 바꾸지 않는다: 탭이 든 코드가 그대로 붙어야 한다.
 * - Ctrl+Shift+V(맥은 Cmd+Shift+V)는 서식 없이 원문 그대로 붙인다: 탭이 든 로그도 그대로 붙일 수 있다.
 *   붙여 넣기 사건에는 어떤 키로 붙였는지가 없으므로, 그 키를 누른 직후의 붙여 넣기 한 번을 원문으로 본다.
 * - 값은 바꾸지 않는다(`007`, `1/2`, `2E4` 그대로).
 */

/** 원문 붙여 넣기 키를 누른 뒤 이 시간 안의 붙여 넣기 하나를 원문으로 본다(ms). */
const PLAIN_WINDOW_MS = 1000;
const plainUntil = new WeakMap<EditorView, number>();

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Meta', 'Alt', 'AltGraph']);

/**
 * 원문 붙여 넣기 키를 적어 둔다. 한글 입력 상태에서는 `key` 가 `ㅍ` 이나 `Process` 이므로 물리 키(`code`, `keyCode`)도 본다
 * (CodeMirror 의 keymap 도 그렇게 한다). 붙여 넣기 없이(빈 클립보드) 다른 키를 누르면 적어 둔 것을 지운다:
 * 그 뒤의 보통 Ctrl+V 가 원문으로 붙지 않게. 수정 키만 누른 것은 세지 않는다.
 */
function notePlainKey(e: KeyboardEvent, view: EditorView): boolean {
  const isV = e.key.toLowerCase() === 'v' || e.code === 'KeyV' || e.keyCode === 86;
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && isV) plainUntil.set(view, Date.now() + PLAIN_WINDOW_MS);
  else if (!MODIFIER_KEYS.has(e.key)) plainUntil.delete(view);
  return false; // 기본 동작(브라우저의 붙여 넣기)은 그대로
}

/** 이번 붙여 넣기가 원문 붙여 넣기인가. 한 번 보면 지운다. */
function takePlain(view: EditorView): boolean {
  const until = plainUntil.get(view);
  plainUntil.delete(view);
  return until !== undefined && Date.now() <= until;
}

const clipboardText = (e: ClipboardEvent) => e.clipboardData?.getData('text/plain') ?? '';
const isLocked = (state: EditorState) => state.readOnly || !state.facet(EditorView.editable);
const annotations = () => [isolateHistory.of('full'), Transaction.userEvent.of('input.paste')];

/** 선택이 표(격자든 원문이든) 안에 걸쳐 있는가. 그때는 새 표를 만들지 않는다. */
function touchesTable(state: EditorState): boolean {
  const { from, to } = state.selection.main;
  return findTables(state).some((s) => s.from <= to && from <= s.to);
}

/**
 * 글자를 그대로 두어야 하는 노드: 코드와 머리말. 그 안의 탭은 들여쓰기이거나 YAML 이다.
 * 값은 끝 위치도 안으로 보는가: 들여쓴 코드 블록은 마지막 코드 줄 끝에서 끝나지만, 울타리 코드·머리말은 닫는 줄 끝에서 끝난다.
 */
const RAW_NODES: Record<string, boolean> = { FencedCode: false, CodeBlock: true, InlineCode: false, Frontmatter: false };

/** 위치가 코드나 머리말 안인가. 구문 트리를 그 위치까지 (잠깐) 읽는다. */
export function inRawText(state: EditorState, pos: number): boolean {
  const tree = ensureSyntaxTree(state, pos, 50) ?? syntaxTree(state);
  for (const side of [-1, 1] as const) {
    for (let n: SyntaxNode | null = tree.resolveInner(pos, side); n; n = n.parent) {
      const endInside = RAW_NODES[n.name];
      if (endInside !== undefined && n.from < pos && (pos < n.to || (endInside && pos === n.to))) return true;
    }
  }
  return false;
}

/** 바깥 편집기의 선택 자리에 TSV 로 새 표를 넣는다. 커서는 표 아래 빈 문단 줄. 넣었으면 true. 코드·머리말·표 안이면 false. */
export function pasteAsTable(view: EditorView, text: string): boolean {
  const state = view.state;
  if (isLocked(state) || !isTabular(text) || touchesTable(state)) return false;
  const sel = state.selection.main;
  if (inRawText(state, sel.from) || inRawText(state, sel.to)) return false;
  const grid = parseTSV(text);
  const block = tableFromGrid(grid, state.lineBreak);
  const { from, to } = state.selection.main;
  // 표 뒤에는 빈 줄과 빈 문단 줄이 온다. 커서는 그 빈 문단 줄: 표 끝에 두면 Enter 다음에 친 글이 표의 행이 된다
  const { change, after } = placeTable(state, from, to, block);
  view.dispatch({ changes: change, selection: { anchor: after }, annotations: annotations(), scrollIntoView: true });
  return true;
}

/** 셀 편집기가 든 칸부터 TSV 사각형을 채운다. 포커스는 그 칸에 남는다. 채웠으면 true. */
export function pasteIntoCell(outer: EditorView, text: string): boolean {
  const state = outer.state;
  const ac = state.field(activeCell, false);
  if (!ac || isLocked(state) || !isTabular(text)) return false;
  const found = locateTable(state, ac.tableFrom);
  if (!found) return false;
  const changes = pasteRect(found.m, ac.r, ac.c, parseTSV(text), state.lineBreak);
  if (!changes.length) return false;
  const tr = state.update({ changes: shiftChanges(changes, found.span.from), annotations: annotations() });
  outer.dispatch(tr);
  focusCell(outer, tr.changes.mapPos(found.span.from, -1), ac.r, ac.c, 'end');
  return true;
}

/** tableExtension 이 싣는 붙여 넣기 부분: 바깥 편집기와 셀 편집기 둘 다. */
export function tablePasteExtension(): Extension {
  return [
    EditorView.domEventHandlers({
      keydown: notePlainKey,
      paste(e, view) {
        if (takePlain(view)) return false;
        if (!pasteAsTable(view, clipboardText(e))) return false;
        e.preventDefault();
        return true;
      },
    }),
    cellExtras.of(
      EditorView.domEventHandlers({
        keydown: notePlainKey,
        paste(e, nested) {
          if (takePlain(nested)) return false;
          const outer = outerOf(nested);
          if (!outer || !pasteIntoCell(outer, clipboardText(e))) return false;
          e.preventDefault();
          return true;
        },
      }),
    ),
  ];
}
