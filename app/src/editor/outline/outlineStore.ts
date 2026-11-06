import { useSyncExternalStore } from 'react';
import type { OutlineItem } from './extract';

/**
 * 열린 노트의 개요와 커서 줄. 편집기(Editor.tsx)가 내보내고 개요 패널이 구독한다. 편집기는 한 번에 하나라
 * 저장소도 노트 하나만 담는다. 내려가는 편집기는 자기 노트일 때만 지운다(clearOutline).
 */
export interface OutlineState {
  path: string;
  items: OutlineItem[];
  /** 1부터 센 커서 줄. */
  cursorLine: number;
}

let state: OutlineState | undefined;
const listeners = new Set<() => void>();

function set(next: OutlineState | undefined): void {
  state = next;
  for (const l of [...listeners]) l();
}

export function getOutline(): OutlineState | undefined {
  return state;
}

/** 노트의 제목 목록을 바꾼다. 같은 노트면 커서 줄은 그대로 둔다. */
export function publishOutline(path: string, items: OutlineItem[]): void {
  set({ path, items, cursorLine: state?.path === path ? state.cursorLine : 1 });
}

/** 커서 줄(1부터)을 바꾼다. 같은 줄이면 아무도 깨우지 않는다. */
export function publishCursor(path: string, cursorLine: number): void {
  if (state?.path === path) {
    if (state.cursorLine !== cursorLine) set({ ...state, cursorLine });
    return;
  }
  set({ path, items: [], cursorLine });
}

/** 그 노트의 개요를 지운다. 이미 다른 노트의 개요면 두고. */
export function clearOutline(path: string): void {
  if (state?.path === path) set(undefined);
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

export function useOutline(): OutlineState | undefined {
  return useSyncExternalStore(subscribe, getOutline, getOutline);
}
