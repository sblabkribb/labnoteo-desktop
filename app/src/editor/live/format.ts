import { ChangeSet, EditorSelection, type ChangeSpec, type EditorState, type SelectionRange, type TransactionSpec } from '@codemirror/state';
import { isolateHistory } from '@codemirror/commands';
import { ensureSyntaxTree, language, syntaxTree } from '@codemirror/language';
import type { SyntaxNode, Tree } from '@lezer/common';

/**
 * 서식 명령의 순수 빌더(계획 Task 17). 상태를 받아 트랜잭션 명세를 돌려줄 뿐 dispatch 하지 않는다:
 * 단축키·팔레트·문맥 메뉴와 표 칸 전달(Task 18)이 같은 빌더를 쓴다.
 *
 * - 모든 빌더는 한 트랜잭션(userEvent 'input.format', isolateHistory 'full')이고, 읽기 전용이면 null 이다.
 * - 바뀌는 것이 없으면 null 이다.
 * - 줄 표시(목록·할 일·인용·제목)는 구문 트리로 찾고 그 자리에서 바꾼다: 앞 들여쓰기는 남기고 표시는 겹쳐 쌓지 않는다.
 *   마크다운 언어가 없는 상태(한 줄 칸 등)에서는 같은 규칙의 정규식으로 찾는다.
 * - 넣는 줄바꿈은 `state.lineBreak` 이다.
 */

export type InlineMark = '**' | '*' | '~~' | '`' | '==';
export const FORMAT_EVENT = 'input.format';

const NODE_OF: Record<InlineMark, string> = {
  '**': 'StrongEmphasis',
  '*': 'Emphasis',
  '~~': 'Strikethrough',
  '`': 'InlineCode',
  '==': 'Highlight',
};
const MARK_NODES = new Set(['EmphasisMark', 'StrikethroughMark', 'CodeMark', 'HighlightMark']);

function finish(spec: TransactionSpec): TransactionSpec {
  return { ...spec, userEvent: FORMAT_EVENT, annotations: isolateHistory.of('full'), scrollIntoView: true };
}

/** 마크다운 언어가 실린 상태의 트리. 언어가 없으면 null(정규식으로 대신한다). */
function treeOf(state: EditorState): Tree | null {
  if (!state.facet(language)) return null;
  return ensureSyntaxTree(state, state.doc.length, 200) ?? syntaxTree(state);
}

/* ------------------------------------------------------------------ 글자 서식 */

/** 범위를 감싼(또는 범위와 같은) 해당 종류의 노드. 빈 범위는 노드 안쪽(경계 제외)에 있어야 한다. */
function enclosing(tree: Tree, kind: string, from: number, to: number): SyntaxNode | null {
  for (let n: SyntaxNode | null = tree.resolveInner(from, 1); n; n = n.parent) {
    if (n.name !== kind) continue;
    if (n.from <= from && to <= n.to && (from !== to || (n.from < from && from < n.to))) return n;
  }
  return null;
}

/** 위치에서 한쪽으로 이어진 같은 글자의 수. */
function run(state: EditorState, pos: number, dir: 1 | -1, ch: string): number {
  let n = 0;
  for (let p = pos; dir < 0 ? p > 0 : p < state.doc.length; p += dir) {
    if (state.sliceDoc(dir < 0 ? p - 1 : p, dir < 0 ? p : p + 1) !== ch) break;
    n++;
  }
  return n;
}

/** 범위 바로 바깥의 글이 표시인가. `*` 와 `**` 는 별 개수로 굵게·기울임을 가린다(`**b**` 의 별 하나를 떼지 않는다). */
function markedOutside(state: EditorState, mark: InlineMark, from: number, to: number): boolean {
  const len = mark.length;
  if (from < len || to + len > state.doc.length) return false;
  if (state.sliceDoc(from - len, from) !== mark || state.sliceDoc(to, to + len) !== mark) return false;
  if (mark !== '*' && mark !== '**') return true;
  const before = run(state, from, -1, '*');
  const after = run(state, to, 1, '*');
  return mark === '*' ? before % 2 === 1 && after % 2 === 1 : before >= 2 && after >= 2;
}

export function toggleInline(state: EditorState, mark: InlineMark): TransactionSpec | null {
  if (state.readOnly) return null;
  const tree = treeOf(state);
  const len = mark.length;
  const spec = state.changeByRange((range) => {
    const { from, to } = range;
    // 풀기: 트리의 같은 종류 노드 안이거나 범위가 그 노드와 같을 때.
    const node = tree ? enclosing(tree, NODE_OF[mark], from, to) : null;
    if (node) {
      const open = node.firstChild;
      const close = node.lastChild;
      if (open && close && open !== close && MARK_NODES.has(open.name) && MARK_NODES.has(close.name)) {
        const changes: ChangeSpec[] = [
          { from: open.from, to: open.to },
          { from: close.from, to: close.to },
        ];
        const cs = ChangeSet.of(changes, state.doc.length);
        const a = cs.mapPos(from, 1);
        return { changes, range: EditorSelection.range(a, Math.max(a, cs.mapPos(to, -1))) };
      }
    }
    // 풀기: 범위 바로 바깥이 표시일 때. 트리가 있는 상태의 빈 커서는 이 규칙을 쓰지 않는다(`**|**` 는 트리로 판단).
    if ((from !== to || !tree) && markedOutside(state, mark, from, to)) {
      return {
        changes: [
          { from: from - len, to: from },
          { from: to, to: to + len },
        ],
        range: EditorSelection.range(from - len, to - len),
      };
    }
    // 감싸기. 빈 범위는 커서의 낱말을, 낱말이 없으면 표시 둘 사이에 커서를 둔다.
    if (from === to) {
      const word = state.wordAt(from);
      if (!word) return { changes: { from, insert: mark + mark }, range: EditorSelection.cursor(from + len) };
      return {
        changes: [
          { from: word.from, insert: mark },
          { from: word.to, insert: mark },
        ],
        range: EditorSelection.range(word.from + len, word.to + len),
      };
    }
    return {
      changes: [
        { from, insert: mark },
        { from: to, insert: mark },
      ],
      range: EditorSelection.range(from + len, to + len),
    };
  });
  return spec.changes.empty ? null : finish(spec);
}

/** `[선택]()` 로 감싸고 커서를 `()` 안에 둔다. */
export function insertLink(state: EditorState): TransactionSpec | null {
  if (state.readOnly) return null;
  const spec = state.changeByRange((range) => {
    const insert = `[${state.sliceDoc(range.from, range.to)}]()`;
    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.cursor(range.from + insert.length - 1),
    };
  });
  return finish(spec);
}

/* ------------------------------------------------------------------ 줄 표시 */

type LineKind = 'bullet' | 'ordered' | 'task' | 'quote';

interface Marker {
  kind: LineKind;
  /** 표시의 시작(앞 들여쓰기 뒤)과 표시 뒤 공백까지의 끝. */
  from: number;
  to: number;
  /** 목록 표시 자체(`-`, `1.`)의 끝. */
  listTo?: number;
  /** 할 일 칸 안 글자의 위치와 체크 여부. */
  boxAt?: number;
  checked?: boolean;
}

const isBlank = (text: string) => /^[ \t]*\r?$/.test(text);

/** 공백(스페이스·탭)을 건너뛴 위치. */
function skipSpaces(text: string, i: number): number {
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++;
  return i;
}

/** 구문 트리로 찾은 줄의 첫 표시(인용 또는 목록, 할 일 포함). */
function treeMarker(state: EditorState, tree: Tree, lineNo: number): Marker | null {
  const line = state.doc.line(lineNo);
  let mark: SyntaxNode | null = null;
  tree.iterate({
    from: line.from,
    to: line.to,
    enter: (ref) => {
      if (mark) return false;
      if ((ref.name === 'QuoteMark' || ref.name === 'ListMark') && ref.from >= line.from && ref.to <= line.to) {
        mark = ref.node;
        return false;
      }
      return undefined;
    },
  });
  const m = mark as SyntaxNode | null;
  if (!m) return null;
  const text = line.text;
  const rel = (p: number) => p - line.from;
  if (m.name === 'QuoteMark') {
    const next = text[rel(m.to)];
    return { kind: 'quote', from: m.from, to: next === ' ' || next === '\t' ? m.to + 1 : m.to };
  }
  const ordered = /\d/.test(state.sliceDoc(m.from, m.from + 1));
  const task = m.parent?.getChild('Task')?.getChild('TaskMarker') ?? null;
  if (task && state.doc.lineAt(task.from).number === lineNo) {
    const ch = state.sliceDoc(task.from + 1, task.to - 1);
    return {
      kind: 'task',
      from: m.from,
      to: line.from + skipSpaces(text, rel(task.to)),
      listTo: m.to,
      boxAt: task.from + 1,
      checked: ch !== ' ',
    };
  }
  return { kind: ordered ? 'ordered' : 'bullet', from: m.from, to: line.from + skipSpaces(text, rel(m.to)), listTo: m.to };
}

const LINE_RE = /^([ \t]*)(?:(>[ \t]?)|((?:[-*+]|\d{1,9}[.)]))(?:[ \t]+\[([ xX])\])?(?:[ \t]+|(?=\r?$)))/;

/** 언어가 없는 상태: 같은 규칙의 정규식. */
function regexMarker(state: EditorState, lineNo: number): Marker | null {
  const line = state.doc.line(lineNo);
  const m = LINE_RE.exec(line.text);
  if (!m) return null;
  const from = line.from + m[1].length;
  const to = line.from + m[0].length;
  if (m[2] !== undefined) return { kind: 'quote', from, to };
  const listTo = from + m[3].length;
  if (m[4] !== undefined) {
    const boxAt = line.from + line.text.indexOf('[', listTo - line.from) + 1;
    return { kind: 'task', from, to, listTo, boxAt, checked: m[4] !== ' ' };
  }
  return { kind: /\d/.test(m[3]) ? 'ordered' : 'bullet', from, to, listTo };
}

function markerFinder(state: EditorState): (lineNo: number) => Marker | null {
  const tree = treeOf(state);
  return tree ? (n) => treeMarker(state, tree, n) : (n) => regexMarker(state, n);
}

/** 범위가 닿은 줄 구간. 다음 줄 맨 앞에서 끝난 범위는 그 줄을 건드리지 않은 것으로 본다. */
function lineSpan(state: EditorState, r: SelectionRange): [number, number] {
  const a = state.doc.lineAt(r.from).number;
  let b = state.doc.lineAt(r.to).number;
  if (b > a && r.to === state.doc.line(b).from) b--;
  return [a, b];
}

/** 선택이 닿은 줄 번호(겹침 없이, 오름차순). 여러 줄이면 빈 줄은 뺀다(모두 비었으면 그대로). */
function touchedLines(state: EditorState): number[] {
  const set = new Set<number>();
  for (const r of state.selection.ranges) {
    const [a, b] = lineSpan(state, r);
    for (let n = a; n <= b; n++) set.add(n);
  }
  const all = [...set].sort((x, y) => x - y);
  const filled = all.filter((n) => !isBlank(state.doc.line(n).text));
  return all.length > 1 && filled.length ? filled : all;
}

/** 줄 표시를 바꾼 뒤의 선택: 빈 커서는 넣은 표시 뒤로, 범위는 바뀐 줄의 표시까지 덮도록 넓힌다. */
function lineSpec(state: EditorState, changes: ChangeSpec[]): TransactionSpec | null {
  const cs = state.changes(changes);
  if (cs.empty) return null;
  const ranges = state.selection.ranges.map((r) => {
    if (r.empty) return EditorSelection.cursor(cs.mapPos(r.head, 1));
    const from = cs.mapPos(r.from, -1);
    const to = cs.mapPos(r.to, 1);
    return r.anchor <= r.head ? EditorSelection.range(from, to) : EditorSelection.range(to, from);
  });
  return finish({ changes: cs, selection: EditorSelection.create(ranges, state.selection.mainIndex) });
}

/**
 * 닿은 줄에 목록·번호·인용 표시를 단다. 있던 표시(목록·할 일·인용)는 그 자리에서 바꾸고, 모든 줄이 이미 그 종류면 뗀다.
 * 번호는 닿은 줄 순서대로 1 부터 매긴다.
 */
export function toggleLinePrefix(state: EditorState, kind: 'bullet' | 'ordered' | 'quote'): TransactionSpec | null {
  if (state.readOnly) return null;
  const find = markerFinder(state);
  const lines = touchedLines(state).map((n) => ({ line: state.doc.line(n), marker: find(n) }));
  const remove = lines.every((l) => l.marker?.kind === kind);
  const changes: ChangeSpec[] = [];
  let num = 1;
  for (const { line, marker } of lines) {
    const insert = remove ? '' : kind === 'bullet' ? '- ' : kind === 'quote' ? '> ' : `${num++}. `;
    if (marker) {
      if (state.sliceDoc(marker.from, marker.to) !== insert) changes.push({ from: marker.from, to: marker.to, insert });
    } else if (insert) {
      changes.push({ from: line.from, insert });
    }
  }
  return lineSpec(state, changes);
}

/**
 * 할 일 순환: 표시 없음·인용 → `- [ ] `, 목록 → 목록 표시 뒤에 `[ ] `, `[ ]` → `[x]`, `[x]` → `[ ]`.
 * 여러 줄이면 첫 줄의 다음 상태로 모두 맞춘다. 칸을 뒤집을 때는 칸 안 한 글자만 바꾼다.
 */
export function cycleTask(state: EditorState): TransactionSpec | null {
  if (state.readOnly) return null;
  const find = markerFinder(state);
  const lines = touchedLines(state).map((n) => ({ line: state.doc.line(n), marker: find(n) }));
  const head = lines[0]?.marker;
  const check = head?.kind === 'task' && !head.checked;
  const box = check ? '[x] ' : '[ ] ';
  const changes: ChangeSpec[] = [];
  for (const { line, marker } of lines) {
    if (marker?.kind === 'task') {
      if (marker.checked !== check) changes.push({ from: marker.boxAt!, to: marker.boxAt! + 1, insert: check ? 'x' : ' ' });
    } else if (marker && (marker.kind === 'bullet' || marker.kind === 'ordered')) {
      changes.push({ from: marker.listTo!, to: marker.to, insert: ' ' + box });
    } else if (marker) {
      changes.push({ from: marker.from, to: marker.to, insert: '- ' + box });
    } else {
      changes.push({ from: line.from, insert: '- ' + box });
    }
  }
  return lineSpec(state, changes);
}

interface Heading {
  level: number;
  from: number;
  to: number;
}

/** ATX 제목의 단계와 표시 범위(`#` 부터 뒤 공백까지). */
function headingOf(state: EditorState, tree: Tree | null, lineNo: number): Heading | null {
  const line = state.doc.line(lineNo);
  const text = line.text;
  if (!tree) {
    const m = /^( {0,3})(#{1,6})(?:[ \t]+|(?=\r?$))/.exec(text);
    return m ? { level: m[2].length, from: line.from + m[1].length, to: line.from + m[0].length } : null;
  }
  let found: Heading | null = null;
  tree.iterate({
    from: line.from,
    to: line.to,
    enter: (ref) => {
      if (found) return false;
      const m = /^ATXHeading(\d)$/.exec(ref.name);
      if (!m) return undefined;
      const mark = ref.node.getChild('HeaderMark');
      if (mark && mark.from >= line.from && mark.to <= line.to) {
        found = { level: Number(m[1]), from: mark.from, to: line.from + skipSpaces(text, mark.to - line.from) };
      }
      return false;
    },
  });
  return found;
}

/** 닿은 줄을 그 단계의 제목으로 바꾼다. 이미 같은 단계인 줄은 제목을 푼다(0 은 언제나 푼다). */
export function setHeading(state: EditorState, level: 0 | 1 | 2 | 3 | 4 | 5 | 6): TransactionSpec | null {
  if (state.readOnly) return null;
  const tree = treeOf(state);
  const changes: ChangeSpec[] = [];
  for (const n of touchedLines(state)) {
    const line = state.doc.line(n);
    const h = headingOf(state, tree, n);
    const want = h && h.level === level ? 0 : level;
    const insert = want ? '#'.repeat(want) + ' ' : '';
    if (h) {
      if (state.sliceDoc(h.from, h.to) !== insert) changes.push({ from: h.from, to: h.to, insert });
    } else if (insert) {
      changes.push({ from: line.from, insert });
    }
  }
  return lineSpec(state, changes);
}

/** 닿은 줄들을 펜스 코드 블록으로 감싼다. 커서 하나가 빈 줄에 있으면 빈 블록을 넣고 커서를 그 안에 둔다. */
export function wrapCodeBlock(state: EditorState): TransactionSpec | null {
  if (state.readOnly) return null;
  const br = state.lineBreak;
  const fence = '```';
  // 범위마다 닿은 줄 구간. 겹치거나 맞닿은 구간은 합친다.
  const blocks: { a: number; b: number }[] = [];
  for (const r of [...state.selection.ranges].sort((x, y) => x.from - y.from)) {
    const [a, b] = lineSpan(state, r);
    const last = blocks[blocks.length - 1];
    if (last && a <= last.b + 1) last.b = Math.max(last.b, b);
    else blocks.push({ a, b });
  }
  if (blocks.length === 1 && blocks[0].a === blocks[0].b && state.selection.ranges.length === 1) {
    const line = state.doc.line(blocks[0].a);
    if (isBlank(line.text)) {
      const insert = fence + br + br + fence;
      return finish({ changes: { from: line.from, insert }, selection: EditorSelection.cursor(line.from + fence.length + br.length) });
    }
  }
  const changes: ChangeSpec[] = [];
  for (const { a, b } of blocks) {
    changes.push({ from: state.doc.line(a).from, insert: fence + br }, { from: state.doc.line(b).to, insert: br + fence });
  }
  const cs = state.changes(changes);
  return finish({ changes: cs, selection: state.selection.map(cs) });
}
