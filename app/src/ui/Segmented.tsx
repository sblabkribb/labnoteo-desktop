import { useRef, type KeyboardEvent } from 'react';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

/**
 * 세 가지 이하의 선택(테마 등): role=radiogroup 의 단추 줄. 고른 것만 Tab 으로 닿고(roving tabindex), ←/→ 와 Home/End 가
 * 고르며 초점을 옮긴다(라디오 묶음의 키).
 */
export function Segmented<T extends string>(p: {
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange: (value: T) => void;
  label: string;
}) {
  const group = useRef<HTMLDivElement>(null);
  const move = (e: KeyboardEvent<HTMLDivElement>) => {
    const at = p.options.findIndex((o) => o.value === p.value);
    const n = p.options.length;
    const to =
      e.key === 'ArrowRight' || e.key === 'ArrowDown' ? (at + 1) % n
      : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? (at - 1 + n) % n
      : e.key === 'Home' ? 0
      : e.key === 'End' ? n - 1
      : -1;
    if (to < 0) return;
    e.preventDefault();
    p.onChange(p.options[to].value);
    group.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[to]?.focus();
  };
  return (
    <div ref={group} className="segmented" role="radiogroup" aria-label={p.label} onKeyDown={move}>
      {p.options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === p.value}
          tabIndex={o.value === p.value ? 0 : -1}
          onClick={() => p.onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
