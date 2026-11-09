import type { KeyboardEvent, ReactNode } from 'react';
import { t } from '../i18n/t';
import { useLang } from '../i18n/useLang';
import { Icon, type IconName } from './Icon';
import { RIGHT_RANGE, layoutStore, useLayout, type RightTab } from './layoutStore';
import { Resizer } from './Resizer';

/** 오른쪽 사이드바의 두 탭: 순서, 아이콘, 이름 키. id 는 탭 단추의 `sidebar-tab-<id>` 와 패널의 `sidebar-panel-<id>` 에 쓴다. */
export const RIGHT_TABS: readonly { id: RightTab; icon: IconName; labelKey: string }[] = [
  { id: 'outline', icon: 'list-tree', labelKey: 'sidebar.outline' },
  { id: 'links', icon: 'link', labelKey: 'sidebar.tab.links' },
];

interface Props {
  /** 개요 패널(OutlinePanel). 고른 탭의 패널만 그린다. */
  outline: ReactNode;
  /** 링크 패널(LinksPanel). */
  links: ReactNode;
}

/**
 * 오른쪽 사이드바(개요 / 링크): 처음에는 닫혀 있고, 열림·너비·탭은 layoutStore(Rust 의 ui.json)가 기억한다.
 * 리본 단추, Ctrl+Shift+\(App 의 처리기), 팔레트 명령이 연다. 왼쪽 가장자리의 손잡이로 너비(220–480)를 바꾸고, 140px 아래로
 * 끌면 닫는다. 너비는 layoutStore 가 <html> 에 CSSOM 변수(--right-w)로 건다: 여기에는 style 이 없다(CSP).
 */
export function RightDock({ outline, links }: Props) {
  useLang();
  const layout = useLayout();
  if (!layout.rightOpen) return null;
  const tab = layout.rightTab;
  const current = RIGHT_TABS.find((x) => x.id === tab) ?? RIGHT_TABS[0];
  const show = (next: RightTab) => layoutStore.update({ rightTab: next, rightOpen: true });
  // WAI-ARIA 탭 패턴: 고른 탭만 Tab 순서에 있으니 ←/→·Home·End 로 탭을 옮기고 초점도 함께 옮긴다.
  const onTabKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const order = RIGHT_TABS.map((x) => x.id);
    const at = order.indexOf(tab);
    const next =
      e.key === 'ArrowRight' ? order[(at + 1) % order.length]
      : e.key === 'ArrowLeft' ? order[(at - 1 + order.length) % order.length]
      : e.key === 'Home' ? order[0]
      : e.key === 'End' ? order[order.length - 1]
      : undefined;
    if (!next) return;
    e.preventDefault();
    show(next);
    document.getElementById(`sidebar-tab-${next}`)?.focus();
  };
  return (
    <aside id="right-dock" className="sidebar right-dock" aria-label={t('right.label')}>
      <div className="dock-tabs" role="tablist" aria-label={t('right.tabs')} onKeyDown={onTabKeyDown}>
        {RIGHT_TABS.map((x) => {
          const label = t(x.labelKey);
          return (
            <button
              key={x.id}
              type="button"
              role="tab"
              id={`sidebar-tab-${x.id}`}
              aria-controls={`sidebar-panel-${x.id}`}
              aria-selected={tab === x.id}
              aria-label={label}
              title={label}
              tabIndex={tab === x.id ? 0 : -1}
              className="ibtn dock-tab"
              onClick={() => show(x.id)}
            >
              <Icon name={x.icon} size={18} />
            </button>
          );
        })}
      </div>
      <h2 className="right-dock-head">
        <Icon name={current.icon} size={16} />
        <span>{t(current.labelKey)}</span>
      </h2>
      <div
        role="tabpanel"
        id={`sidebar-panel-${current.id}`}
        className="sidebar-panel"
        aria-labelledby={`sidebar-tab-${current.id}`}
      >
        {current.id === 'outline' ? outline : links}
      </div>
      <Resizer
        side="right"
        label={t('right.resize')}
        min={RIGHT_RANGE.min}
        max={RIGHT_RANGE.max}
        defaultValue={RIGHT_RANGE.default}
        value={layout.rightWidth}
        onChange={(w) => layoutStore.update({ rightWidth: w })}
        onCollapse={() => layoutStore.update({ rightOpen: false })}
      />
    </aside>
  );
}
