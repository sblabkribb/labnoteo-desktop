import { useRef, type KeyboardEvent, type PointerEvent } from 'react';

/** 화살표 한 번에 움직이는 폭(px). */
export const KEY_STEP = 16;
/** 끌어서 이 폭(px) 아래로 줄이면 사이드바를 숨긴다. */
export const COLLAPSE_BELOW = 140;

export interface ResizerProps {
  /** 손잡이가 붙은 사이드바: 'left' 는 오른쪽 가장자리(오른쪽으로 끌면 넓어진다), 'right' 는 왼쪽 가장자리. */
  side: 'left' | 'right';
  /** 접근성 이름(번역된 글). */
  label: string;
  min: number;
  max: number;
  /** Home 이나 두 번 누르기가 돌아가는 폭. */
  defaultValue: number;
  value: number;
  /** 끄는 동안과 키를 누를 때마다: 범위 안으로 자른 새 폭. */
  onChange(width: number): void;
  /** 끌기가 끝났다(마지막 폭). 키로 바꾼 것은 onChange 만 부른다. */
  onCommit?(width: number): void;
  /** COLLAPSE_BELOW 아래로 끌고 놓았다: 사이드바를 숨긴다. 폭은 바꾸지 않는다. */
  onCollapse(): void;
}

/**
 * 사이드바 가장자리의 6px 손잡이(role=separator). 포인터를 잡아(pointer capture) 끌고, ←/→ 로 KEY_STEP 씩, Home 이나 두 번
 * 누르기로 기본 폭에 돌아간다. 폭을 DOM 에 거는 일은 부르는 쪽(layoutStore 의 CSSOM 변수)이 한다: 여기에는 style 이 없다(CSP).
 * 끄는 동안 <html data-resizing> 을 걸어 셸의 너비 전환(transition)을 끈다.
 */
export function Resizer(p: ResizerProps) {
  const drag = useRef<{ x: number; start: number; last: number; collapse: boolean; id: number } | null>(null);
  const clamp = (w: number) => Math.min(p.max, Math.max(p.min, Math.round(w)));

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    drag.current = { x: e.clientX, start: p.value, last: p.value, collapse: false, id: e.pointerId };
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } catch {
      // 잡지 못해도(테스트, 이미 놓은 포인터) 같은 요소의 사건으로 끈다
    }
    document.documentElement.setAttribute('data-resizing', 'true');
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const raw = d.start + (p.side === 'left' ? dx : -dx);
    d.collapse = raw < COLLAPSE_BELOW;
    if (d.collapse) return;
    const next = clamp(raw);
    if (next === d.last) return;
    d.last = next;
    p.onChange(next);
  };
  const end = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    document.documentElement.removeAttribute('data-resizing');
    try {
      if (e.currentTarget.hasPointerCapture?.(d.id)) e.currentTarget.releasePointerCapture(d.id);
    } catch {
      // 이미 풀렸다
    }
    if (d.collapse) p.onCollapse();
    else p.onCommit?.(d.last);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const grow = p.side === 'left' ? 'ArrowRight' : 'ArrowLeft';
    const shrink = p.side === 'left' ? 'ArrowLeft' : 'ArrowRight';
    let next: number | undefined;
    if (e.key === grow) next = p.value + KEY_STEP;
    else if (e.key === shrink) next = p.value - KEY_STEP;
    else if (e.key === 'Home') next = p.defaultValue;
    if (next === undefined || e.altKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    p.onChange(clamp(next));
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={p.label}
      aria-valuenow={p.value}
      aria-valuemin={p.min}
      aria-valuemax={p.max}
      tabIndex={0}
      className={`resizer resizer-${p.side}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={onKeyDown}
      onDoubleClick={() => p.onChange(clamp(p.defaultValue))}
    />
  );
}
