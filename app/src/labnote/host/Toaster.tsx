import { useLang } from '../../i18n/useLang';
import { t } from '../../i18n/t';
import { dismissToast, useToasts } from './toastStore';

/**
 * 알림 층. .shell 밖에 그린다: 대화상자가 .shell 을 inert 로 막아도 알림은 읽히고 닫힌다.
 * info 는 role=status(조용히 읽힌다), warn·error 는 role=alert 이고 닫기 단추가 있다.
 * 단추가 있는 알림(`action`)은 .toast-action 단추를 그린다: 누르면 알림을 닫고 그 일을 한다. 알림은 초점을 옮기지 않는다.
 */
export function Toaster() {
  useLang();
  const toasts = useToasts();
  return (
    <section className="toaster" aria-label={t('toast.region')}>
      {toasts.map((toast) => (
        <div key={toast.id} role={toast.kind === 'info' ? 'status' : 'alert'} className={`toast ${toast.kind}`}>
          {toast.message ? <p className="toast-message">{toast.message}</p> : null}
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
          {toast.kind === 'info' ? null : (
            <button type="button" className="toast-close" aria-label={t('toast.close')} onClick={() => dismissToast(toast.id)} />
          )}
        </div>
      ))}
    </section>
  );
}
