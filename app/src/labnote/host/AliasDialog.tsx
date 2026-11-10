import type { PromptHint } from '@labnoteo/core';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { t } from '../../i18n/t';
import { DialogFrame, isComposing } from './DialogFrame';
import { ALIAS_BACK, type DialogSpec } from './dialogStore';

/** 플러그인 `WorkflowAliasOpts`(src/modals.ts)와 같은 모양. */
export interface AliasOpts {
  /** 카탈로그 워크플로 id, 예: `WT010`. */
  id: string;
  /** 카탈로그 이름, 예: `Nucleotide Sequencing`. */
  catalogName: string;
  /** 대화상자 제목. 없으면 "별칭 (선택)"(UI 재설계 Task 11). */
  title?: string;
  /** 고르기 다음 단계: "← 다시 고르기" 단추를 보이고, Esc 는 닫지 않고 고르기로 돌아간다(ALIAS_BACK). */
  back?: boolean;
  /** 빈 입력 칸에 보이는 글자. */
  placeholder?: string;
  /** 처음 별칭. 선택된 채로 열려 치면 바뀐다. */
  value?: string;
  /** 이 항목이 무엇인지, 제목 아래. */
  about?: string;
  /** 고른 카탈로그 항목의 설명, about 아래. */
  description?: string;
  /** 입력이 바뀔 때마다 다시 계산하는 안내. 제출을 막지 않는다. */
  hint?: (v: string) => PromptHint | undefined;
  /** 이 별칭을 쓸 수 없는 이유, 또는 null. 보이고 제출을 막는다. */
  validate?: (v: string) => string | null;
}

/**
 * 플러그인 workflowAliasModal 의 React 판(src/modals.ts:474-585 을 읽고 다시 썼다. 그쪽은 Obsidian DOM 이다).
 * 왼쪽에 고칠 수 없는 `[id catalogName]` 머리, 오른쪽에 별칭 입력 칸. 빈 채로 내면 '', 닫으면 undefined.
 * 처음 값은 선택된 채로 열린다. validate 의 메시지는 입력 칸 아래에 보이고 제출을 막으며, 입력을 바꾸면 지워진다.
 * hint 는 입력마다 다시 계산한다. 한글 조합을 끝내는 Enter 는 제출하지 않는다(Prompt 와 같다).
 */
export function AliasDialog(props: {
  spec: Extract<DialogSpec, { kind: 'alias' }>;
  onDone: (value: unknown) => void;
  onCancel: () => void;
}) {
  const { opts } = props.spec;
  const [value, setValue] = useState(opts.value ?? '');
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const hint = opts.hint?.(value);
  const prefix = `[${opts.id} ${opts.catalogName}]`;

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  const submit = () => {
    const message = opts.validate?.(value);
    if (message) {
      setError(message);
      return;
    }
    props.onDone(value);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || isComposing(e)) return;
    e.preventDefault();
    submit();
  };

  const describedBy = [opts.hint ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined;
  return (
    <DialogFrame title={opts.title ?? t('alias.title')} className="alias" onCancel={opts.back ? () => props.onDone(ALIAS_BACK) : props.onCancel} onClose={props.onCancel}>
      {opts.about ? <p className="alias-about">{opts.about}</p> : null}
      {opts.description ? <p className="alias-description">{opts.description}</p> : null}
      <div className="alias-row">
        <span className="alias-prefix" aria-hidden="true">
          {prefix}
        </span>
        <input
          ref={input}
          className="alias-input"
          type="text"
          aria-label={t('alias.prefixLabel', prefix)}
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
      </div>
      {error ? (
        <p id={`${id}-error`} role="alert" className="prompt-error">
          {error}
        </p>
      ) : null}
      {opts.hint ? (
        <p id={`${id}-hint`} className={hint?.warn ? 'prompt-hint warn' : 'prompt-hint'}>
          {hint?.text ?? ''}
        </p>
      ) : null}
      <div className="dialog-actions">
        {opts.back ? (
          <button type="button" className="alias-back" onClick={() => props.onDone(ALIAS_BACK)}>
            {t('alias.back')}
          </button>
        ) : null}
        <button type="button" className="primary" onClick={submit}>
          {t('dialog.ok')}
        </button>
        <button type="button" onClick={props.onCancel}>
          {t('dialog.cancel')}
        </button>
      </div>
    </DialogFrame>
  );
}
