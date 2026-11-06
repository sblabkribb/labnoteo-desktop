import { useSyncExternalStore } from 'react';
import type { NotifyKind } from '@labnoteo/core';

/**
 * 앱 LabnoteHost.notify 의 알림 저장소. Toaster 가 useSyncExternalStore 로 읽는다.
 * info 는 6초, warn·error 는 15초 뒤 저절로 사라진다. 한 번에 MAX_TOASTS 개까지 보이고, 넘치면 가장 오래된 것이 먼저 빠진다.
 * 시계는 저장소가 가진다: Toaster 가 아직 그려지지 않았어도 알림은 제때 사라진다.
 */
export interface Toast {
  readonly id: number;
  readonly kind: NotifyKind;
  readonly message: string;
}

export const MAX_TOASTS = 5;
export const TOAST_MS: Readonly<Record<NotifyKind, number>> = { info: 6000, warn: 15000, error: 15000 };

let toasts: readonly Toast[] = [];
let nextId = 1;
const timers = new Map<number, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();

const emit = () => listeners.forEach((l) => l());

function forget(id: number): void {
  const timer = timers.get(id);
  if (timer !== undefined) clearTimeout(timer);
  timers.delete(id);
}

/** 알림을 띄운다. */
export function notify(kind: NotifyKind, message: string): void {
  const id = nextId++;
  const next = [...toasts, { id, kind, message }];
  const dropped = next.slice(0, Math.max(0, next.length - MAX_TOASTS));
  dropped.forEach((x) => forget(x.id));
  toasts = next.slice(dropped.length);
  timers.set(
    id,
    setTimeout(() => dismissToast(id), TOAST_MS[kind]),
  );
  emit();
}

/** 알림 `id` 를 닫는다. 이미 없는 id 는 무시한다. */
export function dismissToast(id: number): void {
  forget(id);
  if (!toasts.some((x) => x.id === id)) return;
  toasts = toasts.filter((x) => x.id !== id);
  emit();
}

/** 모든 알림을 닫는다(보관함을 바꿀 때, 테스트 정리). */
export function clearToasts(): void {
  [...timers.keys()].forEach(forget);
  if (toasts.length === 0) return;
  toasts = [];
  emit();
}

export function currentToasts(): readonly Toast[] {
  return toasts;
}

export function subscribeToasts(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function useToasts(): readonly Toast[] {
  return useSyncExternalStore(subscribeToasts, currentToasts, currentToasts);
}
