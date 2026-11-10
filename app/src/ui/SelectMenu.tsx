import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Icon } from './Icon';

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  /** 고를 것의 언어(언어 목록에서 화면 읽기가 그 언어로 읽게). */
  lang?: string;
}

/**
 * 네이티브 <select> 를 대신하는 고르기 메뉴: `button[aria-haspopup=listbox]` 와 그 아래 `role=listbox/option`.
 * ↑/↓ 로 옮기고 Enter·Space 로 고르며 Esc 로 닫는다(단추로 초점이 돌아온다). 글자를 치면 그 글자로 시작하는 것으로 간다.
 */
export function SelectMenu<T extends string>(p: {
  value: T;
  options: readonly SelectOption<T>[];
  onChange: (value: T) => void;
  label: string;
  /** 바깥 틀에 더할 클래스(배치용). */
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const id = useId();
  const current = p.options.find((o) => o.value === p.value);
  const show = () => {
    setActive(Math.max(0, p.options.findIndex((o) => o.value === p.value)));
    setOpen(true);
  };
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };
  const choose = (i: number) => {
    const o = p.options[i];
    if (o) p.onChange(o.value);
    close(true);
  };
  useEffect(() => {
    if (!open) return;
    list.current?.focus();
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [open]);
  const typeAhead = (key: string) => {
    const k = key.toLowerCase();
    const next = p.options.findIndex((o, i) => i > active && o.label.toLowerCase().startsWith(k));
    const at = next >= 0 ? next : p.options.findIndex((o) => o.label.toLowerCase().startsWith(k));
    if (at >= 0) setActive(at);
  };
  const onListKey = (e: KeyboardEvent<HTMLUListElement>) => {
    const n = p.options.length;
    if (e.key === 'Tab') {
      setOpen(false);
      return;
    }
    if (e.key === 'ArrowDown') setActive((a) => (a + 1) % n);
    else if (e.key === 'ArrowUp') setActive((a) => (a - 1 + n) % n);
    else if (e.key === 'Home') setActive(0);
    else if (e.key === 'End') setActive(n - 1);
    else if (e.key === 'Enter' || e.key === ' ') choose(active);
    else if (e.key === 'Escape') close(true);
    else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) typeAhead(e.key);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  return (
    <div ref={wrap} className={p.className ? `select-menu ${p.className}` : 'select-menu'}>
      <button
        ref={button}
        type="button"
        className="btn select-menu-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${id}-list` : undefined}
        aria-label={`${p.label}: ${current?.label ?? p.value}`}
        onClick={() => (open ? close(false) : show())}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
          e.preventDefault();
          show();
        }}
      >
        <span lang={current?.lang}>{current?.label ?? p.value}</span>
        <Icon name="chevrons-up-down" size={14} />
      </button>
      {open && (
        <ul
          ref={list}
          id={`${id}-list`}
          className="select-menu-list"
          role="listbox"
          aria-label={p.label}
          tabIndex={-1}
          aria-activedescendant={`${id}-${active}`}
          onKeyDown={onListKey}
        >
          {p.options.map((o, i) => (
            <li
              key={o.value}
              id={`${id}-${i}`}
              role="option"
              lang={o.lang}
              aria-selected={o.value === p.value}
              data-active={i === active || undefined}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(i)}
            >
              <span>{o.label}</span>
              {o.value === p.value && <Icon name="check" size={14} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
