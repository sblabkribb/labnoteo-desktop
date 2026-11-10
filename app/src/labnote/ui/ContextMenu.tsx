import { Fragment, useEffect, useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react';
import { t } from '../../i18n/t';
import { useLang } from '../../i18n/useLang';
import { Icon } from '../../ui/Icon';
import { runCommand } from '../commands/runCommand';
import { closeMenu, useMenu, type MenuAction, type MenuAnchor, type MenuItem, type MenuState } from './menuStore';

/** 메뉴와 화면 가장자리 사이의 여백(px). */
const EDGE = 4;
/** 마우스를 올린 하위 메뉴가 열리기(또는 다른 항목으로 옮겨 닫히기)까지(ms). */
const HOVER_MS = 150;
/** 이만큼 안에 친 글자는 이어서 찾는다(ms). */
const TYPEAHEAD_MS = 500;

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
  if (item.separator || item.disabled || item.submenu) return;
  closeMenu({ restoreFocus: true });
  void runCommand(menu.ctx, item.run);
}

const enabledIn = (panel: HTMLElement | null) => [
  ...(panel?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? []),
];

/** 열린 하위 메뉴: 어느 메뉴(id)의 몇째 항목인지, 열면서 그 안으로 초점을 옮기는지(키보드). */
interface OpenSub {
  id: number;
  index: number;
  focus: boolean;
}

/**
 * 맥락 메뉴 층(menuStore 의 지금 메뉴). .shell 밖에 그린다. role=menu 에 menuitem 단추들.
 * - 위치는 레이아웃 effect 에서 CSSOM(style.setProperty)으로, 화면 안으로 붙인다. style 속성을 쓰지 않는다(CSP).
 * - 위아래 화살표(끝에서 돈다), Home/End, Enter·Space 로 실행, Escape 로 닫고 초점을 돌려준다. 글자를 치면 그 글자로
 *   시작하는 다음 항목으로 간다(type-ahead).
 * - 하위 메뉴(한 단계): 마우스를 올리고 150ms 뒤, 또는 ArrowRight·Enter 로 연다. ArrowLeft·Escape 는 하위 메뉴만 닫고
 *   부모 항목으로 돌아간다. 오른쪽에 자리가 없으면 왼쪽으로 연다.
 * - 꺼진 항목은 aria-disabled 이고 까닭을 툴팁으로 보인다. 키보드 이동은 건너뛴다.
 * - 바깥을 누르거나 초점이 메뉴 층을 떠나면 닫힌다.
 * 항목 이름은 그릴 때 번역하므로 언어를 바꾸면 열린 채로 바뀐다.
 */
export function ContextMenu() {
  useLang();
  const menu = useMenu();
  const layerRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const subRef = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const typed = useRef({ text: '', at: 0 });
  const [openSub, setOpenSub] = useState<OpenSub | null>(null);
  const sub = menu && openSub?.id === menu.id ? openSub : null;
  const subItems = menu && sub ? menu.items[sub.index]?.submenu : undefined;

  const clearTimer = () => {
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = undefined;
  };

  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!menu || !el) return;
    const { x, y } = anchorPoint(menu.anchor);
    const box = el.getBoundingClientRect();
    el.style.setProperty('left', `${Math.round(clamp(x, box.width, window.innerWidth))}px`);
    el.style.setProperty('top', `${Math.round(clamp(y, box.height, window.innerHeight))}px`);
    // 포인터로 열면 메뉴 자체에 초점(항목은 마우스가 가리킨다), 키보드로 열면 첫 항목에. 어느 쪽이든 화살표로 시작한다.
    (menu.pointer ? el : (enabledIn(el)[0] ?? el)).focus();
  }, [menu]);

  // 하위 메뉴: 부모 항목 오른쪽에, 자리가 없으면 부모 메뉴 왼쪽에. 위아래는 화면 안으로.
  useLayoutEffect(() => {
    const el = subRef.current;
    const root = rootRef.current;
    if (!sub || !el || !root) return;
    const parent = root.querySelector<HTMLElement>(`[data-index="${sub.index}"]`);
    if (!parent) return;
    const pr = parent.getBoundingClientRect();
    const rr = root.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    let x = pr.right + 2;
    if (x + box.width > window.innerWidth - EDGE) x = rr.left - box.width + 2;
    el.style.setProperty('left', `${Math.round(Math.max(EDGE, x))}px`);
    el.style.setProperty('top', `${Math.round(clamp(pr.top - EDGE, box.height, window.innerHeight))}px`);
    if (sub.focus) enabledIn(el)[0]?.focus();
  }, [sub]);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (!layerRef.current?.contains(e.target as Node)) closeMenu();
    };
    const onWindowBlur = () => closeMenu();
    document.addEventListener('mousedown', onDown, true);
    window.addEventListener('blur', onWindowBlur);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('blur', onWindowBlur);
      clearTimer();
    };
  }, [menu]);

  if (!menu) return null;

  const showSub = (index: number, focus: boolean) => {
    clearTimer();
    setOpenSub({ id: menu.id, index, focus });
  };
  const hideSub = (refocus: boolean) => {
    clearTimer();
    const index = sub?.index;
    setOpenSub(null);
    if (refocus && index !== undefined) rootRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.focus();
  };

  /** 글자로 찾기: 지금 항목 다음부터(이어 친 글자면 지금 항목부터) 이름이 그 글로 시작하는 항목. */
  const typeAhead = (key: string, list: HTMLButtonElement[], at: number, items: readonly MenuItem[]) => {
    const now = Date.now();
    const cont = now - typed.current.at < TYPEAHEAD_MS;
    const text = (cont ? typed.current.text : '') + key.toLowerCase();
    typed.current = { text, at: now };
    const start = cont && text.length > 1 ? Math.max(at, 0) : at + 1;
    for (let k = 0; k < list.length; k++) {
      const el = list[(start + k) % list.length];
      const item = items[Number(el.dataset.index)];
      if (item && !item.separator && labelOf(item).toLowerCase().startsWith(text)) {
        el.focus();
        return;
      }
    }
  };

  const onKeyDown = (level: 0 | 1) => (e: KeyboardEvent<HTMLDivElement>) => {
    const items = level === 0 ? menu.items : (subItems ?? []);
    const list = enabledIn(e.currentTarget);
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    const go = (i: number) => list[(i + list.length) % list.length]?.focus();
    const index = at < 0 ? -1 : Number(list[at].dataset.index);
    const item = index >= 0 ? items[index] : undefined;
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
      case 'ArrowRight':
        if (level === 0 && item?.submenu) showSub(index, true);
        break;
      case 'ArrowLeft':
        if (level === 1) hideSub(true);
        break;
      case 'Escape':
        if (level === 1) hideSub(true);
        else closeMenu({ restoreFocus: true });
        break;
      case 'Enter':
      case ' ':
        if (item?.submenu && level === 0) showSub(index, true);
        else if (item) activate(menu, item);
        break;
      default:
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          typeAhead(e.key, list, at, items);
          break;
        }
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };
  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) closeMenu();
  };

  /** 루트 항목에 마우스를 올림: 하위 메뉴 부모면 잠시 뒤 열고, 아니면 열린 하위 메뉴를 잠시 뒤 닫는다. */
  const onEnterRoot = (index: number, item: MenuAction) => {
    clearTimer();
    if (item.submenu && !item.disabled) {
      if (sub?.index !== index) timer.current = setTimeout(() => setOpenSub({ id: menu.id, index, focus: false }), HOVER_MS);
    } else if (sub) {
      timer.current = setTimeout(() => setOpenSub(null), HOVER_MS);
    }
  };

  const renderItems = (items: readonly MenuItem[], level: 0 | 1) =>
    items.map((item, i) =>
      item.separator ? (
        <div key={i} role="separator" className="context-menu-separator" />
      ) : (
        <Fragment key={i}>
          {item.section !== undefined && (
            <div role="presentation" className="context-menu-section">
              {t(item.section)}
            </div>
          )}
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            data-index={i}
            className={item.danger ? 'context-menu-item context-menu-danger' : 'context-menu-item'}
            aria-disabled={item.disabled ? true : undefined}
            title={item.disabled && item.disabledReason ? t(item.disabledReason) : undefined}
            aria-haspopup={item.submenu ? 'menu' : undefined}
            aria-expanded={item.submenu ? sub?.index === i : undefined}
            onClick={() => {
              if (item.disabled) return;
              if (item.submenu) showSub(i, false);
              else activate(menu, item);
            }}
            onMouseEnter={level === 0 ? () => onEnterRoot(i, item) : undefined}
          >
            <span className="context-menu-icon" aria-hidden="true">
              {item.icon && <Icon name={item.icon} size={14} />}
            </span>
            <span className="context-menu-label">{labelOf(item)}</span>
            {item.shortcut && <kbd className="context-menu-shortcut">{item.shortcut}</kbd>}
            {item.submenu && <Icon name="chevron-right" size={14} className="context-menu-chevron" />}
          </button>
        </Fragment>
      ),
    );

  const parentItem = sub ? menu.items[sub.index] : undefined;
  return (
    // 키보드로 연 뒤 메뉴 키를 뗄 때 메뉴 위에 오는 사건: 브라우저 기본 메뉴를 띄우지 않는다
    <div ref={layerRef} className="context-menu-layer" onBlur={onBlur} onContextMenu={(e) => e.preventDefault()}>
      <div ref={rootRef} role="menu" aria-label={t('menu.label')} tabIndex={-1} className="context-menu" onKeyDown={onKeyDown(0)}>
        {renderItems(menu.items, 0)}
      </div>
      {subItems && parentItem && !parentItem.separator && (
        <div
          ref={subRef}
          role="menu"
          aria-label={labelOf(parentItem)}
          tabIndex={-1}
          className="context-menu context-submenu"
          onKeyDown={onKeyDown(1)}
          onMouseEnter={clearTimer}
        >
          {renderItems(subItems, 1)}
        </div>
      )}
    </div>
  );
}
