import { EditorState, Transaction, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { isolateHistory } from '@codemirror/commands';
import { pasteRect } from './model';
import { isTabular, parseTSV } from './tsv';
import { locateTable, placeBlock, shiftChanges, tableFromGrid } from './commands';
import { findTables } from './field';
import { activeCell, cellExtras, focusCell, outerOf } from './cellEditor';

/**
 * Excel·TSV 붙여 넣기(연구 문서 §4.4).
 *
 * - Excel 은 text/plain 에 TSV 를 넣는다(칸은 탭, 줄은 CRLF, 탭·줄바꿈·따옴표가 든 칸은 `"…"`). text/html 의 표는 v1 에서 보지 않는다.
 * - 칸 안: 칸이 둘 이상인 TSV 는 그 칸부터 사각형을 채운다(`pasteRect`, 모자라면 행과 열을 늘린다). 되돌리기 한 번.
 *   값 하나는 보통 글자처럼 붙고, 셀 편집기의 거르개가 파이프와 줄바꿈을 escape 한다.
 * - 바깥 편집기(표 밖): 칸이 둘 이상인 TSV 는 첫 행이 머리 행인 새 표가 된다. 앞뒤 글과는 빈 줄로 떨어진다. 되돌리기 한 번.
 * - Ctrl+Shift+V(맥은 Cmd+Shift+V)는 서식 없이 원문 그대로 붙인다: 탭이 든 로그도 그대로 붙일 수 있다.
 *   붙여 넣기 사건에는 어떤 키로 붙였는지가 없으므로, 그 키를 누른 직후의 붙여 넣기 한 번을 원문으로 본다.
 * - 값은 바꾸지 않는다(`007`, `1/2`, `2E4` 그대로).
 */

/** 원문 붙여 넣기 키를 누른 뒤 이 시간 안의 붙여 넣기 하나를 원문으로 본다(ms). */
const PLAIN_WINDOW_MS = 1000;
const plainUntil = new WeakMap<EditorView, number>();

function notePlainKey(e: KeyboardEvent, view: EditorView): boolean {
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'v') plainUntil.set(view, Date.now() + PLAIN_WINDOW_MS);
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

/** 바깥 편집기의 선택 자리에 TSV 로 새 표를 넣는다. 커서는 표 끝. 넣었으면 true. */
export function pasteAsTable(view: EditorView, text: string): boolean {
  const state = view.state;
  if (isLocked(state) || !isTabular(text) || touchesTable(state)) return false;
  const grid = parseTSV(text);
  const block = tableFromGrid(grid, state.lineBreak);
  const { from, to } = state.selection.main;
  const { change, start } = placeBlock(state, from, to, block);
  // 커서는 표의 끝(CodeMirror 위치는 줄바꿈을 한 칸으로 센다)
  const length = state.toText(block).length;
  view.dispatch({ changes: change, selection: { anchor: start + length }, annotations: annotations(), scrollIntoView: true });
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
