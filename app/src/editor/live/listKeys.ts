import { ChangeSet, type ChangeSpec, type EditorState } from '@codemirror/state';
import type { Command, EditorView, KeyBinding } from '@codemirror/view';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { deleteMarkupBackward, insertNewlineContinueMarkupCommand } from '@codemirror/lang-markdown';
import type { SyntaxNode, Tree } from '@lezer/common';

/**
 * 목록 키(계획 D10). 바깥 편집기가 두 모드 모두에서 Prec.high 로 단다(모드 칸 밖).
 * lang-markdown 의 자체 keymap 은 끈다(`addKeymap: false`): 켜 두면 같은 Enter 가 둘이 되어 하나는 영영 돌지 않는다.
 *
 * - Enter / Backspace: 목록 이어 쓰기와 표시 지우기. 한글 조합 중에는 false 를 돌려 손대지 않는다.
 * - Tab / Shift+Tab: 선택이 닿은 모든 줄이 목록 항목 안일 때만 들이고 내민다. 들이는 폭은 부모가 될 항목의 내용 열
 *   (`- ` 는 2, `1. ` 은 3)이라 CommonMark 로 바르게 중첩된다. 번호 목록은 번호를 다시 매긴다. 한 트랜잭션,
 *   userEvent 'input.indent'. 목록 밖에서는 false: Tab 이 초점을 옮기는 접근성 탈출구로 남고, 표 칸 안의 Tab 은
 *   셀 편집기가 먼저 받는다.
 */

const composing = (view: EditorView) => view.composing || view.compositionStarted;

/**
 * lang-markdown 의 이어 쓰기. 붙은 목록의 빈 둘째 항목에서 Enter 를 누르면 기본값은 그 위에 빈 줄을 넣어 느슨한 목록을
 * 만드는데, Obsidian 처럼 목록을 끝내도록 끈다(`nonTightLists: false`).
 */
const continueMarkup = insertNewlineContinueMarkupCommand({ nonTightLists: false });

/** Enter: 목록·인용의 표시를 이어 쓴다. 빈 항목에서는 표시를 지워 목록을 끝낸다. 조합 중에는 손대지 않는다. */
export const continueList: Command = (view) => !composing(view) && continueMarkup(view);

/** Backspace: 줄 앞 표시를 지운다. 조합 중에는 손대지 않는다. */
export const deleteMarkup: Command = (view) => !composing(view) && deleteMarkupBackward(view);

const LIST = new Set(['BulletList', 'OrderedList']);
const ORDERED = /^(\d+)([.)])$/;

function treeOf(state: EditorState): Tree {
  return ensureSyntaxTree(state, state.doc.length, 200) ?? syntaxTree(state);
}

/** 위치에서 가장 안쪽의 목록 항목. */
function itemAt(tree: Tree, pos: number): SyntaxNode | null {
  for (let n: SyntaxNode | null = tree.resolveInner(pos, 1); n; n = n.parent) if (n.name === 'ListItem') return n;
  return null;
}

/** 줄 앞 공백(스페이스·탭)의 길이. */
function indentOf(text: string): number {
  let i = 0;
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++;
  return i;
}

/** 항목의 내용 열: 표시 뒤 공백까지 지난 첫 글자의 줄 안 위치. 빈 항목이면 표시 끝 + 1. */
function contentColumn(state: EditorState, item: SyntaxNode): number {
  const line = state.doc.lineAt(item.from);
  const mark = item.firstChild!;
  const i = mark.to - line.from;
  const text = line.text;
  let n = 0;
  while (i + n < text.length && text[i + n] === ' ') n++;
  if (i + n >= text.length || text[i + n] === '\r' || n === 0 || n > 4) return i + 1;
  return i + n;
}

/** 선택이 닿은 줄들이 모두 목록 항목 안이면 그 항목들(조상 항목이 함께 골라진 것은 뺀다), 아니면 null. */
function selectedItems(state: EditorState, tree: Tree): SyntaxNode[] | null {
  const items: SyntaxNode[] = [];
  for (const r of state.selection.ranges) {
    for (let n = state.doc.lineAt(r.from).number; n <= state.doc.lineAt(r.to).number; n++) {
      const line = state.doc.line(n);
      const lead = indentOf(line.text);
      if (lead >= line.text.replace(/\r$/, '').length) continue; // 빈 줄은 건너뛴다
      const item = itemAt(tree, line.from + lead);
      if (!item) return null;
      if (!items.some((i) => i.from === item.from)) items.push(item);
    }
  }
  if (!items.length) return null;
  const inside = (a: SyntaxNode, b: SyntaxNode) => a !== b && a.from >= b.from && a.to <= b.to;
  return items.filter((i) => !items.some((o) => inside(i, o))).sort((a, b) => a.from - b.from);
}

/** 항목의 이전 형제 항목. */
function prevSibling(item: SyntaxNode): SyntaxNode | null {
  for (let s = item.prevSibling; s; s = s.prevSibling) if (s.name === 'ListItem') return s;
  return null;
}

/** 부모 목록을 담은 항목(한 단계 바깥 항목). */
function parentItem(item: SyntaxNode): SyntaxNode | null {
  const list = item.parent;
  const p = list?.parent;
  return list && LIST.has(list.name) && p?.name === 'ListItem' ? p : null;
}

/** 항목이 차지한 줄들(첫 줄부터 마지막 줄까지, 1부터). */
function linesOf(state: EditorState, item: SyntaxNode): [number, number] {
  const last = state.doc.lineAt(Math.max(item.from, item.to - 1)).number;
  return [state.doc.lineAt(item.from).number, last];
}

/**
 * 번호 목록의 번호를 다시 매긴다(옮긴 뒤의 상태에서). 줄 수는 옮겨도 그대로라 항목은 줄 번호로 알아본다.
 * `movedLines` 는 옮긴 항목의 첫 줄, `keptFirsts` 는 옮기기 전에도 목록의 첫 항목이던 줄과 그 번호(출발 번호로 그대로 쓴다).
 * 다시 매기는 목록: 옮긴 항목이 든 목록, 그 바깥 목록(떠나온 곳), 옮긴 항목 안의 목록(데려온 것, 남겨진 것).
 */
function renumber(state: EditorState, movedLines: Set<number>, keptFirsts: Map<number, number>): ChangeSpec[] {
  const tree = treeOf(state);
  const lines = (pos: number) => state.doc.lineAt(pos).number;
  const lists = new Map<number, SyntaxNode>();
  const add = (n: SyntaxNode | null | undefined) => {
    if (n && n.name === 'OrderedList') lists.set(n.from, n);
  };
  for (const n of movedLines) {
    const line = state.doc.line(n);
    const item = itemAt(tree, line.from + indentOf(line.text));
    if (!item) continue;
    add(item.parent);
    add(parentItem(item)?.parent);
    for (let c = item.firstChild; c; c = c.nextSibling) add(c);
  }
  const out: ChangeSpec[] = [];
  for (const list of lists.values()) {
    let next: number | null = null;
    for (let item = list.firstChild; item; item = item.nextSibling) {
      if (item.name !== 'ListItem') continue;
      const mark = item.firstChild;
      if (!mark || mark.name !== 'ListMark') continue;
      const m = ORDERED.exec(state.sliceDoc(mark.from, mark.to));
      if (!m) continue;
      const ln = lines(mark.from);
      if (next === null) next = !movedLines.has(ln) && keptFirsts.has(ln) ? keptFirsts.get(ln)! : 1;
      const want = String(next++);
      if (want !== m[1]) out.push({ from: mark.from, to: mark.from + m[1].length, insert: want });
    }
  }
  return out;
}

function shiftItems(view: EditorView, dir: 1 | -1): boolean {
  if (composing(view)) return false;
  const { state } = view;
  if (state.readOnly) return false;
  const tree = treeOf(state);
  const items = selectedItems(state, tree);
  if (!items) return false;

  // 줄마다 바꿀 폭. 옮기지 못하는 항목(첫 항목을 들이기, 맨 바깥 항목을 내밀기)은 그대로 둔다.
  const delta = new Map<number, number>();
  /** 옮긴 항목의 첫 줄 → 새 번호 목록을 여는 번호 항목인가. 2 로 시작하는 목록은 문단을 끊지 못하므로 들이면서 1 로 적는다. */
  const moved = new Map<number, boolean>();
  for (const item of items) {
    const line = state.doc.lineAt(item.from);
    const current = item.from - line.from;
    let target: number;
    let opens = false;
    if (dir > 0) {
      const prev = prevSibling(item);
      if (!prev) continue;
      target = contentColumn(state, prev);
      let hasList = false;
      for (let c = prev.firstChild; c; c = c.nextSibling) if (LIST.has(c.name)) hasList = true;
      opens = item.parent?.name === 'OrderedList' && !hasList;
    } else {
      const parent = parentItem(item);
      if (!parent) continue;
      target = parent.from - state.doc.lineAt(parent.from).from;
    }
    const d = target - current;
    if (d === 0) continue;
    moved.set(line.number, opens);
    const [first, last] = linesOf(state, item);
    for (let n = first; n <= last; n++) delta.set(n, d);
  }
  // 목록 안이니 키는 먹는다: 옮길 것이 없어도 초점이 편집기 밖으로 나가지 않게
  if (!moved.size) return true;

  const specs: ChangeSpec[] = [];
  for (const [n, d] of delta) {
    const line = state.doc.line(n);
    const lead = indentOf(line.text);
    const num = moved.get(n) ? /^\d+/.exec(line.text.slice(lead))?.[0] : undefined;
    if (num !== undefined && num !== '1') {
      // 들임과 번호 바꾸기를 한 조각으로: 같은 자리의 끼우기와 바꾸기가 겹치지 않게
      specs.push({ from: line.from, to: line.from + lead + num.length, insert: ' '.repeat(d) + line.text.slice(0, lead) + '1' });
    } else if (d > 0) {
      if (line.text.trim() === '') continue; // 빈 줄(끝의 CR 만 있는 줄 포함)은 들이지 않는다
      specs.push({ from: line.from, insert: ' '.repeat(d) });
    } else {
      const cut = Math.min(-d, lead);
      if (cut) specs.push({ from: line.from, to: line.from + cut });
    }
  }
  const first = state.changes(specs);

  // 옮기기 전에 목록의 첫 항목이던 줄과 번호: 그 목록은 그 번호에서 출발한다
  const keptFirsts = new Map<number, number>();
  tree.iterate({
    enter: (n) => {
      if (n.name !== 'OrderedList') return;
      const mark = n.node.getChild('ListItem')?.firstChild;
      const m = mark && ORDERED.exec(state.sliceDoc(mark.from, mark.to));
      if (mark && m) keptFirsts.set(state.doc.lineAt(mark.from).number, Number(m[1]));
    },
  });
  const mid = state.update({ changes: first }).state;
  const second = ChangeSet.of(renumber(mid, new Set(moved.keys()), keptFirsts), mid.doc.length);

  view.dispatch({ changes: first.compose(second), userEvent: 'input.indent', scrollIntoView: true });
  return true;
}

/** Tab: 선택이 닿은 목록 항목을 한 단계 들인다(앞 형제 항목의 자식으로). */
export const indentListItem: Command = (view) => shiftItems(view, 1);

/** Shift+Tab: 선택이 닿은 목록 항목을 한 단계 내민다(부모 항목의 형제로). */
export const outdentListItem: Command = (view) => shiftItems(view, -1);

export const LIST_KEYS: readonly KeyBinding[] = [
  { key: 'Enter', run: continueList },
  { key: 'Backspace', run: deleteMarkup },
  { key: 'Tab', run: indentListItem, shift: outdentListItem },
];
