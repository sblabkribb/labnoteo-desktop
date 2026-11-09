import { useEffect, useRef } from 'react';
import { t } from '../i18n/t';
import { DialogFrame } from '../labnote/host/DialogFrame';
import type { DialogSpec } from '../labnote/host/dialogStore';
import { cancelProgress, useProgress } from './progressStore';

/**
 * 진행 창(SP6 Task 12): 제목과 진행 줄. 취소할 수 있는 창이면 취소 단추가 있다.
 * 취소 단추, 닫기 단추, Escape 는 신호를 끊고 창을 닫는다. Escape 는 한글 조합 중에는 무시한다(DialogFrame).
 */
export function ProgressDialog(props: { spec: Extract<DialogSpec, { kind: 'progress' }>; onCancel: () => void }) {
  const { id } = props.spec;
  const state = useProgress(id);
  const list = useRef<HTMLUListElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const cancel = () => {
    cancelProgress(id);
    props.onCancel();
  };

  useEffect(() => cancelButton.current?.focus(), []);
  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state?.lines]);

  if (!state) return null;
  return (
    <DialogFrame title={state.title || t('integrations.working')} className="progress" onCancel={cancel}>
      <ul ref={list} className="progress-lines" aria-live="polite">
        {state.lines.map((line, i) => (
          <li key={i} className="progress-line">
            {line}
          </li>
        ))}
      </ul>
      {state.cancellable && (
        <div className="dialog-actions">
          <button ref={cancelButton} type="button" onClick={cancel}>
            {t('integrations.cancel')}
          </button>
        </div>
      )}
    </DialogFrame>
  );
}
