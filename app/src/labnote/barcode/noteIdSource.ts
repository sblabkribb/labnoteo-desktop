import type { AppFs } from '../../fs/tauriLabnoteFs';
import { processNote } from '../openNotes';
import type { NoteIdSource } from '../port/noteIdService';
import type { NoteIdIndex, NoteRef } from './noteIdIndex';

type IdWriteListener = (path: string) => void;
const idWriteListeners = new Set<IdWriteListener>();

/**
 * NoteIdService 가 노트의 `labnote_id` 를 쓰기 직전의 알림. 명령마다 따로 만드는 서비스(print/worksheetCommand.ts
 * noteIdServiceFor)가 준 ID 를 감시(idWatch)의 서비스가 "누가 ID 를 바꿨다"로 여겨 옛 ID 를 되돌릴지 묻지 않게 한다
 * (플러그인은 서비스가 하나라 writeId 가 알던 ID 를 먼저 고친다).
 */
export const noteIdWrites = {
  emit(path: string): void {
    for (const fn of [...idWriteListeners]) {
      try {
        fn(path);
      } catch (e) {
        console.error('[noteIdWrites] listener failed', e);
      }
    }
  },
  subscribe(fn: IdWriteListener): () => void {
    idWriteListeners.add(fn);
    return () => void idWriteListeners.delete(fn);
  },
};

/**
 * 앱의 NoteIdSource: 노트 목록과 ID 는 노트 ID 색인에서, 읽기와 쓰기는 편집기를 아는 fs(editorAwareFs)로.
 * 쓰기는 processNote 다: 열린 노트는 버퍼에 최소 교체로 넣고 저장하며, 바쁘거나 한글 조합 중이면 NoteBusyError 로
 * 아무것도 바꾸지 않는다. 닫힌 노트는 비교 후 쓰기이고, 그 사이 지워진 노트는 다시 만들지 않는다(NoteGoneError).
 * 쓰기를 시도한 뒤에는(실패해도) 그 경로를 색인에서 다시 읽는다.
 */
export function appNoteIdSource(index: NoteIdIndex, fs: AppFs): NoteIdSource {
  return {
    files: () => index.refs(),
    idOf: (path) => index.idOf(path),
    read: (path) => fs.read(path),
    async process(path, fn) {
      try {
        // 서비스가 아는 ID 는 글이 실제로 바뀌는 순간에만 잊는다: processNote 는 바쁜(조합 중) 노트와 읽기 실패를
        // transform 전에 거부하므로, 그때는 아는 ID 가 남아 나중의 손 고침에도 "옛 ID 를 되돌릴까?" 를 묻는다.
        await processNote(fs, path, (text) => {
          const next = fn(text);
          if (next !== text) noteIdWrites.emit(path);
          return next;
        });
      } finally {
        await index.refresh(path);
      }
    },
    exists: (path) => index.exists(path),
  };
}

/** 색인에 있는 그 경로의 노트. 없으면 undefined. */
export function noteRef(index: NoteIdIndex, path: string): NoteRef | undefined {
  return index.refs().find((r) => r.path === path);
}
