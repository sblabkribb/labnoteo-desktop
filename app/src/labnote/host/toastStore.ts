import { useSyncExternalStore } from 'react';
import type { NotifyKind } from '@labnoteo/core';

/**
 * 앱 LabnoteHost.notify 의 알림 저장소. Toaster 가 useSyncExternalStore 로 읽는다.
 * info·success 는 4초 뒤 저절로 사라지고, 마우스가 올라가 있는 동안은 시계가 멈춘다(남은 시간은 그대로 이어진다).
 * warn·error 는 닫을 때까지 남는다(옛 `ms` 를 넘겨도). 한 번에 MAX_TOASTS 개까지 보이고, 넘치면 가장 오래된
 * info·success 알림이 먼저 빠진다. 그런 알림이 없으면 가장 오래된 것이 빠진다.
 * 시계는 저장소가 가진다: Toaster 가 아직 그려지지 않았어도 알림은 제때 사라진다.
 * 알림은 제목(`title`)과 자세한 글(`detail`, 없으면 `message`), 단추 하나(`action`)를 가질 수 있다.
 * 상태 알림(notifyStatus)은 시계 없이 닫을 때까지 남는다(SP7 B8). 어느 알림도 초점을 가져가지 않는다.
 */
export interface ToastAction {
  label: string;
  run: () => void;
}

/** 코어의 NotifyKind 에 success 를 더한다. 띠 색이 종류를 따른다. */
export type ToastKind = NotifyKind | 'success';

export interface NotifyOpts {
  /** info·success 가 사라질 때까지의 시간(기본 TOAST_MS). warn·error 에는 쓰지 않는다. */
  ms?: number;
  /** 굵은 첫 줄. 있으면 `message` 는 `detail` 이 없을 때의 자세한 글이 된다. */
  title?: string;
  detail?: string;
  action?: ToastAction;
}

export interface Toast {
  readonly id: number;
  readonly kind: ToastKind;
  readonly message: string;
  readonly title?: string;
  readonly detail?: string;
  /** 알림 안의 단추: 누르면 알림을 닫고 `run` 을 부른다. */
  readonly action?: ToastAction;
  /** 닫을 때까지 남는다: warn·error 와 상태 알림. */
  readonly sticky?: boolean;
  /** 상태 알림(notifyStatus): 부른 쪽이 글을 바꾸고 닫는다. */
  readonly status?: boolean;
}

export const MAX_TOASTS = 3;
export const TOAST_MS: Readonly<Record<'info' | 'success', number>> = { info: 4000, success: 4000 };

let toasts: readonly Toast[] = [];
let nextId = 1;
/** 시계가 도는 알림: 타이머, 끝나는 때(Date.now 기준), 멈췄을 때 남은 시간. */
const timers = new Map<number, ReturnType<typeof setTimeout>>();
const deadlines = new Map<number, number>();
const paused = new Map<number, number>();
const listeners = new Set<() => void>();

const emit = () => listeners.forEach((l) => l());

function forget(id: number): void {
  const timer = timers.get(id);
  if (timer !== undefined) clearTimeout(timer);
  timers.delete(id);
  deadlines.delete(id);
  paused.delete(id);
}

function arm(id: number, ms: number): void {
  timers.set(
    id,
    setTimeout(() => dismissToast(id), ms),
  );
  deadlines.set(id, Date.now() + ms);
}

const isQuiet = (x: Toast) => x.kind === 'info' || x.kind === 'success';

/** 넘칠 때 뺄 알림: 시계가 도는 info·success, 그다음 상태 알림, 그다음 가장 오래된 것. */
function victim(list: readonly Toast[]): Toast {
  return list.find((x) => isQuiet(x) && !x.sticky) ?? list.find(isQuiet) ?? list[0];
}

/** 알림을 줄 끝에 넣는다. 넘치면 victim 이 빠진다. */
function push(toast: Toast): void {
  let next = [...toasts, toast];
  while (next.length > MAX_TOASTS) {
    const out = victim(next.slice(0, -1));
    forget(out.id);
    next = next.filter((x) => x !== out);
  }
  toasts = next;
}

/**
 * 알림을 띄운다. 예전의 `(kind, message, { ms, action })` 부름도 그대로 된다.
 * `title` 이 있으면 굵은 첫 줄로, `detail ?? message` 를 그 아래 글로 보인다.
 */
export function notify(kind: ToastKind, message: string, opts: NotifyOpts = {}): void {
  const id = nextId++;
  const sticky = !isQuiet({ kind } as Toast);
  push({
    id,
    kind,
    message,
    ...(opts.title ? { title: opts.title } : {}),
    ...(opts.detail ? { detail: opts.detail } : {}),
    ...(opts.action ? { action: opts.action } : {}),
    ...(sticky ? { sticky } : {}),
  });
  if (!sticky && toasts.some((x) => x.id === id)) arm(id, opts.ms ?? TOAST_MS[kind as 'info' | 'success']);
  emit();
}

/** 마우스가 알림 위에 있는 동안 시계를 멈춘다. 시계가 없는 알림에는 아무것도 하지 않는다. */
export function pauseToast(id: number): void {
  const deadline = deadlines.get(id);
  if (deadline === undefined || paused.has(id)) return;
  clearTimeout(timers.get(id));
  timers.delete(id);
  paused.set(id, Math.max(0, deadline - Date.now()));
}

/** 멈춘 시계를 남은 시간으로 다시 돌린다. */
export function resumeToast(id: number): void {
  const left = paused.get(id);
  if (left === undefined) return;
  paused.delete(id);
  arm(id, left);
}

/**
 * 닫을 때까지 남는 info 상태 알림(배경 스캔의 "스캔을 처리하는 중…"). `update` 는 글을 바꾸고 `close` 는 닫는다.
 * 이미 닫혔거나 넘쳐서 빠진 알림에는 둘 다 아무것도 하지 않는다.
 */
export function notifyStatus(message: string): { update(message: string): void; close(): void } {
  const id = nextId++;
  push({ id, kind: 'info', message, sticky: true, status: true });
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
  [...new Set([...timers.keys(), ...deadlines.keys(), ...paused.keys()])].forEach(forget);
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
