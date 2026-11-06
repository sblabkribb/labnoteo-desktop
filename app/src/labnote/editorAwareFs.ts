import type { AppFs } from '../fs/tauriLabnoteFs';
import { parseRaw } from '../editor/documentIo';
import { NoteBusyError } from './noteErrors';
import { openNote, processNote } from './openNotes';

/**
 * 디스크 원문(updater 가 돌려준 글)을 열린 편집기의 `doc.toString()` 꼴로 바꾼다: BOM 을 떼고,
 * 편집기가 그 파일을 읽을 때처럼 줄 끝을 다룬다. 섞이지 않은 CRLF 파일과 CRLF 가 많은 섞인 파일은 CRLF -> LF,
 * LF 가 많은 섞인 파일은 그대로(편집기 안에서도 그 CR 은 줄의 글자다).
 */
function toDocText(raw: string, sample: string, lineBreak: string): string {
  const body = raw.startsWith('\uFEFF') ? raw.slice(1) : raw;
  const doc = parseRaw('', sample);
  return !doc.mixed || lineBreak === '\r\n' ? body.replace(/\r\n/g, '\n') : body;
}

/**
 * 편집기를 아는 파일 시스템. 열린 노트는 디스크가 아니라 버퍼가 기준이다:
 * - read: 열려 있고 읽기를 마쳤으면 버퍼를 디스크 인코딩으로(저장 안 된 입력 포함).
 * - modify: 열려 있으면 updater 를 버퍼의 디스크 꼴에 돌려 그 차이만 버퍼에 넣고 저장한다(processNote).
 * - write: 열려 있으면 내용과의 최소 차이를 버퍼에 넣는다(되돌리기 한 번). 앱과 포팅한 코드는 있는 노트를 이것으로
 *   쓰지 않는다 — 코어 경로를 위한 안전망이다.
 * - 나머지(rename, trash, exists, list, mkdir, remove, rmdir)는 그대로 넘긴다.
 */
export function editorAwareFs(inner: AppFs): AppFs {
  return {
    async read(path) {
      const raw = openNote(path)?.rawText();
      return raw !== undefined ? raw : inner.read(path);
    },
    async modify(path, updater) {
      const handle = openNote(path);
      if (!handle) return inner.modify(path, updater);
      await processNote(inner, path, (text) => {
        // processNote 는 지금 버퍼의 doc.toString() 을 넘긴다: 같은 순간의 rawText 가 그 디스크 꼴이다.
        const raw = handle.rawText();
        const lineBreak = handle.view()?.state.lineBreak;
        if (raw === undefined || lineBreak === undefined) throw new NoteBusyError(path);
        return toDocText(updater(raw), raw, lineBreak);
      });
    },
    async write(path, content) {
      const handle = openNote(path);
      if (!handle) return inner.write(path, content);
      await processNote(inner, path, () => {
        const raw = handle.rawText();
        const lineBreak = handle.view()?.state.lineBreak;
        if (raw === undefined || lineBreak === undefined) throw new NoteBusyError(path);
        return toDocText(content, raw, lineBreak);
      });
    },
    exists: (path) => inner.exists(path),
    mkdir: (path) => inner.mkdir(path),
    list: (dir) => inner.list(dir),
    remove: (path) => inner.remove(path),
    rmdir: (path) => inner.rmdir(path),
    rename: (from, to) => inner.rename(from, to),
    trash: (path) => inner.trash(path),
  };
}
