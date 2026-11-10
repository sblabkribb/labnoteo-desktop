import type { Extension } from '@codemirror/state';
import { Decoration, EditorView } from '@codemirror/view';
import { livePlugin, taskHandlers } from './inline';
import { frontGuard, propertiesField, rawFront } from './properties';
import { uoCards } from './uoCards';
import { dateChips } from './dateChip';
import { placeholders } from './placeholders';
import { emptyState } from './emptyState';

export { livePlugin, buildDecorations, taskHandlers } from './inline';
export { editYaml, frontBlock, frontGuard, propertiesField, rawFront } from './properties';
export { readmeEmptyState } from './emptyState';

/**
 * 라이브 미리보기(모드 칸에 들어간다). 숨긴 범위는 원자 범위라 세로 이동이나 누른 점이 그 안에 떨어지지 않는다.
 * 할 일 체크박스의 누름 처리기(taskHandlers)도 함께 든다.
 * 머리말은 속성 격자(propertiesField, 블록 위젯이라 StateField)로 보이고, 격자가 보이는 동안 frontGuard 가 입력을 본문으로 돌린다.
 * 실험 README 의 빈 워크플로 체크리스트에는 "첫 워크플로 추가" 카드(emptyState, readmeEmptyState 가 있을 때만)가 보인다.
 * 워크플로 노트의 UO 구역은 카드(uoCards), Meta 날짜는 고르개가 달린 칩(dateChips), 템플릿 자리 글은 흐리게(placeholders) 보인다.
 */
export function livePreview(): Extension {
  return [
    livePlugin,
    taskHandlers,
    EditorView.atomicRanges.of((v) => v.plugin(livePlugin)?.hidden ?? Decoration.none),
    rawFront,
    propertiesField,
    frontGuard,
    uoCards(),
    dateChips(),
    placeholders(),
    emptyState(),
  ];
}
