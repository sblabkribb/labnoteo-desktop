import { minimalReplacement, type EditTarget } from '@labnoteo/core';
import { isolateHistory } from '@codemirror/commands';
import { EditorState, Transaction } from '@codemirror/state';
import type { EditorHandle } from '../editor/Editor';
import { lineSeparatorOf, parseRaw, toRaw } from '../editor/documentIo';
import type { AppFs } from '../fs/tauriLabnoteFs';
import { editTargetFor, toDocBreaks } from './editTarget';
import { NoteBusyError, NoteSaveError } from './noteErrors';
import { pathKey } from './paths';

export { NoteBusyError, NoteSaveError } from './noteErrors';

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
 *
 * 글이 바뀌었는지를 돌려준다. 바뀌지 않았으면 아무것도 쓰지 않는다.
 */
export async function processNote(fs: AppFs, path: string, transform: (text: string) => string): Promise<boolean> {
  const handle = openNote(path);
  if (handle) {
    const view = handle.view();
    if (handle.busy() || !view) throw new NoteBusyError(path);
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
    const next = transformRaw(path, current, transform);
    changed = next !== current;
    return next;
  });
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
