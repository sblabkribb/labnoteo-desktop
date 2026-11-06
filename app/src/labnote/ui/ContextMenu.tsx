import { useEffect, useLayoutEffect, useRef, type FocusEvent, type KeyboardEvent } from 'react';
import { t } from '../../i18n/t';
import { useLang } from '../../i18n/useLang';
import { runCommand } from '../commands/runCommand';
import { closeMenu, useMenu, type MenuAction, type MenuAnchor, type MenuItem, type MenuState } from './menuStore';

/** 메뉴와 화면 가장자리 사이의 여백(px). */
const EDGE = 4;

function anchorPoint(anchor: MenuAnchor): { x: number; y: number } {
  if ('element' in anchor) {
    const r = anchor.element.getBoundingClientRect();
    return { x: r.left, y: r.bottom };
  }
  return anchor;
}

const clamp = (v: number, size: number, room: number) => Math.max(EDGE, Math.min(v, room - size - EDGE));

function labelOf(item: MenuAction): string {
  return item.labelKey !== undefined ? t(item.labelKey) : item.label;
}

function activate(menu: MenuState, item: MenuItem): void {
  if (item.separator || item.disabled) return;
  closeMenu({ restoreFocus: true });
  void runCommand(menu.ctx, item.run);
}

/**
 * 맥락 메뉴 층(menuStore 의 지금 메뉴). .shell 밖에 그린다. role=menu 에 menuitem 단추들.
 * - 위치는 레이아웃 effect 에서 CSSOM(style.setProperty)으로, 화면 안으로 붙인다. style 속성을 쓰지 않는다(CSP).
 * - 위아래 화살표(끝에서 돈다), Home/End, Enter·Space 로 실행, Escape 로 닫고 초점을 돌려준다.
 * - 바깥을 누르거나 초점이 메뉴를 떠나면 닫힌다.
 * 항목 이름은 그릴 때 번역하므로 언어를 바꾸면 열린 채로 바뀐다.
 */
export function ContextMenu() {
  useLang();
  const menu = useMenu();
  const ref = useRef<HTMLDivElement>(null);
  const enabled = () => [...(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') ?? [])];

  useLayoutEffect(() => {
    const el = ref.current;
    if (!menu || !el) return;
    const { x, y } = anchorPoint(menu.anchor);
    const box = el.getBoundingClientRect();
    el.style.setProperty('left', `${Math.round(clamp(x, box.width, window.innerWidth))}px`);
    el.style.setProperty('top', `${Math.round(clamp(y, box.height, window.innerHeight))}px`);
    (enabled()[0] ?? el).focus();
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) closeMenu();
    };
    const onWindowBlur = () => closeMenu();
    document.addEventListener('mousedown', onDown, true);
    window.addEventListener('blur', onWindowBlur);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('blur', onWindowBlur);
    };
  }, [menu]);

  if (!menu) return null;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const list = enabled();
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    const go = (i: number) => list[(i + list.length) % list.length]?.focus();
    switch (e.key) {
      case 'ArrowDown':
        go(at + 1);
        break;
      case 'ArrowUp':
        go(at < 0 ? -1 : at - 1);
        break;
      case 'Home':
        go(0);
        break;
      case 'End':
        go(-1);
        break;
      case 'Escape':
        closeMenu({ restoreFocus: true });
        break;
      case 'Enter':
      case ' ': {
        const i = at < 0 ? -1 : Number(list[at].dataset.index);
        if (i >= 0) activate(menu, menu.items[i]);
        break;
      }
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };
  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) closeMenu();
  };

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={t('menu.label')}
      tabIndex={-1}
      className="context-menu"
      onKeyDown={onKeyDown}
      onBlur={onBlur}
      // 키보드로 연 뒤 메뉴 키를 뗄 때 메뉴 위에 오는 사건: 브라우저 기본 메뉴를 띄우지 않는다
      onContextMenu={(e) => e.preventDefault()}
    >
      {menu.items.map((item, i) =>
        item.separator ? (
          <div key={i} role="separator" className="context-menu-separator" />
        ) : (
        <button
          key={i}
          type="button"
          role="menuitem"
          tabIndex={-1}
          data-index={i}
          className="context-menu-item"
          disabled={item.disabled}
          onClick={() => activate(menu, item)}
        >
          {labelOf(item)}
        </button>
        ),
      )}
    </div>
  );
}
