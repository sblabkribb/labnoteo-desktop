import type { ReactNode } from 'react';
import { t } from '../i18n/t';
import { useLang } from '../i18n/useLang';
import { Icon } from './Icon';

/**
 * 본문 위의 보기 머리(36px): 왼쪽에 뒤로·앞으로와 경로 표시(lead), 오른쪽에 단추들(actions). 열린 노트가 없어도 그린다.
 */
export function ViewHeader(p: { lead?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="view-header">
      <div className="view-header-lead">{p.lead}</div>
      <div className="view-header-actions">{p.actions}</div>
    </div>
  );
}

/** 뒤로·앞으로(Alt+←/→ 와 같다). 갈 곳이 없으면 꺼진다. */
export function NavButtons(p: { canBack: boolean; canForward: boolean; onBack: () => void; onForward: () => void }) {
  useLang();
  return (
    <span className="view-nav">
      <button
        type="button"
        className="ibtn"
        aria-label={t('header.back')}
        title={t('ribbon.withKey', t('header.back'), 'Alt+←')}
        aria-keyshortcuts="Alt+ArrowLeft"
        data-command-id="app.back"
        disabled={!p.canBack}
        onClick={p.onBack}
      >
        <Icon name="arrow-left" />
      </button>
      <button
        type="button"
        className="ibtn"
        aria-label={t('header.forward')}
        title={t('ribbon.withKey', t('header.forward'), 'Alt+→')}
        aria-keyshortcuts="Alt+ArrowRight"
        data-command-id="app.forward"
        disabled={!p.canForward}
        onClick={p.onForward}
      >
        <Icon name="arrow-right" />
      </button>
    </span>
  );
}
