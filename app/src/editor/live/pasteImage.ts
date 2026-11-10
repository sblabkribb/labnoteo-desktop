import { Prec, StateEffect, StateField, Transaction, type EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { isolateHistory } from '@codemirror/commands';
import { t } from '../../i18n/t';
import { notify, type NotifyOpts } from '../../labnote/host/toastStore';
import { activeCell, activeCellView, cellExtras } from '../table/cellEditor';
import { inRawText } from '../table/paste';
import { ERROR_KINDS } from '../../fs/errorKinds';
import { imageLoader } from './imageWidget';
import type { ImageFolder } from '../../labnote/settings';
import { MAX_ATTACHMENT_BYTES, attachmentDir, attachmentName, folderLabel, imageDir, isBlockedName, linkFor } from './attachments';

/**
 * 그림과 첨부 붙여 넣기·끌어 놓기(계획 Task 23, D6 의 Obsidian 동작; UI 재설계 Task 17).
 * - 그림(PASTE_MIME)은 설정 `imageFolder` 의 폴더에 새 파일로 쓴다(`vault_write_image`): 기본은 실험의 `resources/`,
 *   'images' 면 노트 폴더의 `images/`. 그림이 아닌 파일은 실험의 `resources/` 에 쓴다(`vault_write_attachment`).
 *   Rust 가 이름과 폴더를 다시 검사하고 절대 덮어쓰지 않는다. 그 자리에 링크를 넣는다(`linkFor`: 그림·PDF 는 `![[…]]`,
 *   나머지는 `[[…]]`, 이름이 보관함에서 하나뿐이 아니면 보관함 경로). 실행 파일·스크립트는 받지 않고 알린다.
 * - 저장하면 "첨부 N개 저장됨" 알림에 파일마다 간 폴더를 보이고, "폴더 열기" 단추로 탐색기에서 보인다.
 * - 끌고 있는 동안 편집기에 어디로 갈지 안내한다(`data-drop-hint`: "resources/에 첨부").
 * - 파일이 없으면 손대지 않는다(false): 글 붙여 넣기, 표 붙여 넣기, pasteURLAsLink 가 그대로 돈다.
 * - 쓰는 동안 고친 글이 있어도 넣을 자리는 `pendingPaste` 가 변경을 따라 옮긴다.
 * - 넣기는 트랜잭션 하나(`input.paste`, 되돌리기 한 번).
 * - 파일을 실은 끌어 놓기는 받지 않은 것(이미지가 아님, 읽기 전용, 조합 중, 표 칸)도 삼킨다: 그대로 두면 CodeMirror 의
 *   기본 끌어 놓기가 파일을 크기 제한 없이 글로 읽어 노트에 넣는다. 열린 표 칸 편집기에도 같은 막이를 싣는다(cellExtras).
 */

/** Rust `vault_write_image` 와 같은 크기 상한(20 MiB). 넘는 파일은 읽기 전에 거른다. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** 한 번의 붙여 넣기·끌어 놓기가 쓰는 파일(그림과 첨부)의 최대 수. 나머지는 쓰지 않고 몇 개인지 알린다(수백 개가 묻지도 않고 쓰이지 않게). */
export const MAX_IMAGES_PER_GESTURE = 50;
export const MAX_FILES_PER_GESTURE = MAX_IMAGES_PER_GESTURE;

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

/** 클립보드·끌어 놓기의 모든 파일. `files` 가 비면 `items` 의 파일을 본다. */
export function filesOf(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  let files: File[] = Array.from(dt.files ?? []);
  if (!files.length && dt.items) {
    files = Array.from(dt.items)
      .filter((i) => i.kind === 'file')
      .map((i) => i.getAsFile())
      .filter((f): f is File => f !== null);
  }
  return files;
}

/** 그림으로 다루는 파일: PASTE_MIME 에 있는 형식(SVG 는 아니다: 첨부로 간다). */
const isPasteImage = (f: { type: string }) => Object.hasOwn(PASTE_MIME, f.type);

/** 클립보드·끌어 놓기의 이미지 파일(PASTE_MIME 에 있는 형식만). */
export function imageFilesOf(dt: DataTransfer | null): File[] {
  return filesOf(dt).filter(isPasteImage);
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

const hasKind = (e: unknown, kind: string) => !!e && typeof e === 'object' && (e as { kind?: unknown }).kind === kind;

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
  /** 보관함 폴더 `dir` 에 `name` 으로 새 그림 파일을 쓰고 실제로 쓴 보관함 경로를 돌려준다(writeVaultImage). */
  write(dir: string, name: string, bytes: Uint8Array): Promise<string>;
  /** 그림이 아닌 첨부를 `dir`(resources 폴더)에 새 파일로 쓴다(writeVaultAttachment). 없으면 그림만 받는다. */
  writeAttachment?(dir: string, name: string, bytes: Uint8Array): Promise<string>;
  /** 첨부 이름이 보관함에서 하나뿐인가(링크에 이름만 넣을지). 없거나 실패하면 보관함 경로를 넣는다. */
  isUniqueAttachment?(name: string): Promise<boolean>;
  /** 그림 저장 폴더 설정. 기본 'resources'. 붙여 넣을 때마다 읽는다(설정을 바꾸면 바로 따른다). */
  imageFolder?: () => ImageFolder;
  /** 노트가 든 실험 폴더. 기본은 코어의 getExperimentDir(`labnote/###_이름`). */
  experimentDirOf?: (notePath: string) => string | undefined;
  /** 저장 알림(제목, 자세한 글, 단추). 기본은 앱의 알림(success). */
  saved?: (message: string, opts: NotifyOpts) => void;
  /** "폴더 열기": 쓴 파일을 탐색기에서 골라 보인다(revealInFolder). 없으면 단추를 달지 않는다. */
  reveal?: (path: string) => void;
  /** 쓰기 실패 알림. 기본은 앱의 알림(error). */
  toast?: (message: string) => void;
  /** 받지 않았거나 넣지 못한 것의 짧은 안내. 기본은 앱의 알림(warn). */
  notice?: (message: string) => void;
}

/** 끌어 놓기가 OS 파일을 싣고 있는가. */
/** 끌어 놓기 안내를 지우기까지 dragover 를 기다리는 시간. */
export const DROP_HINT_MS = 250;

const setDropHint = StateEffect.define<string | null>();
/** 끌고 있는 파일이 갈 곳의 안내("resources/에 첨부"). 편집기 틀에 `lno-drop-target` 과 `data-drop-hint` 로 싣는다(theme.ts). */
export const dropHint = StateField.define<string | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setDropHint)) value = e.value;
    return value;
  },
  provide: (f) =>
    EditorView.editorAttributes.from(f, (hint): Record<string, string> => (hint ? { class: 'lno-drop-target', 'data-drop-hint': hint } : {})),
});

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

/** 쓸 파일 하나: 그림인가, 어느 폴더에 어떤 이름으로. */
interface Planned {
  readonly file: File;
  readonly image: boolean;
  readonly dir: string;
  readonly name: string;
}

export function pasteImages(deps: PasteImageDeps): Extension {
  const toast = deps.toast ?? ((message: string) => notify('error', message));
  const notice = deps.notice ?? ((message: string) => notify('warn', message));
  const saved = deps.saved ?? ((message: string, opts: NotifyOpts) => notify('success', message, opts));
  const experimentDirOf = deps.experimentDirOf;
  const imageFolder = (): ImageFolder => deps.imageFolder?.() ?? 'resources';
  const dirFor = (notePath: string, image: boolean) =>
    image ? imageDir(notePath, imageFolder(), experimentDirOf) : attachmentDir(notePath, experimentDirOf);

  /** 하나를 쓴다. 실패는 알리고 null. 크기는 읽기 전에 본다: 몇 GB 짜리를 웹뷰에 다 읽어 IPC 로 보낸 뒤에야 거부되지 않게. */
  async function writeOne(p: Planned): Promise<string | null> {
    const failed = (reason: string) =>
      toast(p.image ? t('live.image.saveFailed', reason) : t('attach.saveFailed', p.name, reason));
    if (p.file.size > (p.image ? MAX_IMAGE_BYTES : MAX_ATTACHMENT_BYTES)) {
      failed(p.image ? t('live.image.err.tooLarge') : t('attach.tooBig'));
      return null;
    }
    try {
      const bytes = await bytesOf(p.file);
      return await (p.image ? deps.write(p.dir, p.name, bytes) : deps.writeAttachment!(p.dir, p.name, bytes));
    } catch (e) {
      failed(!p.image && hasKind(e, ERROR_KINDS.tooLarge) ? t('attach.tooBig') : errorText(e));
      return null;
    }
  }

  async function run(view: EditorView, planned: Planned[], id: number, notePath: string): Promise<void> {
    const config = view.state.facet(imageLoader)!;
    const written: Array<{ path: string; image: boolean }> = [];
    for (const p of planned) {
      const path = await writeOne(p);
      if (path !== null) written.push({ path, image: p.image });
    }
    // 새 파일이 생겼다: 이름 색인을 버리고 다시 읽어 이름이 하나뿐인지 본다(보관함 감시는 새 이미지를 알리지 않는다).
    let links: string[] = [];
    if (written.length) {
      config.images.index.invalidate();
      links = await Promise.all(
        written.map(async ({ path, image }) => {
          const name = path.slice(path.lastIndexOf('/') + 1);
          const unique = image
            ? config.images.index.isUnique(name)
            : (deps.isUniqueAttachment?.(name) ?? Promise.resolve(false));
          return linkFor(path, await unique.catch(() => false));
        }),
      );
    }
    const paths = written.map((w) => w.path);
    if (finish(view, id, notePath, paths, links)) announce(paths);
  }

  /** "첨부 N개 저장됨" 과 파일마다 간 폴더("plate.csv → resources/"), 그리고 첫 파일을 탐색기에서 보이는 단추. */
  function announce(paths: string[]): void {
    const detail = paths
      .map((p) => t('attach.detail', p.slice(p.lastIndexOf('/') + 1), folderLabel(p.slice(0, Math.max(0, p.lastIndexOf('/'))))))
      .join(', ');
    const reveal = deps.reveal;
    saved(detail, {
      title: t('attach.saved', paths.length),
      detail,
      ...(reveal ? { action: { label: t('attach.openFolder'), run: () => reveal(paths[0]) } } : {}),
    });
  }

  /**
   * 붙여 넣기 `id` 를 끝낸다. 임베드가 있으면 따라 옮긴 자리에 넣는다(한 트랜잭션).
   * 뷰가 부서졌거나, 상태가 바뀌어 그 번호가 없거나, 다른 노트가 열려 있거나, 편집기가 잠겨 있으면(대화 상자가 열린 동안
   * Editor.tsx 의 LOCKED: readOnly) 아무것도 넣지 않는다. 그때 이미 쓴 파일은 images/ 에 남으므로 그 경로를 알린다.
   */
  function finish(view: EditorView, id: number, notePath: string, written: string[], embeds: string[]): boolean {
    const orphaned = () => {
      if (written.length) notice(t('live.image.savedNotInserted', written.join(', ')));
      return false;
    };
    if (!view.dom.isConnected) return orphaned();
    const state = view.state;
    const pos = state.field(pendingPaste, false)?.find((p) => p.id === id)?.pos;
    if (pos === undefined) return orphaned();
    if (!embeds.length || state.readOnly || state.facet(imageLoader)?.notePath !== notePath) {
      orphaned();
      view.dispatch({ effects: donePending.of(id) });
      return false;
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
    return true;
  }

  function take(view: EditorView, event: Event, dt: DataTransfer | null, pos: number, named: boolean): boolean {
    const state = view.state;
    if (inert(view, state)) return false;
    // 그림 쓰기만 있으면(writeAttachment 없음) 예전처럼 그림만 받는다
    const all = filesOf(dt).filter((f) => deps.writeAttachment || isPasteImage(f));
    if (!all.length) return false;
    const at = Math.min(pos, state.doc.length);
    event.preventDefault();
    clearHint(view);
    // 머리말·코드 안에는 링크를 넣지 않는다. 사건은 삼킨다: 그대로 두면 CodeMirror 의 끌어 놓기가 파일을 글로 읽어 넣는다.
    if (inRawText(state, at)) {
      notice(t('live.image.rawText'));
      return true;
    }
    // 실행 파일·스크립트는 첨부로 저장하지 않는다(Rust 도 거부한다)
    const blocked = all.filter((f) => !isPasteImage(f) && isBlockedName(f.name));
    if (blocked.length) notice(t('attach.blocked', blocked.map((f) => f.name).join(', ')));
    const allowed = all.filter((f) => !blocked.includes(f));
    if (!allowed.length) return true;
    const files = allowed.slice(0, MAX_FILES_PER_GESTURE);
    if (allowed.length > files.length) notice(t('live.image.tooMany', MAX_FILES_PER_GESTURE, allowed.length - files.length));
    const now = new Date();
    const notePath = state.facet(imageLoader)!.notePath;
    const planned: Planned[] = files.map((file) => {
      const image = isPasteImage(file);
      const name = image ? (named ? dropName(file) : pastedImageName(now, PASTE_MIME[file.type])) : attachmentName(file.name, now);
      return { file, image, dir: dirFor(notePath, image), name };
    });
    const id = nextPasteId++;
    view.dispatch({ effects: addPending.of({ id, pos: at }) });
    void run(view, planned, id, notePath).catch(() => finish(view, id, notePath, [], []));
    return true;
  }

  /** 받지 않은 파일 끌어 놓기를 삼킨다(파일 글이 노트에 들어가지 않게). 그림만 받는데 그림이 없으면 안내한다. */
  function swallowFiles(e: DragEvent, view?: EditorView): boolean {
    if (!carriesFiles(e.dataTransfer)) return false;
    e.preventDefault();
    if (view) clearHint(view);
    if (!deps.writeAttachment && imageFilesOf(e.dataTransfer).length === 0) notice(t('live.image.dropOnlyImages'));
    return true;
  }

  /** 끌고 있는 파일이 갈 폴더(들)의 안내. 받지 않는 상태거나 파일이 아니면 null. */
  function hintFor(view: EditorView, dt: DataTransfer | null): string | null {
    if (!carriesFiles(dt) || inert(view, view.state)) return null;
    const notePath = view.state.facet(imageLoader)!.notePath;
    // 끄는 동안에는 파일 이름을 읽을 수 없다(브라우저가 막는다): 형식(MIME)만 본다
    const kinds = Array.from(dt?.items ?? []).filter((i) => i.kind === 'file');
    const images = kinds.length ? kinds.map((i) => isPasteImage(i)) : [false];
    const taken = images.filter((img) => img || !!deps.writeAttachment);
    const folders = [...new Set(taken.map((img) => folderLabel(dirFor(notePath, img))))];
    return folders.length ? t('attach.dropHint', folders.join(' · ')) : null;
  }

  let hintTimer: ReturnType<typeof setTimeout> | undefined;
  function clearHint(view: EditorView): void {
    clearTimeout(hintTimer);
    if (view.dom.isConnected && view.state.field(dropHint, false)) view.dispatch({ effects: setDropHint.of(null) });
  }
  function showHint(view: EditorView, hint: string | null): void {
    if (hint === null) return clearHint(view);
    if (view.state.field(dropHint, false) !== hint) view.dispatch({ effects: setDropHint.of(hint) });
    clearTimeout(hintTimer);
    // dragover 는 끄는 동안 계속 온다: 멈추면(편집기 밖으로 나갔거나 취소) 안내를 지운다
    hintTimer = setTimeout(() => clearHint(view), DROP_HINT_MS);
  }

  return [
    pendingPaste,
    dropHint,
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
          return swallowFiles(e, view);
        },
        dragover(e, view) {
          if (carriesFiles(e.dataTransfer)) showHint(view, hintFor(view, e.dataTransfer));
          return false;
        },
        dragleave(e, view) {
          // 편집기 밖으로 나갔을 때만(안의 다른 요소로 옮길 때도 dragleave 가 온다)
          const to = e.relatedTarget;
          if (!(to instanceof Node) || !view.dom.contains(to)) clearHint(view);
          return false;
        },
      }),
    ),
    // 열린 표 칸 편집기(중첩 뷰)에도: 칸에 놓은 파일이 글로 읽혀 칸에 들어가지 않게
    cellExtras.of(Prec.highest(EditorView.domEventHandlers({ drop: (e) => swallowFiles(e) }))),
  ];
}
