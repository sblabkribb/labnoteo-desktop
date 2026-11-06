import { Prec, StateEffect, StateField, Transaction, type EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { isolateHistory } from '@codemirror/commands';
import { t } from '../../i18n/t';
import { notify } from '../../labnote/host/toastStore';
import { activeCell, activeCellView, cellExtras } from '../table/cellEditor';
import { inRawText } from '../table/paste';
import { ERROR_KINDS } from '../../fs/errorKinds';
import { imageLoader } from './imageWidget';

/**
 * 이미지 붙여 넣기와 끌어 놓기(계획 Task 23, D6 의 Obsidian 동작).
 * - 클립보드나 끌어 놓은 파일 가운데 이미지만 노트 폴더의 `images/` 에 새 파일로 쓴다(`vault_write_image`: Rust 가
 *   이름을 다시 검사하고 절대 덮어쓰지 않는다). 그리고 그 자리에 `![[이름]]` 을 넣는다. 이름이 보관함에서 하나뿐이
 *   아니면 `![[보관함 경로]]` 다.
 * - 이미지 파일이 없으면 손대지 않는다(false): 글 붙여 넣기, 표 붙여 넣기, pasteURLAsLink 가 그대로 돈다.
 * - 쓰는 동안 고친 글이 있어도 넣을 자리는 `pendingPaste` 가 변경을 따라 옮긴다.
 * - 넣기는 트랜잭션 하나(`input.paste`, 되돌리기 한 번).
 * - 파일을 실은 끌어 놓기는 받지 않은 것(이미지가 아님, 읽기 전용, 조합 중, 표 칸)도 삼킨다: 그대로 두면 CodeMirror 의
 *   기본 끌어 놓기가 파일을 크기 제한 없이 글로 읽어 노트에 넣는다. 열린 표 칸 편집기에도 같은 막이를 싣는다(cellExtras).
 */

/** Rust `vault_write_image` 와 같은 크기 상한(20 MiB). 넘는 파일은 읽기 전에 거른다. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** 한 번의 붙여 넣기·끌어 놓기가 쓰는 이미지의 최대 수. 나머지는 쓰지 않고 몇 개인지 알린다(수백 장이 묻지도 않고 쓰이지 않게). */
export const MAX_IMAGES_PER_GESTURE = 50;

/** 붙여 넣을 수 있는 MIME → 확장자. SVG 는 받지 않는다(Rust 도 쓰지 않는다). */
export const PASTE_MIME: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
};

/** 끌어 놓은 이름으로 쓸 수 있는 확장자: Rust `IMAGE_EXTS` 에서 svg 를 뺀 것. */
const NAME_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif'];

/** 클립보드·끌어 놓기의 이미지 파일(PASTE_MIME 에 있는 형식만). `files` 가 비면 `items` 의 파일을 본다. */
export function imageFilesOf(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  let files: File[] = Array.from(dt.files ?? []);
  if (!files.length && dt.items) {
    files = Array.from(dt.items)
      .filter((i) => i.kind === 'file')
      .map((i) => i.getAsFile())
      .filter((f): f is File => f !== null);
  }
  return files.filter((f) => Object.hasOwn(PASTE_MIME, f.type));
}

const pad = (n: number) => String(n).padStart(2, '0');

/** 붙여 넣은 이미지의 이름(Obsidian 과 같다, 현지 시각): `Pasted image 20261107153012.png`. */
export function pastedImageName(now: Date, ext: string): string {
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `Pasted image ${stamp}.${ext}`;
}

/** Windows 예약 이름(확장자 앞의 첫 조각으로 판단, Rust `is_safe_component` 와 같다). */
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
/**
 * 파일 이름으로 쓸 수 없는 글자: 제어 문자, Windows 가 막는 글자, 그리고 위키 임베드를 깨는 글자(`[ ] | # ^`).
 * Rust 도 다시 거르지만(앞의 것들), IPC 전에 여기서 거른다.
 */
const BAD_CHAR = /[\u0000-\u001f\u007f\\/:<>"|?*[\]#^]/;

/**
 * 끌어 놓은 파일의 이름: 경로를 떼고 쓸 수 있으면 그대로, 아니면 붙여 넣은 이름(`pastedImageName`).
 * 쓸 수 없는 것: 빈 이름·빈 줄기, 금지 글자, 끝의 점·공백, 예약 이름, 이미지가 아닌 확장자(svg 포함).
 */
export function dropName(file: File): string {
  const base = file.name.slice(Math.max(file.name.lastIndexOf('/'), file.name.lastIndexOf('\\')) + 1);
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : '';
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
  const ok =
    stem !== '' &&
    NAME_EXTS.includes(ext) &&
    !BAD_CHAR.test(base) &&
    !/[. ]$/.test(base) &&
    !RESERVED.test(base.split('.')[0].trimEnd());
  return ok ? base : pastedImageName(new Date(), PASTE_MIME[file.type] ?? 'png');
}

/** 넣을 임베드: 이름이 보관함에서 하나뿐이면 이름만, 아니면 보관함 경로. */
export function embedText(path: string, unique: boolean): string {
  return unique ? `![[${path.slice(path.lastIndexOf('/') + 1)}]]` : `![[${path}]]`;
}

/** 쓰는 중인 붙여 넣기 하나: 고유 번호와 넣을 자리. */
export interface PendingPaste {
  readonly id: number;
  readonly pos: number;
}

/** 붙여 넣기 하나를 시작한다(번호와 자리). */
const addPending = StateEffect.define<PendingPaste>();
/** 붙여 넣기 `id` 가 끝났다(넣었거나 실패했다). */
const donePending = StateEffect.define<number>();

/**
 * 붙여 넣기의 고유 번호. 모듈 전체에서 늘기만 한다: 상태가 통째로 바뀌어도(노트 전환·다시 불러오기, `setState`)
 * 새 붙여 넣기가 옛 붙여 넣기의 번호를 다시 받지 않는다. 그래서 옛 쓰기가 끝나도 새 노트에서 넣을 자리를 찾지 못한다.
 */
let nextPasteId = 0;

/**
 * 쓰는 중인 붙여 넣기의 넣을 자리. 자리는 뒤의 변경을 따라 옮긴다(그 자리에 친 글은 임베드 앞으로 간다: 붙여 넣기가 먼저다).
 * 끝난 것은 뺀다. 새 상태(`setState`)는 빈 목록으로 시작한다.
 */
export const pendingPaste = StateField.define<readonly PendingPaste[]>({
  create: () => [],
  update(value, tr) {
    let next = tr.docChanged ? value.map((p) => ({ id: p.id, pos: tr.changes.mapPos(p.pos, -1) })) : value;
    for (const e of tr.effects) {
      if (e.is(addPending)) next = [...next, e.value];
      else if (e.is(donePending)) next = next.filter((p) => p.id !== e.value);
    }
    return next;
  },
});

/** 노트 폴더의 `images`(보관함 루트의 노트면 `images`). */
const imagesDirOf = (notePath: string) => {
  const slash = notePath.lastIndexOf('/');
  return slash < 0 ? 'images' : `${notePath.slice(0, slash)}/images`;
};

/** 파일의 바이트. WebView2 는 `arrayBuffer` 가 있고, jsdom 에는 없어 FileReader 로 읽는다. */
function bytesOf(file: File): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === 'function') return file.arrayBuffer().then((b) => new Uint8Array(b));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

/** 쓰기(`vault_write_image`)가 낼 수 있는 FsError `kind` 의 번역한 이유. 모르는 kind 는 null. */
function reasonOf(kind: string): string | null {
  switch (kind) {
    case ERROR_KINDS.tooLarge:
      return t('live.image.err.tooLarge');
    case ERROR_KINDS.notImage:
      return t('live.image.err.notImage');
    case ERROR_KINDS.exists:
      return t('live.image.err.exists');
    case ERROR_KINDS.forbidden:
    case ERROR_KINDS.escape:
      return t('live.image.err.forbidden');
    case ERROR_KINDS.pathTooLong:
      return t('live.image.err.pathTooLong');
    case ERROR_KINDS.noVault:
      return t('live.image.err.noVault');
    default:
      return null;
  }
}

/** 거부된 IPC 의 알림 글: 아는 `kind` 는 번역한 이유, 모르면 FsError 의 message, 없으면 kind, 아니면 글로 바꾼 것. */
function errorText(e: unknown): string {
  if (e && typeof e === 'object') {
    const { message, kind } = e as { message?: unknown; kind?: unknown };
    const reason = typeof kind === 'string' ? reasonOf(kind) : null;
    if (reason) return reason;
    if (typeof message === 'string' && message) return message;
    if (typeof kind === 'string' && kind) return kind;
  }
  return String(e);
}

/**
 * 클립보드에 글이 함께 있는가. Excel·Word 는 TSV·HTML 옆에 그림(비트맵)도 올린다: 그때는 글이 먼저다(Obsidian 과 같다).
 * HTML 이 `<img>` 하나뿐이면(브라우저의 "이미지 복사") 글이 아니다. DOMParser 의 문서는 스크립트도 이미지 읽기도 하지 않는다.
 */
function carriesText(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  if (dt.getData('text/plain').trim() !== '') return true;
  const html = dt.getData('text/html');
  if (!html.trim()) return false;
  const body = new DOMParser().parseFromString(html, 'text/html').body;
  // Chromium 은 조각 앞에 `<meta charset>` 를 붙인다: 내용이 아니다
  const elements = Array.from(body.querySelectorAll('*')).filter((el) => el.tagName !== 'META');
  return !(elements.length === 1 && elements[0].tagName === 'IMG' && (body.textContent ?? '').trim() === '');
}

export interface PasteImageDeps {
  /** 보관함 폴더 `dir` 에 `name` 으로 새 파일을 쓰고 실제로 쓴 보관함 경로를 돌려준다(writeVaultImage). */
  write(dir: string, name: string, bytes: Uint8Array): Promise<string>;
  /** 쓰기 실패 알림. 기본은 앱의 알림(error). */
  toast?: (message: string) => void;
  /** 받지 않았거나 넣지 못한 것의 짧은 안내. 기본은 앱의 알림(warn). */
  notice?: (message: string) => void;
}

/** 끌어 놓기가 OS 파일을 싣고 있는가. */
function carriesFiles(dt: DataTransfer | null): boolean {
  return !!dt && ((dt.files?.length ?? 0) > 0 || Array.from(dt.types ?? []).includes('Files'));
}

/** 지금 이미지를 받지 않는 상태: 읽기 전용, 한글 조합 중, 표 칸에 셀 편집기가 떠 있음, 노트 경로를 모름. */
function inert(view: EditorView, state: EditorState): boolean {
  return (
    state.readOnly ||
    view.composing ||
    view.compositionStarted ||
    !!state.field(activeCell, false) ||
    activeCellView(view) !== null ||
    !state.facet(imageLoader)
  );
}

export function pasteImages(deps: PasteImageDeps): Extension {
  const toast = deps.toast ?? ((message: string) => notify('error', message));
  const notice = deps.notice ?? ((message: string) => notify('warn', message));

  async function run(view: EditorView, files: File[], names: string[], id: number, notePath: string): Promise<void> {
    const config = view.state.facet(imageLoader)!;
    const dir = imagesDirOf(config.notePath);
    const written: string[] = [];
    for (let i = 0; i < files.length; i++) {
      // 크기는 읽기 전에 본다: 몇 GB 짜리를 웹뷰에 다 읽어 IPC 로 보낸 뒤에야 거부되지 않게
      if (files[i].size > MAX_IMAGE_BYTES) {
        toast(t('live.image.saveFailed', t('live.image.err.tooLarge')));
        continue;
      }
      try {
        written.push(await deps.write(dir, names[i], await bytesOf(files[i])));
      } catch (e) {
        toast(t('live.image.saveFailed', errorText(e)));
      }
    }
    // 새 파일이 생겼다: 이름 색인을 버리고 다시 읽어 이름이 하나뿐인지 본다(보관함 감시는 새 이미지를 알리지 않는다).
    let embeds: string[] = [];
    if (written.length) {
      config.images.index.invalidate();
      embeds = await Promise.all(
        written.map(async (p) => embedText(p, await config.images.index.isUnique(p.slice(p.lastIndexOf('/') + 1)).catch(() => false))),
      );
    }
    finish(view, id, notePath, written, embeds);
  }

  /**
   * 붙여 넣기 `id` 를 끝낸다. 임베드가 있으면 따라 옮긴 자리에 넣는다(한 트랜잭션).
   * 뷰가 부서졌거나, 상태가 바뀌어 그 번호가 없거나, 다른 노트가 열려 있거나, 편집기가 잠겨 있으면(대화 상자가 열린 동안
   * Editor.tsx 의 LOCKED: readOnly) 아무것도 넣지 않는다. 그때 이미 쓴 파일은 images/ 에 남으므로 그 경로를 알린다.
   */
  function finish(view: EditorView, id: number, notePath: string, written: string[], embeds: string[]): void {
    const orphaned = () => {
      if (written.length) notice(t('live.image.savedNotInserted', written.join(', ')));
    };
    if (!view.dom.isConnected) return orphaned();
    const state = view.state;
    const pos = state.field(pendingPaste, false)?.find((p) => p.id === id)?.pos;
    if (pos === undefined) return orphaned();
    if (!embeds.length || state.readOnly || state.facet(imageLoader)?.notePath !== notePath) {
      orphaned();
      return view.dispatch({ effects: donePending.of(id) });
    }
    const at = Math.min(pos, state.doc.length);
    const insert = embeds.join(state.lineBreak);
    const sel = state.selection.main;
    view.dispatch({
      changes: { from: at, insert },
      effects: donePending.of(id),
      // 커서가 넣을 자리에 그대로 있었으면 임베드 뒤로 옮긴다(붙여 넣기처럼). 그사이 다른 곳으로 갔으면 그대로 둔다.
      ...(sel.empty && sel.head === at ? { selection: { anchor: at + insert.length } } : {}),
      annotations: [Transaction.userEvent.of('input.paste'), isolateHistory.of('full')],
    });
  }

  function take(view: EditorView, event: Event, dt: DataTransfer | null, pos: number, named: boolean): boolean {
    const state = view.state;
    if (inert(view, state)) return false;
    const all = imageFilesOf(dt);
    if (!all.length) return false;
    const at = Math.min(pos, state.doc.length);
    event.preventDefault();
    // 머리말·코드 안에는 임베드를 넣지 않는다. 사건은 삼킨다: 그대로 두면 CodeMirror 의 끌어 놓기가 파일을 글로 읽어 넣는다.
    if (inRawText(state, at)) {
      notice(t('live.image.rawText'));
      return true;
    }
    const files = all.slice(0, MAX_IMAGES_PER_GESTURE);
    if (all.length > files.length) notice(t('live.image.tooMany', MAX_IMAGES_PER_GESTURE, all.length - files.length));
    const now = new Date();
    const names = files.map((f) => (named ? dropName(f) : pastedImageName(now, PASTE_MIME[f.type])));
    const id = nextPasteId++;
    const notePath = state.facet(imageLoader)!.notePath;
    view.dispatch({ effects: addPending.of({ id, pos: at }) });
    void run(view, files, names, id, notePath).catch(() => finish(view, id, notePath, [], []));
    return true;
  }

  /** 받지 않은 파일 끌어 놓기를 삼킨다(파일 글이 노트에 들어가지 않게). 이미지가 아닌 파일이면 안내한다. */
  function swallowFiles(e: DragEvent, images: boolean): boolean {
    if (!carriesFiles(e.dataTransfer)) return false;
    e.preventDefault();
    if (!images) notice(t('live.image.dropOnlyImages'));
    return true;
  }

  return [
    pendingPaste,
    // 표 붙여 넣기(SP1)와 pasteURLAsLink 보다 먼저 본다: 이미지만 실린 클립보드는 여기서 받고, 글이 함께 실린 클립보드는
    // 글 붙여 넣기 쪽으로 넘긴다(carriesText).
    Prec.high(
      EditorView.domEventHandlers({
        paste(e, view) {
          // 글이 함께 있으면(Excel 표, Word 글) 글 붙여 넣기(SP1 표, pasteURLAsLink, 기본)에 맡긴다
          if (carriesText(e.clipboardData)) return false;
          return take(view, e, e.clipboardData, view.state.selection.main.head, false);
        },
        drop(e, view) {
          const at = view.posAtCoords({ x: e.clientX, y: e.clientY });
          if (take(view, e, e.dataTransfer, at ?? view.state.selection.main.head, true)) return true;
          return swallowFiles(e, imageFilesOf(e.dataTransfer).length > 0);
        },
      }),
    ),
    // 열린 표 칸 편집기(중첩 뷰)에도: 칸에 놓은 파일이 글로 읽혀 칸에 들어가지 않게
    cellExtras.of(
      Prec.highest(EditorView.domEventHandlers({ drop: (e) => swallowFiles(e, imageFilesOf(e.dataTransfer).length > 0) })),
    ),
  ];
}
