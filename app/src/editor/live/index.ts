import type { Extension } from '@codemirror/state';
import { Decoration, EditorView } from '@codemirror/view';
import { livePlugin, taskHandlers } from './inline';
import { frontGuard, propertiesField, rawFront } from './properties';

export { livePlugin, buildDecorations, taskHandlers } from './inline';
export { editYaml, frontBlock, frontGuard, propertiesField, rawFront } from './properties';

/**
 * 라이브 미리보기(모드 칸에 들어간다). 숨긴 범위는 원자 범위라 세로 이동이나 누른 점이 그 안에 떨어지지 않는다.
 * 할 일 체크박스의 누름 처리기(taskHandlers)도 함께 든다.
 * 머리말은 속성 격자(propertiesField, 블록 위젯이라 StateField)로 보이고, 격자가 보이는 동안 frontGuard 가 입력을 본문으로 돌린다.
 */
export function livePreview(): Extension {
  return [
    livePlugin,
    taskHandlers,
    EditorView.atomicRanges.of((v) => v.plugin(livePlugin)?.hidden ?? Decoration.none),
    rawFront,
    propertiesField,
    frontGuard,
  ];
}
