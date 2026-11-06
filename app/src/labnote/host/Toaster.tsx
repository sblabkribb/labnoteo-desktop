import { useLang } from '../../i18n/useLang';
import { t } from '../../i18n/t';
import { dismissToast, useToasts } from './toastStore';

/**
 * 알림 층. .shell 밖에 그린다: 대화상자가 .shell 을 inert 로 막아도 알림은 읽히고 닫힌다.
 * info 는 role=status(조용히 읽힌다), warn·error 는 role=alert 이고 닫기 단추가 있다.
 */
export function Toaster() {
  useLang();
  const toasts = useToasts();
  return (
    <section className="toaster" aria-label={t('toast.region')}>
      {toasts.map((toast) => (
        <div key={toast.id} role={toast.kind === 'info' ? 'status' : 'alert'} className={`toast ${toast.kind}`}>
          <p className="toast-message">{toast.message}</p>
          {toast.kind === 'info' ? null : (
            <button type="button" className="toast-close" aria-label={t('toast.close')} onClick={() => dismissToast(toast.id)} />
          )}
        </div>
      ))}
    </section>
  );
}
