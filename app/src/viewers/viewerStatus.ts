/**
 * 보기 화면(그림, 표)의 상태 줄 칸: 그림은 크기·바이트·배율, 표는 행×열·인코딩·구분자. 보기 화면이 내고(publish)
 * 상태 줄이 구독한다(편집기의 editorStatus 와 같은 모양).
 */
import { useSyncExternalStore } from 'react';

export interface ViewerStatus {
  path: string;
  items: readonly string[];
}

let current: ViewerStatus | null = null;
const listeners = new Set<() => void>();

/** `path` 의 칸을 바꾼다. 같은 값이면 알리지 않는다. */
export function publishViewerStatus(path: string, items: readonly string[]): void {
  if (current?.path === path && current.items.length === items.length && current.items.every((x, i) => x === items[i])) return;
  current = { path, items };
  listeners.forEach((l) => l());
}

/** 그 보기 화면이 내려가면 비운다(다른 파일이 이미 냈으면 둔다). */
export function clearViewerStatus(path: string): void {
  if (current?.path !== path) return;
  current = null;
  listeners.forEach((l) => l());
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

const snapshot = () => current;

/** `path` 의 칸(다른 파일의 것이면 빈 목록). */
export function useViewerStatus(path: string | undefined): readonly string[] {
  const s = useSyncExternalStore(subscribe, snapshot, snapshot);
  return s && s.path === path ? s.items : [];
}

/** 바이트 수를 사람이 읽는 글로: 2048 -> "2 KB". */
export function formatBytes(n: number, t: (key: string, ...args: (string | number)[]) => string): string {
  if (n < 1024) return t('viewer.bytes', n);
  if (n < 1024 * 1024) return t('viewer.kb', Number((n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)));
  return t('viewer.mb', Number((n / (1024 * 1024)).toFixed(1)));
}
