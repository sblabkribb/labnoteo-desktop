import { useEffect, useId, useRef } from 'react';
import { DialogFrame } from './DialogFrame';
import type { DialogSpec } from './dialogStore';

/**
 * 단추가 셋 이상인 확인(AppHost.choose). ConfirmDialog 와 같은 꼴: 제목, 빈 줄로 나뉜 문단(글자 그대로), 단추 줄.
 * 첫 단추가 주 단추이고 초점을 받는다. Escape 와 닫기 단추는 취소(undefined)다.
 */
export function ChoiceDialog(props: {
  spec: Extract<DialogSpec, { kind: 'choice' }>;
  onDone: (value: unknown) => void;
  onCancel: () => void;
}) {
  const { spec } = props;
  const id = useId();
  const first = useRef<HTMLButtonElement>(null);

  useEffect(() => first.current?.focus(), []);

  return (
    <DialogFrame role="alertdialog" title={spec.title} className="confirm" describedBy={`${id}-message`} onCancel={props.onCancel}>
      <div id={`${id}-message`} className="confirm-message">
        {spec.message.split(/\n\n+/).map((paragraph, i) => (
          <p key={i}>{paragraph}</p>
        ))}
      </div>
      <div className="dialog-actions">
        {spec.choices.map((c, i) => (
          <button
            key={i}
            ref={i === 0 ? first : undefined}
            type="button"
            className={i === 0 ? 'primary' : undefined}
            onClick={() => props.onDone(c.value)}
          >
            {c.label}
          </button>
        ))}
      </div>
    </DialogFrame>
  );
}
