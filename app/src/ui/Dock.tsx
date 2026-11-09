import type { KeyboardEvent, ReactNode } from 'react';
import { t } from '../i18n/t';
import { useLang } from '../i18n/useLang';
import { Icon, type IconName } from './Icon';
import { LEFT_RANGE, layoutStore, useLayout, type LeftTab } from './layoutStore';
import { Resizer } from './Resizer';

/** 독의 세 탭: 순서, 아이콘, 이름 키. id 는 탭 단추의 `sidebar-tab-<id>` 와 패널의 `sidebar-panel-<id>` 에 쓴다. */
export const DOCK_TABS: readonly { id: LeftTab; icon: IconName; labelKey: string }[] = [
  { id: 'files', icon: 'folder', labelKey: 'sidebar.tab.files' },
  { id: 'experiments', icon: 'flask-conical', labelKey: 'sidebar.tab.workflows' },
  { id: 'samples', icon: 'test-tube', labelKey: 'sidebar.tab.samples' },
];

interface Props {
  tab: LeftTab;
  onTab(tab: LeftTab): void;
  /** 탭 패널들(role=tabpanel, id=sidebar-panel-<tab>). 부르는 쪽이 고른 탭만 보이게 한다. */
  children: ReactNode;
  /** 맨 아래 줄(보관함 줄). */
  footer: ReactNode;
}

/**
 * 왼쪽 독: 세 아이콘 탭(파일 / 실험 / 샘플), 탭 패널, 보관함 줄, 오른쪽 가장자리의 너비 손잡이.
 * 너비와 숨김은 layoutStore 가 <html> 에 건다(--side-w, data-left-hidden). 좁은 창(820px 아래)에서는 CSS 가 독을 본문 위에
 * 띄우고 뒤에 깔개(scrim)를 깐다: 깔개를 누르면 독을 숨긴다.
 */
export function Dock({ tab, onTab, children, footer }: Props) {
  useLang();
  const layout = useLayout();
  // WAI-ARIA 탭 패턴: 고른 탭만 Tab 순서에 있으니 ←/→·Home·End 로 탭을 옮기고 초점도 함께 옮긴다.
  const onTabKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Alt/Ctrl/Meta+화살표는 앱의 것이다(Alt+←/→ 는 뒤로·앞으로)
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const order = DOCK_TABS.map((x) => x.id);
    const at = order.indexOf(tab);
    const next =
      e.key === 'ArrowRight' ? order[(at + 1) % order.length]
      : e.key === 'ArrowLeft' ? order[(at - 1 + order.length) % order.length]
      : e.key === 'Home' ? order[0]
      : e.key === 'End' ? order[order.length - 1]
      : undefined;
    if (!next) return;
    e.preventDefault();
    onTab(next);
    document.getElementById(`sidebar-tab-${next}`)?.focus();
  };
  return (
    <>
      <div className="dock-scrim" aria-hidden="true" onClick={() => layoutStore.update({ leftHidden: true })} />
      <aside id="dock" className="sidebar dock" aria-label={t('app.sidebar')}>
        <div className="dock-tabs" role="tablist" aria-label={t('sidebar.tabs')} onKeyDown={onTabKeyDown}>
          {DOCK_TABS.map((x) => {
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
                onClick={() => onTab(x.id)}
              >
                <Icon name={x.icon} size={18} />
              </button>
            );
          })}
        </div>
        <div className="dock-panels">{children}</div>
        {footer}
        <Resizer
          side="left"
          label={t('dock.resize')}
          min={LEFT_RANGE.min}
          max={LEFT_RANGE.max}
          defaultValue={LEFT_RANGE.default}
          value={layout.leftWidth}
          onChange={(w) => layoutStore.update({ leftWidth: w })}
          onCollapse={() => layoutStore.update({ leftHidden: true })}
        />
      </aside>
    </>
  );
}
