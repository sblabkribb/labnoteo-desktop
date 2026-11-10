/**
 * 편집기 맥락 메뉴의 잘라내기·복사·붙여넣기·모두 선택(UI 재설계 Task 16, 명세 §5.6).
 * - document.execCommand 를 쓰지 않는다: 복사와 잘라내기는 navigator.clipboard.writeText, 잘라내기는 쓴 뒤에 지운다
 *   (되돌리기 한 번).
 * - 붙여넣기는 navigator.clipboard.read() 로 읽어(그림과 글), 안 되면 readText() 로, 그 내용을 실은 paste 사건을 편집기에
 *   보낸다. 그래서 Ctrl+V 와 같은 길을 간다: 그림은 pasteImage, 표·URL 은 각자의 붙여 넣기, 글은 CodeMirror 의 붙여 넣기.
 *   아무도 받지 않으면 글을 입력 트랜잭션으로 넣는다.
 * - 모두 선택은 @codemirror/commands 의 selectAll.
 * 표 칸을 편집 중이면 그 셀 편집기가 대상이다(clipboardTarget).
 */
import { selectAll } from '@codemirror/commands';
import { Transaction } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { t } from '../../i18n/t';
import { PASTE_MIME } from '../live/pasteImage';
import { activeCellView } from '../table/cellEditor';

/** navigator.clipboard 에서 쓰는 부분(시험에서 바꿔 끼운다). */
export interface ClipboardLike {
  writeText(text: string): Promise<void>;
  read?(): Promise<ReadonlyArray<{ readonly types: readonly string[]; getType(type: string): Promise<Blob> }>>;
  readText(): Promise<string>;
}

const systemClipboard = (): ClipboardLike => navigator.clipboard as unknown as ClipboardLike;

/** 메뉴가 다룰 편집기: 표 칸의 셀 편집기가 떠 있으면 그것, 아니면 바깥 편집기. */
export function clipboardTarget(outer: EditorView): EditorView {
  return activeCellView(outer) ?? outer;
}

/** 고른 글(여러 구간이면 줄 구분자로 잇는다, CodeMirror 의 복사와 같다). 고른 것이 없으면 ''. */
function selectedText(view: EditorView): string {
  const { state } = view;
  return state.selection.ranges
    .filter((r) => !r.empty)
    .map((r) => state.sliceDoc(r.from, r.to))
    .join(state.lineBreak);
}

/** 고른 글을 클립보드에 쓴다. 고른 것이 없으면 false. */
export async function copySelection(view: EditorView, clipboard: ClipboardLike = systemClipboard()): Promise<boolean> {
  const text = selectedText(view);
  if (!text) return false;
  await clipboard.writeText(text);
  return true;
}

/** 고른 글을 클립보드에 쓰고 지운다(쓰기에 성공한 뒤에만). 읽기 전용이면 복사만 한다. */
export async function cutSelection(view: EditorView, clipboard: ClipboardLike = systemClipboard()): Promise<boolean> {
  if (!(await copySelection(view, clipboard))) return false;
  if (view.state.readOnly) return true;
  view.dispatch(view.state.replaceSelection(''), {
    annotations: Transaction.userEvent.of('delete.cut'),
    scrollIntoView: true,
  });
  return true;
}

interface ClipboardData {
  text: string;
  html: string;
  files: File[];
}

const blobText = (b: Blob): Promise<string> =>
  typeof b.text === 'function' ? b.text() : new Promise((ok) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result ?? ''));
    r.onerror = () => ok('');
    r.readAsText(b);
  });

/** 클립보드를 읽는다: read()(그림·HTML·글), 안 되면 readText(). 둘 다 안 되면 null. */
async function readClipboard(clipboard: ClipboardLike): Promise<ClipboardData | null> {
  try {
    if (!clipboard.read) throw new Error('no read()');
    const data: ClipboardData = { text: '', html: '', files: [] };
    for (const item of await clipboard.read()) {
      for (const type of item.types) {
        if (Object.hasOwn(PASTE_MIME, type)) {
          const blob = await item.getType(type);
          data.files.push(new File([blob], `image.${PASTE_MIME[type]}`, { type }));
        } else if (type === 'text/plain' && !data.text) data.text = await blobText(await item.getType(type));
        else if (type === 'text/html' && !data.html) data.html = await blobText(await item.getType(type));
      }
    }
    return data;
  } catch {
    try {
      return { text: await clipboard.readText(), html: '', files: [] };
    } catch {
      return null;
    }
  }
}

/** 실은 것만 가진 DataTransfer 꼴(브라우저마다 생성자가 다르고 jsdom 에는 없다). 붙여 넣기 처리기가 읽는 부분만. */
function transferOf(data: ClipboardData): DataTransfer {
  const types = [...(data.files.length ? ['Files'] : []), ...(data.text ? ['text/plain'] : []), ...(data.html ? ['text/html'] : [])];
  return {
    files: Object.assign([...data.files], { item: (i: number) => data.files[i] ?? null }),
    items: data.files.map((f) => ({ kind: 'file', type: f.type, getAsFile: () => f })),
    types,
    getData: (type: string) =>
      type === 'text/plain' || type === 'Text' ? data.text : type === 'text/html' ? data.html : '',
  } as unknown as DataTransfer;
}

/**
 * 클립보드의 내용을 편집기에 붙여 넣는다(Ctrl+V 와 같은 길). 읽지 못하면 `notice` 로 알리고 false.
 * 받은 처리기가 없고 글이 있으면 글을 커서 자리에 넣는다.
 */
export async function pasteClipboard(
  view: EditorView,
  clipboard: ClipboardLike = systemClipboard(),
  notice: (message: string) => void = () => undefined,
): Promise<boolean> {
  const data = await readClipboard(clipboard);
  if (!data) {
    notice(t('menu.pasteDenied'));
    return false;
  }
  if (!data.text && !data.html && !data.files.length) return false;
  if (!view.dom.isConnected) return false;
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: transferOf(data) });
  view.contentDOM.dispatchEvent(event);
  if (!event.defaultPrevented && data.text && !view.state.readOnly) {
    view.dispatch(view.state.replaceSelection(data.text), {
      annotations: Transaction.userEvent.of('input.paste'),
      scrollIntoView: true,
    });
  }
  return true;
}

/** 노트 전체(표 칸이면 칸 전체)를 고른다. */
export function selectAllIn(view: EditorView): boolean {
  return selectAll(view);
}
