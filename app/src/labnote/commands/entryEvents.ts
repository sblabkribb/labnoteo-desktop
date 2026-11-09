/**
 * 앱에서 한 이름 바꾸기와 삭제의 알림(SP5 D14). 플러그인은 Obsidian 의 vault rename/delete 를 들어 샘플 후속 처리를 한다.
 * 앱에서는 fileOps.ts 와 renameWithLinks.ts 가 이것을 낸다.
 * - `files` 는 작업 **전에** 뜬 목록이다: 트리가 싣지 않는 .json 과 폴더 속 파일까지 담는다(파일 하나면 그 경로만).
 * - 이름 바꾸기의 `settled` 는 그 흐름이 끝난 뒤 풀린다(링크 고침이면 journal 'done' 뒤, 아니면 다시 연 뒤).
 *   흐름이 실패해도 풀리고, 거절되지(reject) 않는다: 듣는 쪽은 기다린 뒤에만 대화상자를 연다.
 * - 밖에서 한 이름 바꾸기(탐색기, git)는 감시자의 지움+만듦으로 오고 여기로 오지 않는다(받아들인 차이).
 * renameEvents/deleteEvents 와 Move 는 기존 소비자를 위해 그대로 둔다.
 */
import type { LabnoteFs } from '@labnoteo/core';

export type EntryEvent =
  | { kind: 'renamed'; from: string; to: string; isDir: boolean; files: Array<{ from: string; to: string }>; settled: Promise<void> }
  | { kind: 'deleted'; path: string; isDir: boolean; files: string[] };

type Listener = (e: EntryEvent) => void;
const listeners = new Set<Listener>();

export const entryEvents = {
  emit(e: EntryEvent): void {
    for (const l of [...listeners]) {
      try {
        l(e);
      } catch (err) {
        console.error('[entryEvents] listener failed', err);
      }
    }
  },
  subscribe(fn: Listener): () => void {
    listeners.add(fn);
    return () => void listeners.delete(fn);
  },
};

const join = (dir: string, name: string) => (dir === '' ? name : `${dir}/${name}`);

/**
 * 하위 항목이 폴더인지: 목록이 뜨고(파일이면 Rust 의 목록이 거절한다) 비어 있지 않으면 폴더다. 빈 목록이면 읽어 본다:
 * 읽히면 파일(목록이 파일에 빈 목록을 주는 fs), 못 읽으면 빈 폴더다.
 */
async function folderChildren(fs: LabnoteFs, path: string): Promise<string[] | undefined> {
  let names: string[];
  try {
    names = await fs.list(path);
  } catch {
    return undefined;
  }
  if (names.length > 0) return names;
  try {
    await fs.read(path);
    return undefined;
  } catch {
    return [];
  }
}

/** Every file under `dir` (all extensions), walked with fs.list; a child is a folder when list() on it succeeds. */
export async function listFilesUnder(fs: LabnoteFs, dir: string): Promise<string[]> {
  const out: string[] = [];
  const queue = [dir];
  while (queue.length > 0) {
    const current = queue.shift()!;
    let names: string[];
    try {
      names = await fs.list(current);
    } catch {
      continue;
    }
    for (const name of names) {
      const child = join(current, name);
      const children = await folderChildren(fs, child);
      if (children === undefined) out.push(child);
      else if (children.length > 0) queue.push(child);
    }
  }
  return out;
}

/** 이름 바꾸기 전에 뜰 목록: 폴더면 그 안의 모든 파일, 파일이면 그 경로. */
export async function filesBefore(fs: LabnoteFs, path: string, isDir: boolean): Promise<string[]> {
  return isDir ? listFilesUnder(fs, path) : [path];
}

/** `files` 를 새 경로로 옮긴 짝. */
export function movedFiles(files: readonly string[], from: string, to: string): Array<{ from: string; to: string }> {
  return files.map((f) => ({ from: f, to: to + f.slice(from.length) }));
}
