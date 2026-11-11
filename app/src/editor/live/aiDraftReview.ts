import { Prec, RangeSetBuilder, StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state';
import { Decoration, EditorView, keymap, WidgetType, type DecorationSet } from '@codemirror/view';
import { t } from '../../i18n/t';

/**
 * AI 초안 검토 표시: AI 가 노트에 넣은 줄에 잠깐 옅은 바탕과 끝의 "검토 완료" 단추를 띄운다. 파일에는 아무것도 쓰지 않는다
 * (예전의 `> [!note] AI 초안 (모델, 날짜) — 검토 후 이 줄을 지우세요` 줄 대신, 2026-11-11 사용자 결정). 표시는
 * - 그 구간을 사용자가 고치면(구간에 닿는 변경) 그 구간만,
 * - "검토 완료" 를 누르면 그 구간만,
 * - Esc 를 누르면(키는 먹지 않는다: 다른 Esc 처리도 그대로 돈다) 모두
 * 사라진다. 상태는 편집기 상태에만 있어 노트를 다시 열면 없다.
 */

export interface DraftRange {
  from: number;
  to: number;
}

const addRanges = StateEffect.define<DraftRange[]>();
const removeRange = StateEffect.define<number>(); // 구간의 시작 위치
const clearAll = StateEffect.define<null>();

/** 두 구간이 겹치거나 맞닿는가. */
const touches = (r: DraftRange, from: number, to: number) => from <= r.to && to >= r.from;

const field = StateField.define<DraftRange[]>({
  create: () => [],
  update(ranges, tr) {
    let next = ranges;
    if (tr.docChanged && next.length > 0) {
      next = next
        .filter((r) => {
          let hit = false;
          tr.changes.iterChangedRanges((fromA, toA) => {
            if (touches(r, fromA, toA)) hit = true;
          });
          return !hit;
        })
        .map((r) => ({ from: tr.changes.mapPos(r.from, 1), to: tr.changes.mapPos(r.to, -1) }));
    }
    for (const e of tr.effects) {
      if (e.is(clearAll)) next = [];
      else if (e.is(removeRange)) next = next.filter((r) => r.from !== e.value);
      else if (e.is(addRanges)) {
        const len = tr.state.doc.length;
        const added = e.value
          .map((r) => ({ from: Math.max(0, Math.min(r.from, len)), to: Math.max(0, Math.min(r.to, len)) }))
          .filter((r) => r.to > r.from);
        next = [...next.filter((r) => !added.some((a) => touches(r, a.from, a.to))), ...added].sort((a, b) => a.from - b.from);
      }
    }
    return next;
  },
});

/** 구간 끝의 "검토 완료" 단추. 누르면 그 구간의 표시만 지운다. */
class DoneWidget extends WidgetType {
  constructor(readonly from: number) {
    super();
  }
  eq(other: DoneWidget): boolean {
    return other.from === this.from;
  }
  toDOM(view: EditorView): HTMLElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'cm-ai-draft-done';
    button.textContent = t('aiDraft.review.done');
    button.title = t('aiDraft.review.title');
    // mousedown: 편집기가 커서를 옮기기 전에 처리하고 초점을 빼앗지 않는다.
    button.addEventListener('mousedown', (e) => {
      e.preventDefault();
      view.dispatch({ effects: removeRange.of(this.from) });
    });
    return button;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

const lineMark = Decoration.line({ class: 'cm-ai-draft' });

function decorationsOf(state: EditorState): DecorationSet {
  const ranges = state.field(field, false) ?? [];
  if (ranges.length === 0) return Decoration.none;
  const builder = new RangeSetBuilder<Decoration>();
  for (const r of ranges) {
    const first = state.doc.lineAt(r.from).number;
    const last = state.doc.lineAt(r.to).number;
    for (let n = first; n <= last; n++) {
      const line = state.doc.line(n);
      builder.add(line.from, line.from, lineMark);
      if (n === last) builder.add(line.to, line.to, Decoration.widget({ widget: new DoneWidget(r.from), side: 1 }));
    }
  }
  return builder.finish();
}

const decorations = EditorView.decorations.compute([field], decorationsOf);

/** 편집기에 싣는 확장: 상태, 줄 표시, Esc. */
export function aiDraftReview(): Extension {
  return [
    field,
    decorations,
    Prec.highest(
      keymap.of([
        {
          key: 'Escape',
          run: (view) => {
            if (view.state.field(field).length > 0) view.dispatch({ effects: clearAll.of(null) });
            return false; // 다른 Esc 처리(완성 목록 닫기 등)도 돈다
          },
        },
      ]),
    ),
  ];
}

/** 지금 표시된 구간들(시험용, 위치 순). */
export function aiDraftRanges(state: EditorState): DraftRange[] {
  return state.field(field, false) ?? [];
}

/** 모든 검토 표시를 지운다. */
export function clearAiDraftReview(view: EditorView): void {
  if (aiDraftRanges(view.state).length > 0) view.dispatch({ effects: clearAll.of(null) });
}

/**
 * `before` 에서 지금 문서로 오며 새로 들어온 줄들을 검토 표시한다. 확장이 없는 편집기에서는 아무것도 하지 않는다.
 * `before` 는 `doc.toString()` 꼴(줄을 LF 로 이은 글)이다.
 */
export function markAiDraft(view: EditorView, before: string): void {
  if (view.state.field(field, false) === undefined) return;
  const ranges = insertedRanges(before, view.state.doc.toString());
  if (ranges.length > 0) view.dispatch({ effects: addRanges.of(ranges) });
}

/** 줄 단위 비교를 이만큼(옛 줄 수 × 새 줄 수)까지만 한다. 넘으면 바뀐 가운데 전체를 하나로 본다. */
const MAX_CELLS = 400_000;

/**
 * `after` 에 새로 들어온 줄 덩어리들의 위치(`after` 기준, 앞뒤 빈 줄은 뺀다). 앞뒤의 같은 줄을 떼고, 가운데는
 * 줄 단위 최장 공통 부분열로 맞춰 남은 새 줄을 모은다: 여러 절에 나눠 들어간 초안 사이의 연구원 글은 표시하지 않는다.
 */
export function insertedRanges(before: string, after: string): DraftRange[] {
  const a = before.split('\n');
  const b = after.split('\n');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const oldMid = a.slice(head, a.length - tail);
  const newMid = b.slice(head, b.length - tail);
  const inserted = new Array<boolean>(newMid.length).fill(true);
  if (oldMid.length > 0 && newMid.length > 0 && oldMid.length * newMid.length <= MAX_CELLS) {
    const n = oldMid.length;
    const m = newMid.length;
    // lcs[i][j]: oldMid[i..] 와 newMid[j..] 의 최장 공통 부분열 길이
    const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i][j] = oldMid[i] === newMid[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (oldMid[i] === newMid[j]) {
        inserted[j] = false;
        i++;
        j++;
      } else if (lcs[i + 1][j] >= lcs[i][j + 1]) i++;
      else j++;
    }
  }
  // 줄의 시작 위치
  const starts: number[] = [];
  let pos = 0;
  for (const line of b) {
    starts.push(pos);
    pos += line.length + 1;
  }
  const out: DraftRange[] = [];
  let k = 0;
  while (k < newMid.length) {
    if (!inserted[k]) {
      k++;
      continue;
    }
    let end = k;
    while (end + 1 < newMid.length && inserted[end + 1]) end++;
    let first = k;
    let last = end;
    while (first <= last && newMid[first].trim() === '') first++;
    while (last >= first && newMid[last].trim() === '') last--;
    if (first <= last) out.push({ from: starts[head + first], to: starts[head + last] + newMid[last].length });
    k = end + 1;
  }
  return out;
}
