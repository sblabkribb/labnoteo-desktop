import type { Extension } from '@codemirror/state';
import { Decoration, EditorView } from '@codemirror/view';
import { livePlugin } from './inline';

export { livePlugin, buildDecorations } from './inline';

/** 라이브 미리보기(모드 칸에 들어간다). 숨긴 범위는 원자 범위라 세로 이동이나 누른 점이 그 안에 떨어지지 않는다. */
export function livePreview(): Extension {
  return [livePlugin, EditorView.atomicRanges.of((v) => v.plugin(livePlugin)?.hidden ?? Decoration.none)];
}
