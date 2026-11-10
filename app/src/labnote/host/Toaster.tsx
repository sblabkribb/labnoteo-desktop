import { useLang } from '../../i18n/useLang';
import { t } from '../../i18n/t';
import { dismissToast, pauseToast, resumeToast, useToasts } from './toastStore';

/**
 * 알림 층. .shell 밖, 왼쪽 아래(상태 막대 위)에 그린다: 대화상자가 .shell 을 inert 로 막아도 알림은 읽히고 닫힌다.
 * info·success 는 role=status(조용히 읽힌다), warn·error 는 role=alert 이고 닫기 단추가 있다.
 * 왼쪽 띠(.toast-<kind>)가 종류를 보인다. 제목이 있으면 굵은 .toast-title 아래 .toast-detail 을 그린다.
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
            {quiet ? null : (
              <button type="button" className="toast-close" aria-label={t('toast.close')} onClick={() => dismissToast(toast.id)} />
            )}
          </div>
        );
      })}
    </section>
  );
}
