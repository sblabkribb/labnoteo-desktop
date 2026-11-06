import { useId, type KeyboardEvent, type ReactNode } from 'react';
import { t } from '../../i18n/t';

/** 한글 조합 중의 키(조합을 끝내는 Enter, 조합을 취소하는 Escape): 대화상자가 처리하지 않는다. */
export function isComposing(e: KeyboardEvent): boolean {
  return e.nativeEvent.isComposing || e.keyCode === 229;
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

/**
 * 모든 대화상자의 틀: 제목, 닫기 단추, Escape 로 취소, Tab 가두기(처음과 끝이 이어진다).
 * 대화상자 밖(.shell)은 DialogLayer 가 inert 로 막는다.
 */
export function DialogFrame(props: {
  role?: 'dialog' | 'alertdialog';
  title?: string;
  className?: string;
  describedBy?: string;
  onCancel: () => void;
  children: ReactNode;
}) {
  const titleId = useId();
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      if (isComposing(e)) return;
      e.preventDefault();
      e.stopPropagation();
      props.onCancel();
      return;
    }
    if (e.key !== 'Tab') return;
    const focusable = [...e.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !e.currentTarget.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !e.currentTarget.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  };
  return (
    <div
      role={props.role ?? 'dialog'}
      aria-modal="true"
      aria-labelledby={props.title ? titleId : undefined}
      aria-describedby={props.describedBy}
      className={props.className ? `dialog ${props.className}` : 'dialog'}
      onKeyDown={onKeyDown}
    >
      <div className="dialog-head">
        {props.title ? <h2 id={titleId}>{props.title}</h2> : <span />}
        <button type="button" className="dialog-close" aria-label={t('dialog.close')} onClick={props.onCancel} />
      </div>
      {props.children}
    </div>
  );
}
