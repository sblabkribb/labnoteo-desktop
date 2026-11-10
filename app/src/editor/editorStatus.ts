/**
 * 열린 편집기의 상태 줄 정보: 커서 줄·열, 단어 수, 저장 상태, 그리고 본문(보기 머리와 상태 줄이 구조 위치를 읽는다).
 * 편집기가 내고(publish) 상태 줄·보기 머리가 구독한다. 본문과 단어 수는 편집이 잠잠해진 뒤(개요와 같은 간격)에만 낸다.
 */
import { useSyncExternalStore } from 'react';

export type SaveState = 'loading' | 'saved' | 'dirty' | 'saving' | 'error' | 'conflict';

export interface EditorStatus {
  path: string;
  /** 1부터. */
  line: number;
  /** 1부터(줄 첫 글자 앞이 1). */
  col: number;
  words: number;
  text: string;
  save: SaveState;
}

let current: EditorStatus | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** `path` 의 편집기가 바뀐 칸만 낸다. 다른 노트의 상태였으면 새로 시작한다. 같은 값이면 알리지 않는다. */
export function publishEditorStatus(path: string, patch: Partial<Omit<EditorStatus, 'path'>>): void {
  const base: EditorStatus =
    current?.path === path ? current : { path, line: 1, col: 1, words: 0, text: '', save: 'loading' };
  const next = { ...base, ...patch };
  if (current === next || (current && (Object.keys(next) as (keyof EditorStatus)[]).every((k) => current![k] === next[k]))) return;
  current = next;
  emit();
}

/** 그 노트의 편집기가 내려가면 비운다(다른 노트가 이미 냈으면 두다). */
export function clearEditorStatus(path: string): void {
  if (current?.path !== path) return;
  current = null;
  emit();
}

export function editorStatus(): EditorStatus | null {
  return current;
}

export function subscribeEditorStatus(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** `path` 의 상태(다른 노트의 것이면 null). */
export function useEditorStatus(path: string | undefined): EditorStatus | null {
  const s = useSyncExternalStore(subscribeEditorStatus, editorStatus, editorStatus);
  return s && s.path === path ? s : null;
}

/** `path` 의 본문만(커서가 움직여도 다시 그리지 않는다). 아직 내지 않았으면 ''. */
export function useEditorText(path: string | undefined): string {
  const get = () => (current && current.path === path ? current.text : '');
  return useSyncExternalStore(subscribeEditorStatus, get, get);
}

/** `path` 의 편집기가 본문을 낸 적이 있다(다 읽었다). */
export function useEditorLoaded(path: string | undefined): boolean {
  const get = () => current !== null && current.path === path && current.save !== 'loading';
  return useSyncExternalStore(subscribeEditorStatus, get, get);
}

/** 단어 수: 머리말(--- … ---)을 빼고 글자나 숫자를 품은 덩어리를 센다. */
export function countWords(text: string): number {
  const body = text.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
  let n = 0;
  for (const w of body.split(/\s+/)) if (/[\p{L}\p{N}]/u.test(w)) n++;
  return n;
}
