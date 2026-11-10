import { useEffect, useId, useRef, useState } from 'react';
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { t } from '../i18n/t';
import { createNote, type CreateFailure } from './createNote';

export interface NewNoteFormProps {
  /** 저장 안 된 편집을 저장한다. false 면 편집이 남아 있다. */
  flush: () => Promise<boolean>;
  /** 노트를 만들었다. 인자는 vault-relative 경로. 편집기에 여는 일은 부르는 쪽이 한다. */
  onCreated: (path: string) => void;
  /** 취소 단추. */
  onCancel: () => void;
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
 * 새 노트 이름 입력(NewNoteDialog 안에 그린다). 노트는 보관함 맨 위에 빈 `.labnote.md` 로 만들어진다.
 * 잘못된 이름은 입력을 연 채로 이유를 보여 준다. 열리면 입력 칸에 커서가 간다.
 */
export function NewNoteForm({ flush, onCreated, onCancel, invoke = tauriInvoke }: NewNoteFormProps) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();

  useEffect(() => input.current?.focus(), []);

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
      onCreated(result.path);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="new-note" onSubmit={submit}>
      <label className="prompt-question" htmlFor={`${id}-name`}>{t('newNote.label')}</label>
      <input
        ref={input}
        id={`${id}-name`}
        type="text"
        value={name}
        aria-describedby={`${id}-hint`}
        onChange={(e) => setName(e.target.value)}
      />
      <p id={`${id}-hint`} className="prompt-hint">
        {t('newNote.hint')}
      </p>
      {error && (
        <p role="alert" className="prompt-error">
          {t(error)}
        </p>
      )}
      <div className="dialog-actions">
        <button type="button" onClick={onCancel}>
          {t('newNote.cancel')}
        </button>
        <button type="submit" className="primary" disabled={busy}>
          {t('newNote.create')}
        </button>
      </div>
    </form>
  );
}
