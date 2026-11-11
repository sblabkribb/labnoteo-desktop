import { useId, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { t } from '../i18n/t';
import { isComposing } from '../labnote/host/DialogFrame';
import type { IntegrationDeps } from './IntegrationSettingsDialog';
import type { SecretStatus, Slot } from './netIpc';
import { notifySecretsChange } from './secretsEvents';

/**
 * 쓰기만 하는 키 칸(D17). 친 값은 React 상태에 두지 않고 제어하지 않는 입력에만 있다: 누를 때 ref 로 읽어 `setSecret` 으로
 * 보내고 곧바로 칸을 비운다. 키 값은 다시 그려지지 않는다(웹뷰는 '설정됨' 여부만 안다). 저장하거나 지운 뒤에는
 * `notifySecretsChange(await deps.status())` 로 구독자(partbank 기능, bfworkflow 준비 상태)에게 알린다.
 * 한글 조합 중의 Enter 는 저장하지 않는다.
 */
export function KeyField(props: {
  deps: Pick<IntegrationDeps, 'setSecret' | 'clearSecret' | 'status'>;
  /** `github` 은 GitHub 묶음의 어댑터(`github_set_token`)로만 간다. `secret_set` 은 GitHub 자리를 거절한다. */
  slot: Slot;
  label: string;
  hints?: readonly string[];
  isSet: boolean;
  placeholder?: string;
  /** 대화상자가 연결 시험에 지금 칸의 값을 쓰도록 넘기는 ref. */
  inputRef?: RefObject<HTMLInputElement>;
  /** 저장 전에 고칠 주소를 저장한다(키는 주소의 origin 에 묶인다). false 면 저장하지 않는다. */
  beforeSave?: () => Promise<boolean | void>;
  onSaved(status?: SecretStatus): void;
  children?: ReactNode;
}) {
  const id = useId();
  const own = useRef<HTMLInputElement>(null);
  const ref = props.inputRef ?? own;
  const busy = useRef(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const refresh = async () => {
    let status: SecretStatus;
    try {
      status = await props.deps.status();
    } catch {
      props.onSaved();
      return;
    }
    notifySecretsChange(status);
    props.onSaved(status);
  };

  const save = async () => {
    if (busy.current || !ref.current?.value.trim()) return;
    busy.current = true;
    setError(undefined);
    try {
      if (props.beforeSave && (await props.beforeSave()) === false) return;
      const value = ref.current?.value.trim() ?? '';
      if (!value) return;
      try {
        await props.deps.setSecret(props.slot, value);
      } catch {
        setError(t('integrations.keyFailed'));
        return;
      }
      if (ref.current) ref.current.value = '';
      await refresh();
    } finally {
      busy.current = false;
    }
  };

  const remove = async () => {
    if (busy.current) return;
    busy.current = true;
    setError(undefined);
    try {
      try {
        await props.deps.clearSecret(props.slot);
      } catch {
        setError(t('integrations.keyRemoveFailed'));
        return;
      }
      await refresh();
    } finally {
      busy.current = false;
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || isComposing(e)) return;
    e.preventDefault();
    void save();
  };

  return (
    <div className="integration-field integration-key">
      <div className="integration-key-head">
        <label className="prompt-question" htmlFor={id}>
          {props.label}
        </label>
        <span className={props.isSet ? 'integration-key-state set' : 'integration-key-state'}>
          {props.isSet ? t('integrations.keySet') : t('integrations.keyNotSet')}
        </span>
      </div>
      {(props.hints ?? []).map((h, i) => (
        <p key={`hint-${i}`} className="prompt-hint">
          {h}
        </p>
      ))}
      <div className="integration-key-row">
        <input
          ref={ref}
          id={id}
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={props.placeholder}
          defaultValue=""
          onKeyDown={onKeyDown}
        />
        <button type="button" onClick={() => void save()}>
          {t('integrations.saveKey')}
        </button>
        {props.isSet ? (
          <button type="button" onClick={() => void remove()}>
            {t('integrations.removeKey')}
          </button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="prompt-hint warn">
          {error}
        </p>
      ) : null}
      {props.children}
    </div>
  );
}
