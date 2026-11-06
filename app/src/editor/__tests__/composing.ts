import type { EditorView } from '@codemirror/view';

/** 한글 조합 중인 것처럼 꾸민다: view.composing / compositionStarted 는 inputState.composing 을 읽는다. */
export const setComposing = (v: EditorView, on: boolean) => {
  (v as unknown as { inputState: { composing: number } }).inputState.composing = on ? 1 : -1;
};
