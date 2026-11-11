import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { UNSOLICITED_ARM_MS } from './whenNotComposing';
import { t } from '../../i18n/t';
import { Icon } from '../../ui/Icon';
import { focusableIn } from '../../ui/focusable';

/** 한글 조합 중의 키(조합을 끝내는 Enter, 조합을 취소하는 Escape): 대화상자가 처리하지 않는다. */
export function isComposing(e: KeyboardEvent): boolean {
  return e.nativeEvent.isComposing || e.keyCode === 229;
}

/**
 * 모든 대화상자의 틀: 제목, 닫기 단추, Escape 로 취소, Tab 가두기(처음과 끝이 이어진다; 숨은 페이지는 건너뛴다).
 * 대화상자 밖(.shell, #pet-layer)은 DialogLayer 가 inert 로 막는다.
 * 이름: `title` 이 있으면 제목이, 없으면 `label`(aria-label)이, 그것도 없으면 `describedBy` 의 글이 이름이 된다.
 * 셋 다 없으면 개발 빌드에서 경고한다.
 */
export function DialogFrame(props: {
  role?: 'dialog' | 'alertdialog';
  title?: string;
  /** 제목이 없을 때의 이름(aria-label). */
  label?: string;
  className?: string;
  describedBy?: string;
  onCancel: () => void;
  /** 닫기 단추(×). 없으면 onCancel. 별칭 단계는 Esc 가 뒤로 가도 ×는 닫는다. */
  onClose?: () => void;
  /** 닫기 단추(×)를 끈다: 지금은 닫을 수 없는 창(잠긴 진행 창). 꺼진 단추는 Tab 으로 가지 않는다. */
  closeDisabled?: boolean;
  /** 사용자가 부르지 않은 질문(A9): 열린 뒤 UNSOLICITED_ARM_MS 동안 Enter 와 Space 를 무시한다(Escape 는 닫는다). */
  unsolicited?: boolean;
  children: ReactNode;
}) {
  const titleId = useId();
  const unnamed = !props.title && !props.label && !props.describedBy;
  useEffect(() => {
    if (import.meta.env.DEV && unnamed) console.warn('DialogFrame: dialog has no accessible name (title, label or describedBy)');
  }, [unnamed]);
  // 처음 그릴 때의 값으로 정한다: 열린 뒤에 바뀌지 않는다.
  const armed = useRef(!!props.unsolicited);
  useEffect(() => {
    if (!armed.current) return;
    const timer = setTimeout(() => {
      armed.current = false;
    }, UNSOLICITED_ARM_MS);
    return () => clearTimeout(timer);
  }, []);
  // 캡처 단계에서 막는다: 단추의 기본 동작(누르기)도, 안쪽 요소의 처리기(고르기의 Enter)도 받지 못한다.
  // 초점이 본문으로 빠졌을 때(누른 단추가 바로 disabled 가 되면 브라우저가 초점을 <body> 로 옮긴다, Task 22 실앱 점검):
  // 맨 위 대화상자가 Escape 와 Tab 을 대신 받아, 키보드만 쓰는 사람이 갇히지 않게 한다.
  const root = useRef<HTMLDivElement>(null);
  const cancel = useRef(props.onCancel);
  cancel.current = props.onCancel;
  useEffect(() => {
    const onDocKey = (e: globalThis.KeyboardEvent) => {
      const el = root.current;
      const active = document.activeElement;
      if (!el || (active && active !== document.body)) return;
      const frames = document.querySelectorAll('.dialog[aria-modal="true"]');
      if (frames[frames.length - 1] !== el) return;
      if (e.key === 'Escape') {
        if (e.isComposing || e.keyCode === 229) return;
        e.preventDefault();
        cancel.current();
      } else if (e.key === 'Tab') {
        const focusable = focusableIn(el);
        if (focusable.length === 0) return;
        e.preventDefault();
        (e.shiftKey ? focusable[focusable.length - 1] : focusable[0]).focus();
      }
    };
    document.addEventListener('keydown', onDocKey);
    return () => document.removeEventListener('keydown', onDocKey);
  }, []);
  const swallowArmed = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!armed.current || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    e.stopPropagation();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      if (isComposing(e)) return;
      e.preventDefault();
      e.stopPropagation();
      props.onCancel();
      return;
    }
    if (e.key !== 'Tab') return;
    const focusable = focusableIn(e.currentTarget);
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
      ref={root}
      role={props.role ?? 'dialog'}
      aria-modal="true"
      aria-label={props.title ? undefined : props.label}
      aria-labelledby={props.title ? titleId : props.label ? undefined : props.describedBy}
      aria-describedby={props.describedBy}
      className={props.className ? `dialog ${props.className}` : 'dialog'}
      onKeyDown={onKeyDown}
      onKeyDownCapture={swallowArmed}
      onKeyUpCapture={swallowArmed}
    >
      <div className="dialog-head">
        {props.title ? <h2 id={titleId}>{props.title}</h2> : <span />}
        <button type="button" className="dialog-close" aria-label={t('dialog.close')} title={t('dialog.close')} disabled={props.closeDisabled} onClick={props.onClose ?? props.onCancel}>
          <Icon name="x" size={16} />
        </button>
      </div>
      {props.children}
    </div>
  );
}
