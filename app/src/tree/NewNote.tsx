import { useEffect, useRef, useState } from 'react';
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { t } from '../i18n/t';
import { createNote, type CreateFailure } from './createNote';

interface Props {
  /** 저장 안 된 편집을 저장한다. false 면 편집이 남아 있다. */
  flush: () => Promise<boolean>;
  /** 노트를 만들었다. 인자는 vault-relative 경로. 편집기에 여는 일은 부르는 쪽이 한다. */
  onCreated: (path: string) => void;
  invoke?: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
}

const MESSAGES: Record<CreateFailure | 'unsaved', string> = {
  empty: 'newNote.error.empty',
  separator: 'newNote.error.separator',
  invalid: 'newNote.error.invalid',
  exists: 'newNote.error.exists',
  failed: 'newNote.error.failed',
  unsaved: 'newNote.error.unsaved',
};

/**
 * "새 노트" 단추. 누르면 이름 입력이 인라인으로 열린다(대화상자 없음). 노트는 보관함 맨 위에,
 * 빈 `.labnote.md` 로 만들어진다. 잘못된 이름은 입력을 연 채로 이유를 보여 준다.
 */
export function NewNote({ flush, onCreated, invoke = tauriInvoke }: Props) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  function close() {
    setOpen(false);
    setName('');
    setError(undefined);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      // 새 노트가 열리면 지금 노트가 닫힌다: 저장 못 한 편집이 있으면 만들지도 않는다.
      if (!(await flush())) return setError(MESSAGES.unsaved);
      const result = await createNote(name, invoke);
      if (!result.ok) return setError(MESSAGES[result.reason]);
      close();
      onCreated(result.path);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button type="button" className="primary" title={t('newNote.hint')} onClick={() => setOpen(true)}>
        {t('newNote.open')}
      </button>
    );
  }
  return (
    <form onSubmit={submit}>
      <label>
        {t('newNote.label')} <input ref={input} type="text" value={name} onChange={(e) => setName(e.target.value)} />
      </label>{' '}
      <button type="submit" className="primary" disabled={busy}>
        {t('newNote.create')}
      </button>{' '}
      <button type="button" onClick={close}>
        {t('newNote.cancel')}
      </button>
      <p>{t('newNote.hint')}</p>
      {error && <p role="alert">{t(error)}</p>}
    </form>
  );
}
