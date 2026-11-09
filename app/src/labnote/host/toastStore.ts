import { useSyncExternalStore } from 'react';
import type { NotifyKind } from '@labnoteo/core';

/**
 * 앱 LabnoteHost.notify 의 알림 저장소. Toaster 가 useSyncExternalStore 로 읽는다.
 * info 는 6초, warn·error 는 15초 뒤 저절로 사라진다. 한 번에 MAX_TOASTS 개까지 보이고, 넘치면 가장 오래된 것이 먼저 빠진다.
 * 시계는 저장소가 가진다: Toaster 가 아직 그려지지 않았어도 알림은 제때 사라진다.
 * 알림은 단추 하나(`action`)를 가질 수 있고, 상태 알림(notifyStatus)은 시계 없이 닫을 때까지 남는다(SP7 B8).
 * 어느 알림도 초점을 가져가지 않는다.
 */
export interface ToastAction {
  label: string;
  run: () => void;
}

export interface Toast {
  readonly id: number;
  readonly kind: NotifyKind;
  readonly message: string;
  /** 알림 안의 단추: 누르면 알림을 닫고 `run` 을 부른다. */
  readonly action?: ToastAction;
  /** 상태 알림: 시계가 없고 부른 쪽이 닫는다. */
  readonly sticky?: boolean;
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

/** 알림을 줄 끝에 넣는다. 넘치면 가장 오래된 것이 빠진다. */
function push(toast: Toast): void {
  const next = [...toasts, toast];
  const dropped = next.slice(0, Math.max(0, next.length - MAX_TOASTS));
  dropped.forEach((x) => forget(x.id));
  toasts = next.slice(dropped.length);
}

/** 알림을 띄운다. `action` 은 알림 안의 단추, `ms` 는 기본 시간(TOAST_MS) 대신 사라질 때까지의 시간. */
export function notify(kind: NotifyKind, message: string, opts: { action?: ToastAction; ms?: number } = {}): void {
  const id = nextId++;
  push(opts.action ? { id, kind, message, action: opts.action } : { id, kind, message });
  timers.set(
    id,
    setTimeout(() => dismissToast(id), opts.ms ?? TOAST_MS[kind]),
  );
  emit();
}

/**
 * 닫을 때까지 남는 info 상태 알림(배경 스캔의 "스캔을 처리하는 중…"). `update` 는 글을 바꾸고 `close` 는 닫는다.
 * 이미 닫혔거나 넘쳐서 빠진 알림에는 둘 다 아무것도 하지 않는다.
 */
export function notifyStatus(message: string): { update(message: string): void; close(): void } {
  const id = nextId++;
  push({ id, kind: 'info', message, sticky: true });
  emit();
  return {
    update(text: string) {
      if (!toasts.some((x) => x.id === id)) return;
      toasts = toasts.map((x) => (x.id === id ? { ...x, message: text } : x));
      emit();
    },
    close() {
      dismissToast(id);
    },
  };
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
