import { minimalReplacement, type EditTarget } from '@labnoteo/core';
import { isolateHistory } from '@codemirror/commands';
import { Transaction, type EditorState, type TransactionSpec } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { NoteBusyError, NoteChangedError } from './noteErrors';

export { NoteChangedError } from './noteErrors';

/** 묶음 안에서 명령이 받는 편집 대상. 바깥 대상과 같은 메서드를 갖지만 사본에만 쓴다. */
export type BatchTarget = EditTarget;

export interface AppEditTarget extends EditTarget {
  /** `fn` 을 본문의 사본에 대고 돌린 뒤, 바뀐 만큼을 한 번에(되돌리기 한 번) 적용한다. */
  batch<R>(fn: (t: BatchTarget) => Promise<R>): Promise<R>;
}

/** 명령이 만든 편집: 되돌리기 한 번, 사용자 입력과 구별되는 userEvent. */
const COMMAND_EDIT = () => [isolateHistory.of('full'), Transaction.userEvent.of('input.labnote')];

/**
 * 명령이 넣는 글의 줄바꿈을 문서의 줄 구분자로 바꾼다.
 * - 구분자가 CRLF 면(섞인 파일의 CRLF 쪽) LF 와 CRLF 를 모두 CRLF 로: CodeMirror 는 CRLF 에서만 줄을 나눈다.
 * - 구분자가 LF 면 CRLF 를 LF 로. 다만 본문에 CR 이 들어 있는 문서(LF 가 많은 섞인 파일)는 손대지 않는다:
 *   그 CR 은 원래 줄 끝이고, 바뀐 구간 안의 줄이 줄 끝을 잃지 않게 한다.
 * 어느 경우든 글의 길이(CodeMirror 단위)는 LF 로 이은 글과 같다.
 */
export function toDocBreaks(text: string, state: EditorState): string {
  if (state.lineBreak === '\r\n') return text.replace(/\r?\n/g, '\r\n');
  if (!text.includes('\r')) return text;
  return state.doc.toString().includes('\r') ? text : text.replace(/\r\n/g, '\n');
}

/** `[start, end)` 를 `len` 글자로 바꾼 뒤의 위치. 바뀐 구간 안의 위치는 새 글의 끝으로 간다. */
function mapPos(p: number, start: number, end: number, len: number): number {
  if (p <= start) return p;
  if (p >= end) return p + len - (end - start);
  return start + len;
}

function checkRange(text: string, start: number, end: number): void {
  if (!(start >= 0 && start <= end && end <= text.length)) {
    throw new RangeError(`range [${start}, ${end}) is outside the note (length ${text.length})`);
  }
}

/**
 * 열린 CodeMirror 뷰 위의 `EditTarget`. 오프셋은 `state.doc.toString()`(줄을 LF 로 이은 글) 기준이고,
 * 그것은 CRLF·섞인 파일에서도 CodeMirror 위치와 1:1 이다. 편집 한 번은 트랜잭션 한 번, 되돌리기 한 번이다.
 * 모든 메서드는 부를 때 `isBusy()` 면 `NoteBusyError` 로 거부한다.
 */
export function editTargetFor(view: EditorView, path: string, isBusy: () => boolean): AppEditTarget {
  const check = () => {
    if (isBusy()) throw new NoteBusyError(path);
  };
  const dispatch = (spec: TransactionSpec) => view.dispatch({ ...spec, annotations: COMMAND_EDIT() });

  return {
    path,
    async getText() {
      check();
      return view.state.doc.toString();
    },
    async replaceRange(start, end, text) {
      check();
      const state = view.state;
      checkRange(state.doc.toString(), start, end);
      const m = minimalReplacement(state.doc.sliceString(start, end), text);
      if (!m) return;
      dispatch({ changes: { from: start + m.start, to: start + m.end, insert: toDocBreaks(m.text, state) } });
    },
    async insertAtCursor(text) {
      check();
      const state = view.state;
      const { from, to } = state.selection.main;
      const changes = state.changes({ from, to, insert: toDocBreaks(text, state) });
      dispatch({ changes, selection: { anchor: changes.mapPos(to, 1) }, scrollIntoView: true });
    },
    async getCursorOffset() {
      check();
      return view.state.selection.main.from;
    },
    async getSelectionRange() {
      check();
      const { from, to } = view.state.selection.main;
      return from === to ? undefined : { start: from, end: to };
    },
    async revealOffset(offset) {
      check();
      const at = Math.max(0, Math.min(offset, view.state.doc.length));
      view.dispatch({ selection: { anchor: at }, scrollIntoView: true });
      view.focus();
    },
    async batch(fn) {
      check();
      const original = view.state.doc.toString();
      let scratch = original;
      let { anchor, head } = view.state.selection.main;
      let reveal: number | undefined;
      const edit = (start: number, end: number, text: string) => {
        scratch = scratch.slice(0, start) + text + scratch.slice(end);
        anchor = mapPos(anchor, start, end, text.length);
        head = mapPos(head, start, end, text.length);
      };
      const scratchTarget: BatchTarget = {
        path,
        getText: async () => scratch,
        async replaceRange(start, end, text) {
          checkRange(scratch, start, end);
          const m = minimalReplacement(scratch.slice(start, end), text);
          if (m) edit(start + m.start, start + m.end, m.text);
        },
        async insertAtCursor(text) {
          const from = Math.min(anchor, head);
          const to = Math.max(anchor, head);
          edit(from, to, text);
          anchor = head = from + text.length;
        },
        getCursorOffset: async () => Math.min(anchor, head),
        async getSelectionRange() {
          return anchor === head ? undefined : { start: Math.min(anchor, head), end: Math.max(anchor, head) };
        },
        async revealOffset(offset) {
          reveal = offset;
        },
      };

      const result = await fn(scratchTarget); // fn 이 던지면 아무것도 적용하지 않는다
      check();
      if (view.state.doc.toString() !== original) throw new NoteChangedError(path);
      const m = minimalReplacement(original, scratch);
      if (!m && reveal === undefined) return result;
      const state = view.state;
      const changes = m ? state.changes({ from: m.start, to: m.end, insert: toDocBreaks(m.text, state) }) : undefined;
      const len = changes ? changes.newLength : state.doc.length;
      const clamp = (p: number) => Math.max(0, Math.min(p, len));
      const selection = reveal === undefined ? { anchor: clamp(anchor), head: clamp(head) } : { anchor: clamp(reveal) };
      const spec: TransactionSpec = { selection, scrollIntoView: reveal !== undefined };
      if (changes) dispatch({ ...spec, changes });
      else view.dispatch(spec);
      if (reveal !== undefined) view.focus();
      return result;
    },
  };
}
