import { useEffect, useId, useRef } from 'react';
import { t } from '../../i18n/t';
import { DialogFrame } from './DialogFrame';
import type { DialogSpec } from './dialogStore';

/**
 * 예/아니오 확인. 빈 줄로 나뉜 문단은 따로 된 <p> 로 그린다(글자 그대로: HTML 로 읽지 않는다).
 * `destructive` 면 취소 단추에 초점이 가서 Enter 가 취소한다(경고를 읽기 전에 지우지 않게). 확인 단추는 위험색이다.
 * `unsolicited`(A9)도 취소에 초점을 두고, 처음 UNSOLICITED_ARM_MS 동안 Enter 와 Space 를 무시한다(DialogFrame).
 */
export function ConfirmDialog(props: {
  spec: Extract<DialogSpec, { kind: 'confirm' }>;
  onDone: (value: unknown) => void;
  onCancel: () => void;
}) {
  const { spec } = props;
  const id = useId();
  const confirm = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);

  // 사용자가 부르지 않은 질문(A9)도 위험한 확인처럼 취소에 초점을 둔다(위험색은 칠하지 않는다).
  const cancelFirst = spec.destructive || spec.unsolicited;
  useEffect(() => (cancelFirst ? cancel : confirm).current?.focus(), [cancelFirst]);

  return (
    <DialogFrame
      role="alertdialog"
      className="confirm"
      label={t('dialog.confirmLabel')}
      describedBy={`${id}-message`}
      onCancel={props.onCancel}
      unsolicited={spec.unsolicited}
    >
      <div id={`${id}-message`} className="confirm-message">
        {spec.message.split(/\n\n+/).map((paragraph, i) => (
          <p key={i}>{paragraph}</p>
        ))}
      </div>
      <div className="dialog-actions">
        <button ref={cancel} type="button" onClick={() => props.onDone(false)}>
          {t('dialog.cancel')}
        </button>
        <button ref={confirm} type="button" className={spec.destructive ? 'danger' : 'primary'} onClick={() => props.onDone(true)}>
          {spec.confirmLabel ?? t('dialog.ok')}
        </button>
      </div>
    </DialogFrame>
  );
}
