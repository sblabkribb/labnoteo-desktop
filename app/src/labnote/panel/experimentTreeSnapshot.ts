import type { ExpNode } from './experimentTree';

/**
 * 실험 탭이 지금 그린 실험 트리(UO 까지, 찾기로 거르기 전). 빠른 이동(Ctrl+O)이 보관함을 다시 읽지 않고 UO 를 바로 보이게 한다.
 * 실험 탭이 열려 있는 동안만 있다: 탭이 닫히면(보관함을 바꾸면 패널도 다시 만든다) 비운다. 낡은 보관함의 트리를 쓰지 않는다.
 */
let snapshot: readonly ExpNode[] | undefined;

export function publishExperimentTree(nodes: readonly ExpNode[] | undefined): void {
  snapshot = nodes;
}

export function latestExperimentTree(): readonly ExpNode[] | undefined {
  return snapshot;
}
