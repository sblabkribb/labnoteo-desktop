import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';

/** 화면 가장자리에서 띄울 거리(px). */
const MARGIN = 8;
/** 기준 요소와의 틈(px). */
const GAP = 4;

/**
 * 기준 요소(단추) 위나 아래에 뜨는 작은 창(모양 고르기 등). 위치는 레이아웃 effect 에서 CSSOM(style.setProperty)으로 건다:
 * style 속성을 쓰지 않는다(CSP). 바깥을 누르면 닫히고(초점은 그대로), Esc 는 닫고 기준 요소로 초점을 돌려준다.
 * 열리면 안의 첫 초점 자리로 초점을 옮긴다.
 */
export function Popover(p: {
  anchor: HTMLElement;
  label: string;
  onClose: (opts: { restoreFocus: boolean }) => void;
  placement?: 'above' | 'below';
  className?: string;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const close = useRef(p.onClose);
  close.current = p.onClose;
  const placement = p.placement ?? 'below';
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const a = p.anchor.getBoundingClientRect();
    const b = el.getBoundingClientRect();
    const maxLeft = Math.max(MARGIN, window.innerWidth - b.width - MARGIN);
    const left = Math.min(Math.max(MARGIN, a.right - b.width), maxLeft);
    const above = a.top - GAP - b.height;
    const below = a.bottom + GAP;
    const fitsBelow = below + b.height <= window.innerHeight - MARGIN;
    const top = placement === 'above' ? (above >= MARGIN ? above : below) : fitsBelow ? below : Math.max(MARGIN, above);
    el.style.setProperty('left', `${Math.round(left)}px`);
    el.style.setProperty('top', `${Math.round(top)}px`);
    el.querySelector<HTMLElement>('[role="radio"][tabindex="0"], button:not(:disabled)')?.focus();
  }, [p.anchor, placement]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (target && (box.current?.contains(target) || p.anchor.contains(target))) return;
      close.current({ restoreFocus: false });
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [p.anchor]);
  return (
    <div
      ref={box}
      className={p.className ? `popover ${p.className}` : 'popover'}
      role="dialog"
      aria-label={p.label}
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || e.defaultPrevented) return;
        e.preventDefault();
        e.stopPropagation();
        close.current({ restoreFocus: true });
      }}
    >
      {p.children}
    </div>
  );
}
