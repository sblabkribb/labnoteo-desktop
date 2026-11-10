import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { t } from '../../i18n/t';
import { DialogFrame, isComposing } from '../host/DialogFrame';
import type { DialogSpec } from '../host/dialogStore';
import { EXPERIMENTER_MAX } from '../settings';

/**
 * 새 실험 대화상자(UI 재설계 Task 19, 명세 §7.1): 제목(필수)과 실험자(선택). 실험자는 설정 defaultExperimenter(다시 하기면 원래
 * 실험의 author)로 미리 채운다. 제목 검사(`validate`, 동기 또는 비동기)와 안내(`hint`)는 예전 입력 대화상자와 같은 규칙이다:
 * 검사가 도는 동안 다시 내지 않고, 메시지는 보이고 대화상자는 열려 있다. 한글 조합을 끝내는 Enter 는 내지 않는다.
 * 끝나면 다듬지 않은 `{ title, experimenter }`(다듬기는 부르는 쪽), 닫으면 취소.
 */
export function NewExperimentDialog(props: {
  spec: Extract<DialogSpec, { kind: 'newExperiment' }>;
  onDone: (value: unknown) => void;
  onCancel: () => void;
}) {
  const { opts } = props.spec;
  const [title, setTitle] = useState(opts.value ?? '');
  const [experimenter, setExperimenter] = useState(opts.experimenter);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const busy = useRef(false);
  const titleInput = useRef<HTMLInputElement>(null);
  const id = useId();
  const hint = opts.hint?.(title);

  useEffect(() => titleInput.current?.focus(), []);

  const submit = async () => {
    if (busy.current) return;
    const submitted = title;
    if (opts.validate) {
      busy.current = true;
      setChecking(true);
      let message: string | null | undefined;
      try {
        message = await opts.validate(submitted);
      } catch (err) {
        message = (err instanceof Error && err.message) || String(err);
      } finally {
        busy.current = false;
        setChecking(false);
      }
      if (message) {
        setError(message);
        titleInput.current?.focus();
        return;
      }
    }
    props.onDone({ title: submitted, experimenter });
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void submit();
  };
  // 한글 조합을 끝내는 Enter 는 폼을 내지 않는다
  const holdComposingEnter = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && isComposing(e)) e.preventDefault();
  };

  const titleDescribedBy = [opts.hint ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined;
  return (
    <DialogFrame title={opts.title} className="new-experiment-dialog" onCancel={props.onCancel}>
      <form className="new-note new-experiment" onSubmit={onSubmit}>
        <label className="prompt-question" htmlFor={`${id}-title`}>
          {t('newExperiment.titleLabel')}
        </label>
        <input
          ref={titleInput}
          id={`${id}-title`}
          type="text"
          autoComplete="off"
          aria-invalid={error ? true : undefined}
          aria-describedby={titleDescribedBy}
          aria-busy={checking || undefined}
          readOnly={checking}
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            setError(null);
          }}
          onKeyDown={holdComposingEnter}
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
        <label className="prompt-question" htmlFor={`${id}-experimenter`}>
          {t('newExperiment.experimenter')}
        </label>
        <input
          id={`${id}-experimenter`}
          type="text"
          autoComplete="off"
          spellCheck={false}
          maxLength={EXPERIMENTER_MAX}
          aria-describedby={`${id}-experimenter-hint`}
          readOnly={checking}
          value={experimenter}
          onChange={(e) => setExperimenter(e.target.value)}
          onKeyDown={holdComposingEnter}
        />
        <p id={`${id}-experimenter-hint`} className="prompt-hint">
          {t('newExperiment.experimenterHint')}
        </p>
        <div className="dialog-actions">
          <button type="submit" className="primary" disabled={checking}>
            {t('newExperiment.create')}
          </button>
          <button type="button" onClick={props.onCancel}>
            {t('dialog.cancel')}
          </button>
        </div>
      </form>
    </DialogFrame>
  );
}
