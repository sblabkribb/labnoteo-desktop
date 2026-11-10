import { useLang } from '../../i18n/useLang';
import { t } from '../../i18n/t';
import { Icon, type IconName } from '../../ui/Icon';
import { dismissToast, pauseToast, resumeToast, useToasts, type Toast } from './toastStore';

/** 종류마다 상태 아이콘(명세 §5.4): 띠의 색과 함께 모양으로도 종류를 보인다. */
const KIND_ICON: Record<Toast['kind'], IconName> = {
  info: 'info',
  success: 'circle-check',
  warn: 'triangle-alert',
  error: 'circle-x',
};

/**
 * 알림 층. .shell 밖, 왼쪽 아래(상태 막대 위)에 그린다: 대화상자가 .shell 을 inert 로 막아도 알림은 읽히고 닫힌다.
 * info·success 는 role=status(조용히 읽힌다), warn·error 는 role=alert 다. 모든 알림에 닫기 단추(×)가 있다(명세 §5.4).
 * 왼쪽 띠(.toast-<kind>)와 상태 아이콘이 종류를 보인다. 제목이 있으면 굵은 .toast-title 아래 .toast-detail 을 그린다.
 * 단추가 있는 알림(`action`)은 .toast-action 단추를 그린다: 누르면 알림을 닫고 그 일을 한다.
 * 마우스가 올라가 있는 동안은 시계가 멈춘다. 알림은 초점을 옮기지 않는다.
 */
export function Toaster() {
  useLang();
  const toasts = useToasts();
  return (
    <section className="toaster toaster-bottom-left" aria-label={t('toast.region')}>
      {toasts.map((toast) => {
        const quiet = toast.kind === 'info' || toast.kind === 'success';
        const detail = toast.title ? (toast.detail ?? toast.message) : toast.message;
        return (
          <div
            key={toast.id}
            role={quiet ? 'status' : 'alert'}
            className={`toast toast-${toast.kind}`}
            onMouseEnter={() => pauseToast(toast.id)}
            onMouseLeave={() => resumeToast(toast.id)}
          >
            <Icon name={KIND_ICON[toast.kind]} className="toast-icon" />
            {toast.title || detail ? (
              <div className="toast-body">
                {toast.title ? <p className="toast-title">{toast.title}</p> : null}
                {detail ? <p className={toast.title ? 'toast-detail' : 'toast-message'}>{detail}</p> : null}
              </div>
            ) : null}
            {toast.action ? (
              <button
                type="button"
                className="toast-action"
                onClick={() => {
                  const { run } = toast.action!;
                  dismissToast(toast.id);
                  run();
                }}
              >
                {toast.action.label}
              </button>
            ) : null}
            <button type="button" className="toast-close" aria-label={t('toast.close')} title={t('toast.close')} onClick={() => dismissToast(toast.id)}>
              <Icon name="x" size={14} />
            </button>
          </div>
        );
      })}
    </section>
  );
}
