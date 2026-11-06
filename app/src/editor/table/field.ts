import { Facet, RangeSet, RangeSetBuilder, RangeValue, StateField, type EditorState, type Extension } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { parseTable } from './model';
import { TableWidget, toggleRawTable } from './widget';

export { toggleRawTable };

/**
 * 표를 격자 위젯으로 바꾸는 StateField(연구 문서 §4.2).
 *
 * - 블록 위젯이 줄바꿈을 덮으므로 ViewPlugin 이 아니라 StateField 여야 한다.
 * - 문서의 맨 위(Document 의 바로 아래) 표만 바꾼다. 인용(Blockquote)이나 목록(ListItem) 안의 표는 원문 그대로다.
 * - `rawTables` 에 든 표는 원문으로 남는다("마크다운으로 편집"). 선택이 그 표를 떠나면 격자로 돌아온다.
 * - 문서·구문 트리·원문 표시·잠금이 바뀔 때만 다시 만든다. 표는 적으니 맨 위 노드를 훑는 것으로 충분하다.
 */

export interface TableOptions {
  /** 셀 편집기가 Mod-s 로 부른다(Task 4). */
  save: () => void;
  /** 편집기가 들어 있는 루트(그림자 루트). 셀 편집기가 쓴다(Task 4). */
  root: ShadowRoot | Document;
}

/** tableExtension 에 넘긴 선택 사항. 셀 편집기(Task 4)가 상태에서 읽는다. */
export const tableOptions = Facet.define<TableOptions, TableOptions | null>({
  combine: (values) => values[0] ?? null,
});

/** 표 하나가 차지하는 줄 범위: 첫 줄의 시작부터 마지막 줄의 끝(줄바꿈 제외)까지. */
export interface TableSpan {
  from: number;
  to: number;
}

/** 문서 맨 위의 표들. 들여 쓴 표도 줄 시작부터 덮는다(블록 위젯은 줄 전체를 바꿔야 한다). */
export function findTables(state: EditorState): TableSpan[] {
  const out: TableSpan[] = [];
  for (let n = syntaxTree(state).topNode.firstChild; n; n = n.nextSibling) {
    if (n.name !== 'Table') continue;
    out.push({ from: state.doc.lineAt(n.from).from, to: state.doc.lineAt(n.to).to });
  }
  return out;
}

/** 원문 표시 중인 표의 시작 위치 표지. 표 앞에 글자가 들어가도 표를 따라 밀린다(-1 쪽에 붙는다). */
class RawMark extends RangeValue {
  startSide = -1;
  endSide = -1;
  eq(): boolean {
    return true;
  }
}
const rawMark = new RawMark();

const hasPoint = (set: RangeSet<RawMark>, pos: number) => {
  let found = false;
  set.between(pos, pos, (from) => {
    if (from === pos) found = true;
  });
  return found;
};

/** 원문으로 보이는 표들의 시작 위치. `toggleRawTable` 로 넣고 빼며, 선택이 그 표 밖으로 가면 빠진다. */
export const rawTables = StateField.define<RangeSet<RawMark>>({
  create: () => RangeSet.empty,
  update(set, tr) {
    let next = set.map(tr.changes);
    const added: number[] = [];
    for (const e of tr.effects) {
      if (!e.is(toggleRawTable)) continue;
      const pos = e.value;
      if (hasPoint(next, pos)) {
        next = next.update({ filter: (from) => from !== pos, filterFrom: pos, filterTo: pos });
      } else {
        next = next.update({ add: [rawMark.range(pos)] });
        added.push(pos);
      }
    }
    if (tr.selection && next.size) {
      const head = tr.state.selection.main.head;
      const tables = findTables(tr.state);
      next = next.update({
        filter: (from) => {
          if (added.includes(from)) return true; // 켜는 그 트랜잭션에서는 끄지 않는다
          const span = tables.find((s) => s.from === from);
          return !!span && head >= span.from && head <= span.to;
        },
      });
    }
    return next;
  },
});

const isLocked = (state: EditorState) => state.readOnly || !state.facet(EditorView.editable);

function build(state: EditorState): DecorationSet {
  const raw = state.field(rawTables, false) ?? RangeSet.empty;
  const editable = !isLocked(state);
  const out = new RangeSetBuilder<Decoration>();
  for (const span of findTables(state)) {
    if (hasPoint(raw, span.from)) continue;
    // 문서의 줄 구분자와 상관없이 `\n` 으로 읽는다: CodeMirror 의 위치는 줄바꿈을 한 글자로 센다
    const source = state.doc.sliceString(span.from, span.to);
    const model = parseTable(source, 0, source.length);
    if (!model) continue;
    out.add(span.from, span.to, Decoration.replace({ widget: new TableWidget(source, model, editable), block: true }));
  }
  return out.finish();
}

export const tableField = StateField.define<DecorationSet>({
  create: build,
  update(deco, tr) {
    const changed =
      tr.docChanged ||
      syntaxTree(tr.state) !== syntaxTree(tr.startState) ||
      tr.state.field(rawTables, false) !== tr.startState.field(rawTables, false) ||
      isLocked(tr.state) !== isLocked(tr.startState);
    return changed ? build(tr.state) : deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** 표 편집 확장. Task 4 가 셀 편집기를 여기에 더한다. */
export function tableExtension(opts: TableOptions): Extension {
  return [tableOptions.of(opts), rawTables, tableField];
}
