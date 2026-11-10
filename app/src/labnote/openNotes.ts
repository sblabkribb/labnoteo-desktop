import { minimalReplacement, type EditTarget } from '@labnoteo/core';
import { isolateHistory } from '@codemirror/commands';
import { EditorState, Transaction } from '@codemirror/state';
import type { EditorHandle } from '../editor/Editor';
import { lineSeparatorOf, parseRaw, toRaw } from '../editor/documentIo';
import type { AppFs } from '../fs/tauriLabnoteFs';
import { editTargetFor, toDocBreaks } from './editTarget';
import { NoteBusyError, NoteGoneError, NoteSaveError } from './noteErrors';
import { pathKey } from './paths';

export { NoteBusyError, NoteGoneError, NoteSaveError } from './noteErrors';

/**
 * 열린 노트의 목록. 편집기(Editor)가 마운트할 때 자기 손잡이를 등록하고 내려갈 때 지운다.
 * 키는 정규화한 경로의 소문자: NTFS 는 대소문자를 가리지 않는다.
 */
const registry = new Map<string, EditorHandle>();

function keyOf(path: string): string {
  // 보관함을 벗어나는 경로는 열린 노트가 될 수 없다: 그대로 두면 아무것과도 맞지 않는다.
  return pathKey(path);
}

/** 편집기가 부른다. 돌려준 함수로 지운다(그 사이 같은 경로에 다른 손잡이가 등록됐으면 그것은 두고). */
export function registerOpenNote(path: string, handle: EditorHandle): () => void {
  const key = keyOf(path);
  registry.set(key, handle);
  return () => {
    if (registry.get(key) === handle) registry.delete(key);
  };
}

/** 그 경로가 편집기에 열려 있으면 그 손잡이. */
export function openNote(path: string): EditorHandle | undefined {
  return registry.get(keyOf(path));
}

/** 지금 등록된 열린 노트의 손잡이 모두 (업데이트 설치 전 저장, spec §3.4). */
export function openNoteHandles(): EditorHandle[] {
  return [...registry.values()];
}

/**
 * 업데이트를 설치하기 전에 모두 저장한다: 열린 노트 손잡이와 지금 편집기(같으면 한 번만)를 모두 flush 하고,
 * 그 뒤 샘플 동기화를 flush 한다. 하나라도 false 이거나 throw 하면 false. throw 하지 않는다.
 */
export async function flushAllNotes(current: EditorHandle | null | undefined, sync: { flush(): Promise<void> }): Promise<boolean> {
  const handles = new Set(openNoteHandles());
  if (current) handles.add(current);
  const results = await Promise.all([...handles].map((h) => h.flush().then((ok) => ok === true, () => false)));
  if (!results.every(Boolean)) return false;
  try {
    await sync.flush();
  } catch {
    return false;
  }
  return true;
}

type WriteListener = (path: string) => void;
const writeListeners = new Set<WriteListener>();

/**
 * processNote 가 닫힌 노트의 글을 바꿔 썼다는 알림(경로 하나). 열린 노트에 쓴 것은 편집기의 변경으로 따로 보인다.
 * 샘플 동기화(samples/sync.ts)가 듣는다.
 */
export const noteWrites = {
  emit(path: string): void {
    for (const fn of [...writeListeners]) {
      try {
        fn(path);
      } catch (e) {
        console.error('[noteWrites] listener failed', e);
      }
    }
  },
  subscribe(fn: WriteListener): () => void {
    writeListeners.add(fn);
    return () => void writeListeners.delete(fn);
  },
};

const COMMAND_EDIT = () => [isolateHistory.of('full'), Transaction.userEvent.of('input.labnote')];

/**
 * 디스크 원문에 변환을 적용한다. 편집기와 똑같이 읽는다: 같은 줄 구분자로 CodeMirror 상태를 만들고,
 * `doc.toString()` 에 변환을 돌린 뒤 최소 교체만 적용해 `sliceDoc()` 을 읽었을 때의 인코딩으로 되돌린다.
 * 그래서 BOM, CRLF, 그리고 섞인 파일의 바뀌지 않은 줄 끝이 그대로 남는다.
 */
function transformRaw(path: string, raw: string, transform: (text: string) => string): string {
  const doc = parseRaw(path, raw);
  const state = EditorState.create({ doc: doc.text, extensions: EditorState.lineSeparator.of(lineSeparatorOf(doc)) });
  const before = state.doc.toString();
  const m = minimalReplacement(before, transform(before));
  if (!m) return raw;
  const next = state.update({ changes: { from: m.start, to: m.end, insert: toDocBreaks(m.text, state) } }).state;
  return toRaw(doc, next.sliceDoc());
}

/**
 * 노트에 지금 내용 기준의 변환을 적용한다. 변환은 BOM 없는, 줄을 LF 로 이은 글을 받아 같은 꼴로 돌려준다.
 *
 * 열린 노트: 바쁘면 NoteBusyError(아무것도 바꾸지 않는다). 아니면 버퍼에 최소 교체를 한 트랜잭션(되돌리기 한 번)으로
 * 넣고 곧바로 저장한다. 저장하지 못하면 NoteSaveError: 변경은 버퍼에 남고 편집기의 대화상자나 경고가 떠 있다.
 * 사용자가 아직 저장하지 않은 입력은 그대로 남는다 — 디스크가 아니라 버퍼가 기준이다.
 *
 * 닫힌 노트: `fs.modify` 의 비교 후 쓰기(충돌 시 다시 시도)로. 없는 파일은 거부한다(notFound).
 * 처음 읽은 뒤 지워진 노트(`modify` 가 빈 글을 건넨다)는 NoteGoneError: 다시 만들지 않는다.
 *
 * 글이 바뀌었는지를 돌려준다. 바뀌지 않았으면 아무것도 쓰지 않는다.
 */
export async function processNote(fs: AppFs, path: string, transform: (text: string) => string): Promise<boolean> {
  const handle = openNote(path);
  if (handle) {
    const view = handle.view();
    // 한글 IME 조합 중에 글을 바꾸면 조합이 깨진다: 바쁜 노트로 다룬다
    if (handle.busy() || !view || view.composing) throw new NoteBusyError(path);
    const state = view.state;
    const before = state.doc.toString();
    const m = minimalReplacement(before, transform(before));
    if (!m) return false;
    view.dispatch({
      changes: { from: m.start, to: m.end, insert: toDocBreaks(m.text, state) },
      annotations: COMMAND_EDIT(),
    });
    if (!(await handle.flush())) throw new NoteSaveError(path);
    return true;
  }

  const raw = await fs.read(path); // 없는 파일은 여기서 notFound 로 거부된다
  if (transformRaw(path, raw, transform) === raw) return false;
  let changed = false;
  await fs.modify(path, (current) => {
    // modify 는 없는 파일을 빈 글로 건넨다. 읽을 때 글이 있었다면 그 사이 지워진 것이다: 되살리지 않는다.
    if (current === '' && raw !== '') throw new NoteGoneError(path);
    const next = transformRaw(path, current, transform);
    changed = next !== current;
    return next;
  });
  if (changed) noteWrites.emit(path);
  return changed;
}

/** 편집기에 열린 그 노트의 EditTarget. 열려 있지 않거나 바쁘면 undefined. */
export function activeEditTarget(path: string | undefined): (EditTarget & ReturnType<typeof editTargetFor>) | undefined {
  if (path === undefined) return undefined;
  const handle = openNote(path);
  const view = handle?.view();
  if (!handle || !view || handle.busy()) return undefined;
  return editTargetFor(view, path, () => handle.busy());
}
