import { useSyncExternalStore } from 'react';
import type { CommandContext } from '../commands/context';
import { deepActiveElement } from '../host/dialogStore';

/** 실행하는 메뉴 항목. 여는 쪽이 메뉴를 열 때 만든다. 이름은 그릴 때 번역한다(labelKey), 또는 이미 만든 글(label). */
export type MenuAction = (
  | { labelKey: string; label?: undefined }
  | { label: string; labelKey?: undefined }
) & {
  /** runCommand 로 감싸 돈다: 거부는 알림이 된다. */
  run: () => Promise<unknown>;
  disabled?: boolean;
  separator?: undefined;
};

/** 항목 무리를 나누는 구분선(role=separator). 키보드 이동은 건너뛴다. */
export interface MenuSeparator {
  separator: true;
  label?: undefined;
  labelKey?: undefined;
  run?: undefined;
  disabled?: undefined;
}

export type MenuItem = MenuAction | MenuSeparator;

export const MENU_SEPARATOR: MenuSeparator = { separator: true };

/** 메뉴를 열 자리: 포인터 좌표(우클릭), 또는 요소(단추) 바로 아래. */
export type MenuAnchor = { x: number; y: number } | { element: Element };

export interface MenuState {
  readonly id: number;
  readonly ctx: CommandContext;
  readonly anchor: MenuAnchor;
  readonly items: readonly MenuItem[];
}

let current: MenuState | null = null;
let returnFocus: HTMLElement | null = null;
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/**
 * 맥락 메뉴를 연다(한 번에 하나: 열려 있던 것은 닫힌다). 연 순간 초점이 있던 요소(없으면 기준 요소)를 적어 두었다가
 * Escape 나 항목 실행으로 닫힐 때 그리로 초점을 돌려준다.
 */
export function openMenu(ctx: CommandContext, anchor: MenuAnchor, items: readonly MenuItem[]): void {
  const active = deepActiveElement();
  const inMenu = active?.closest('.context-menu');
  if (!current || !inMenu) {
    returnFocus = active ?? ('element' in anchor && anchor.element instanceof HTMLElement ? anchor.element : null);
  }
  current = { id: nextId++, ctx, anchor, items };
  emit();
}

/** 메뉴를 닫는다. `restoreFocus` 면 열기 전 초점 자리로 돌아간다(바깥 클릭과 초점 잃음은 돌려주지 않는다). */
export function closeMenu(opts: { restoreFocus?: boolean } = {}): void {
  if (!current) return;
  current = null;
  const el = returnFocus;
  returnFocus = null;
  emit();
  if (opts.restoreFocus && el?.isConnected) el.focus();
}

export function currentMenu(): MenuState | null {
  return current;
}

export function subscribeMenu(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function useMenu(): MenuState | null {
  return useSyncExternalStore(subscribeMenu, currentMenu, currentMenu);
}
