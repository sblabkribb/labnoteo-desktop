import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { t } from '../../i18n/t';
import { DialogFrame, isComposing } from './DialogFrame';
import type { DialogSpec } from './dialogStore';

/**
 * 한 줄 입력. `validate`(동기 또는 비동기)의 메시지는 보이고 제출을 막는다. 검사가 도는 동안 다시 제출하지 않는다.
 * `hint` 는 입력이 바뀔 때마다 다시 계산하고, `warn` 이면 경고색(.warn)이다. 한글 조합을 끝내는 Enter 는 제출하지 않는다.
 */
export function PromptDialog(props: {
  spec: Extract<DialogSpec, { kind: 'prompt' }>;
  onDone: (value: unknown) => void;
  onCancel: () => void;
}) {
  const { opts } = props.spec;
  const [value, setValue] = useState(opts.value ?? '');
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const hint = opts.hint?.(value);

  useEffect(() => input.current?.focus(), []);

  const submit = async () => {
    if (busy.current) return;
    const submitted = value;
    if (opts.validate) {
      busy.current = true;
      let message: string | null | undefined;
      try {
        message = await opts.validate(submitted);
      } finally {
        busy.current = false;
      }
      if (message) {
        setError(message);
        return;
      }
    }
    props.onDone(submitted);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || isComposing(e)) return;
    e.preventDefault();
    void submit();
  };

  const describedBy = [opts.hint ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined;
  return (
    <DialogFrame title={opts.title} className="prompt" onCancel={props.onCancel}>
      {opts.prompt ? (
        <label className="prompt-question" htmlFor={`${id}-input`}>
          {opts.prompt}
        </label>
      ) : null}
      <input
        ref={input}
        id={`${id}-input`}
        type="text"
        aria-label={opts.prompt ? undefined : t('prompt.label')}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        placeholder={opts.placeholder}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setError(null);
        }}
        onKeyDown={onKeyDown}
      />
      {opts.hint ? (
        <p id={`${id}-hint`} className={hint?.warn ? 'prompt-hint warn' : 'prompt-hint'}>
          {hint?.text ?? ''}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} role="alert" className="prompt-error">
          {error}
        </p>
      ) : null}
      <div className="dialog-actions">
        <button type="button" className="primary" onClick={() => void submit()}>
          {t('dialog.ok')}
        </button>
        <button type="button" onClick={props.onCancel}>
          {t('dialog.cancel')}
        </button>
      </div>
    </DialogFrame>
  );
}
