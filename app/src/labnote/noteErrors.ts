/** 편집기가 바쁘다(읽는 중, 읽기 실패, 풀리지 않은 바깥 변경). 아무것도 바꾸지 않았다. */
export class NoteBusyError extends Error {
  constructor(readonly path: string) {
    super(`note is busy: ${path}`);
    this.name = 'NoteBusyError';
  }
}

/** 변경은 버퍼에 들어갔지만 저장하지 못했다(충돌 또는 I/O 오류). 편집기의 대화상자나 저장 경고가 떠 있다. */
export class NoteSaveError extends Error {
  constructor(readonly path: string) {
    super(`the change is in the editor but could not be saved: ${path}`);
    this.name = 'NoteSaveError';
  }
}

/** 명령이 I/O 를 기다리는 사이 노트가 바뀌었다. 묶음 편집은 아무것도 적용하지 않았다. */
export class NoteChangedError extends Error {
  constructor(readonly path: string) {
    super(`the note changed while the command was running; nothing was applied: ${path}`);
    this.name = 'NoteChangedError';
  }
}
