import { t } from '../i18n/t';
import { DialogFrame } from '../labnote/host/DialogFrame';
import { openDialog, type DialogSpec } from '../labnote/host/dialogStore';
import { NewNoteForm } from './NewNote';

/**
 * 새 노트 대화상자(리본의 새 노트, Ctrl+N, 팔레트). 예전에는 상단 바 안에서 입력이 열려 줄이 밀렸다.
 * Esc 와 닫기 단추는 아무것도 만들지 않고 닫는다. 만들면 그 경로로 끝난다(여는 일은 부르는 쪽).
 */
export function NewNoteDialog(props: {
  spec: Extract<DialogSpec, { kind: 'newNote' }>;
  onDone: (path: unknown) => void;
  onCancel: () => void;
}) {
  return (
    <DialogFrame title={t('newNote.open')} className="new-note-dialog" onCancel={props.onCancel}>
      <NewNoteForm flush={props.spec.flush} invoke={props.spec.invoke} onCreated={props.onDone} onCancel={props.onCancel} />
    </DialogFrame>
  );
}

/** 새 노트 대화상자를 연다. 만든 노트의 vault-relative 경로, 취소하면 undefined. */
export function newNoteDialog(flush: () => Promise<boolean>): Promise<string | undefined> {
  return openDialog<string | undefined>({ kind: 'newNote', flush }, undefined);
}
