import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from 'react';
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { listen as tauriListen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Compartment, EditorState, Prec, type Extension } from '@codemirror/state';
import { EditorView, highlightSpecialChars, keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { autocompletion } from '@codemirror/autocomplete';
import { t } from '../i18n/t';
import { useLang } from '../i18n/useLang';
import { getLang } from '../i18n/lang';
import { editorLang } from './live/editorLang';
import { editorTheme } from './theme';
import { labnoteMarkdown } from './markdownSyntax';
import { tableExtension } from './table/field';
import { INSERT_TABLE_KEY, insertTable } from './table/commands';
import { cellExtras, cellOuterKeys } from './table/cellEditor';
import { getMode, subscribeMode, toggleMode, TOGGLE_MODE_KEY, type EditorMode } from './live/mode';
import { livePreview, readmeEmptyState } from './live';
import type { Upkeep } from '../labnote/commands/autoUpkeep';
import { checklistTickWatch, type ChecklistCounts } from '../labnote/commands/statusNudge';
import { addPropertyCommand, propertiesActions, PROPS_ADD_KEY } from './live/properties';
import { followLinkAtCursor, linkClickHandler, type LinkOpenDeps, type OpenTarget } from './live/links';
import { imageLoader } from './live/imageWidget';
import { vaultImages, type VaultImages } from './live/vaultImages';
import { pasteImages } from './live/pasteImage';
import { writeVaultAttachment, writeVaultImage, type RawInvoke } from '../fs/vaultImage';
import { revealInFolder } from '../fs/vaultOpen';
import type { ImageFolder } from '../labnote/settings';
import { linkIndex } from '../links/linkIndex';
import { completionGuards, wikiCompletionSource, wikiReopen, type WikiCompletionDeps } from '../links/complete';
import { pendingSampleInsert, sampleCompletionSource, sampleOptionClass, sampleReopen, type SampleCompletionDeps } from '../samples/complete';
import {
  linkResolution,
  reconfigureFlusher,
  scheduleReconfigure,
  scheduleResolution,
  type LinkResolution,
} from './live/linkResolution';
import { sampleEditorConfig, sampleNotePath, type SampleEditorConfig } from '../samples/editorConfig';
import { sampleHighlight } from '../samples/highlight';
import type { SampleEnv } from '../samples/env';
import { LIST_KEYS } from './live/listKeys';
import { aiDraftReview } from './live/aiDraftReview';
import { FORMAT_KEYS, formatExtensions, runFormat } from './commands/formatCommands';
import { notify } from '../labnote/host/toastStore';
import { ERROR_KINDS, hasErrorKind } from '../fs/errorKinds';
import { VAULT_CHANGED, type ListenFn } from '../vault/useVaultEvents';
import { lineSeparatorOf, loadDocument, parseRaw, saveDocument, toRaw, type LoadedDocument } from './documentIo';
import { registerOpenNote } from '../labnote/openNotes';
import { noteIdTouch } from '../labnote/barcode/idWatch';
import { samplesSync } from '../samples/sync';
import { captureFocus } from '../ui/returnFocus';
import { extractOutline, type OutlineItem } from './outline/extract';
import { clearOutline, publishCursor, publishOutline } from './outline/outlineStore';
import { clearEditorStatus, countWords, publishEditorStatus, type SaveState } from './editorStatus';
import { ViewHeader } from '../ui/ViewHeader';
import { Icon } from '../ui/Icon';

/**
 * 앱이 쓰는 키. CodeMirror 기본 keymap 에서 뺀다: 뒤로·앞으로 가기(Alt+←/→, cursorSyntaxLeft/Right)와 오른쪽 사이드바
 * (Ctrl+Shift+\, cursorMatchingBracket — 괄호 위에서 커서를 옮기며 preventDefault 해 App 의 처리기가 건너뛴다).
 */
const NAV_KEYS = new Set(['Alt-ArrowLeft', 'Alt-ArrowRight', 'Shift-Mod-\\']);

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

/** 마지막 입력 뒤 이만큼 조용하면 저장한다. */
export const AUTOSAVE_MS = 2000;
/** 계속 치고 있어도 이 시간이 지나면 저장한다: 무입력 대기만으로는 쉬지 않고 쓰는 사람의 글이 저장되지 않는다. */
export const MAX_AUTOSAVE_MS = 10_000;
/** 저장이 연달아 이만큼 실패하면 더 다시 시도하지 않는다(경고는 계속 보인다). 다음 입력이 한 번 더 시도한다. */
export const MAX_SAVE_ATTEMPTS = 5;
/** 마지막 편집 뒤 이만큼 지나 개요(제목 목록)를 다시 낸다. 읽을 때는 곧바로 낸다. */
export const OUTLINE_MS = 300;
/** 마지막 편집 뒤 이만큼 지나 버퍼의 링크를 링크 색인에 낸다(저장 안 된 링크도 백링크에 보이게). 읽을 때는 곧바로 낸다. */
export const LINKS_MS = 300;

export interface EditorHandle {
  /** 다른 노트로 넘어가기 전에 부른다. 잃을 편집이 없으면(저장됐거나 원래 깨끗하면) true. */
  flush(): Promise<boolean>;
  view(): EditorView | undefined;
  /**
   * 읽는 중, 읽기 실패, 또는 바깥 변경이 풀리지 않은 동안 true — 사용자가 충돌 대화상자를 "그대로 두기"로 닫은 뒤에도.
   * 이 동안 명령은 이 노트를 고치지 않는다(`processNote` 가 NoteBusyError 로 거부한다).
   */
  busy(): boolean;
  /** 버퍼를 디스크 인코딩(BOM, 줄바꿈)으로: toRaw(doc, sliceDoc()). 읽기 전에는 undefined. */
  rawText(): string | undefined;
  /** 커서를 그 줄(0부터)과 글자 위치로 옮기고 보이게 한 뒤 초점을 준다. 범위를 넘으면 끝으로 붙인다. */
  reveal(at: { line: number; ch?: number }): void;
  /** 버퍼를 링크 색인의 덧씌움으로 지금 낸다(LINKS_MS 를 기다리지 않는다). 한글 조합 중에는 하지 않고, 조합이 끝난 뒤의 갱신에서 낸다. */
  publishLinks(): void;
  /** 마지막으로 저장했거나 읽은 본문과 다른가(저장 안 된 편집이 있다). */
  isDirty(): boolean;
}

interface Props {
  /** vault-relative POSIX 경로. 노트가 바뀌면 호출자가 `key` 를 바꿔 새로 마운트한다 — 상태가 섞이지 않게. */
  path: string;
  invoke?: InvokeFn;
  listen?: ListenFn;
  autosaveMs?: number;
  maxAutosaveMs?: number;
  /** 창 닫기 요청을 가로채 저장하기 위한 이음새. 기본은 Tauri 창. */
  windowApi?: WindowApi;
  /** 처음 읽은 뒤 한 번 커서를 둘 곳(0부터 센 줄). */
  initialReveal?: { line: number; ch?: number };
  /**
   * 본문의 오른쪽 클릭(키보드의 메뉴 키 포함). 표 칸 안의 사건은 오지 않는다(표가 자기 메뉴를 띄운다).
   * 부르기 전에 누른 자리로 커서를 옮긴다. 다만 선택 안을 눌렀으면 선택을 그대로 둔다.
   * 메뉴를 띄우면 `e.preventDefault()` 로 기본 메뉴를 막는다.
   */
  onContextMenu?: (e: MouseEvent, view: EditorView) => void;
  /** 보기 머리의 "표 넣기" 앞에 그릴 주 동작. 인자는 편집기가 바쁜지(읽는 중, 대화상자, 풀리지 않은 바깥 변경). */
  headerActions?: (busy: boolean) => ReactNode;
  /** 보기 머리 왼쪽: 뒤로·앞으로와 경로 표시. */
  headerLead?: ReactNode;
  /** "표 넣기" 뒤, 보기 방식 단추 앞에 그릴 단추(QR 등). 인자는 headerActions 와 같다. */
  headerTools?: (busy: boolean) => ReactNode;
  /** 보기 머리 오른쪽 끝(⋯ 메뉴, 오른쪽 사이드바 단추). */
  headerTrail?: ReactNode;
  /**
   * 링크를 열 때(그냥 클릭, Ctrl/Cmd+클릭, Alt+Enter): 다른 노트(`note`, 위키링크의 `subpath` 나 마크다운의 `anchor`),
   * 없는 노트 만들기(`create`), 바깥 주소(`external`). 이 노트 안의 제목·`#앵커` 는 편집기가 직접 옮긴다.
   */
  onOpenLink?: (target: OpenTarget) => void;
  /** 라이브 미리보기의 이미지(blob: URL 캐시와 이름 색인). 기본은 앱의 보관함 이미지. 테스트는 가짜를 꽂는다. */
  images?: VaultImages;
  /** 속성 격자의 상태 칩을 눌렀을 때. 격자는 status 를 직접 쓰지 않는다: 앱이 "실험 상태 바꾸기" 명령을 돌린다. */
  onChangeStatus?: () => void;
  /**
   * 샘플 강조·완성이 읽는 앱의 샘플 설정(계획 D8). null 이면 샘플을 그리지 않는다. 정체성은 저장소 판이나 샘플 설정이
   * 바뀔 때만 바뀐다. 바뀌면 조합이 끝난 뒤 `samplesSlot` 을 갈아 끼운다.
   */
  samples?: SampleEditorConfig | null;
  /** 샘플 동작(완성의 동작 줄, 샘플 넣기)이 쓰는 SampleEnv. 명령 맥락이 아직 없으면 undefined. */
  sampleEnv?: () => SampleEnv | undefined;
  /** 붙여 넣거나 끌어 놓은 그림을 둘 폴더(보관함 설정 imageFolder). 기본 'resources'. 붙여 넣을 때마다 최신 값을 읽는다. */
  imageFolder?: ImageFolder;
  /**
   * 실험 README 에서만 준다(UI 재설계 Task 19). 라이브 미리보기의 빈 체크리스트 카드 단추("첫 워크플로 추가")가 부른다.
   * 처음 그릴 때 있었는지로 카드를 싣는다(노트가 바뀌면 다시 마운트한다). 부를 때는 최신 prop 이다.
   */
  onAddWorkflow?: () => void;
  /** 실험 README 에서만 준다(Task 19). 사용자가 체크리스트를 바꾸면 그 전후의 셈과 상태(상태 권유). */
  onChecklistTick?: (prev: ChecklistCounts, next: ChecklistCounts) => void;
  /**
   * 쓰는 동안의 손질(Task 20): 바뀐 트랜잭션을 알려 last_updated_date 찍기를 예약하고, 저장 직전에 워크플로 노트의
   * "Related Unit Operations" 목록을 맞춘다. 부를 때마다 최신 prop 이다.
   */
  upkeep?: Upkeep;
}

export interface WindowApi {
  onCloseRequested(handler: (e: { preventDefault(): void }) => void | Promise<void>): Promise<() => void>;
  destroy(): Promise<void>;
}

/**
 * 열린 노트와 디스크의 관계.
 * - changed: 편집하는 동안 밖에서 바뀌었다 (`current` 는 사용자가 본 디스크 내용).
 * - gone: 밖에서 지워지거나 이름이 바뀌었다.
 * 둘 중 하나인 동안에는 아무것도 저절로 쓰이지 않는다: 자동 저장도, Ctrl+S 도 대화상자만 다시 연다.
 */
type External = { kind: 'changed'; current: string } | { kind: 'gone' };

const LOCKED = [EditorState.readOnly.of(true), EditorView.editable.of(false)];
/** 언어 칸: 편집 영역의 이름표와 위젯들이 읽는 화면 언어(editorLang). 언어를 바꾸면 이 칸만 갈아 끼운다. */
const labelAttrs = (): Extension => [EditorView.contentAttributes.of({ 'aria-label': t('editor.label') }), editorLang.of(getLang())];

export const Editor = forwardRef<EditorHandle, Props>(function Editor(
  {
    path,
    invoke = tauriInvoke as InvokeFn,
    listen = tauriListen as ListenFn,
    autosaveMs = AUTOSAVE_MS,
    maxAutosaveMs = MAX_AUTOSAVE_MS,
    windowApi,
    initialReveal,
    onContextMenu,
    headerActions,
    headerLead,
    headerTools,
    headerTrail,
    onOpenLink,
    images = vaultImages,
    onChangeStatus,
    samples = null,
    sampleEnv,
    imageFolder = 'resources',
    onAddWorkflow,
    onChecklistTick,
    upkeep,
  },
  ref,
) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView>();
  const lock = useRef(new Compartment());
  /** 편집 영역의 이름표(aria-label). 언어를 바꾸면 이 칸만 갈아 끼운다: 뷰와 본문, 되돌리기 기록은 그대로다. */
  const label = useRef(new Compartment());
  /**
   * 라이브 미리보기 칸. 그리는 확장(지금은 표 격자)이 모두 여기 들어 있고, 소스 보기에서는 비어 있다(live/mode.ts).
   * 모드는 상태 밖의 저장소에 산다: adopt 가 상태를 새로 만들 때 modeRef 에서 다시 읽는다.
   */
  const mode = useRef(new Compartment());
  const modeRef = useRef<EditorMode>(getMode());
  const [modeState, setModeState] = useState<EditorMode>(modeRef.current);
  /** 라이브 미리보기의 확장. 그림자 루트와 저장 함수가 필요해 마운트 effect 가 채운다. */
  const liveExtensions = useRef<() => Extension>(() => []);
  const lang = useLang();
  const docRef = useRef<LoadedDocument>();
  /** 마지막으로 저장했거나 읽은 에디터 본문. 이것과 같으면 깨끗하다 (되돌리기로 돌아와도). */
  const baseline = useRef('');
  const externalRef = useRef<External | null>(null);
  const saveFailures = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const maxTimer = useRef<ReturnType<typeof setTimeout>>();
  const clearTimers = () => {
    clearTimeout(timer.current);
    clearTimeout(maxTimer.current);
    maxTimer.current = undefined;
  };
  const extensions = useRef<(doc: LoadedDocument | undefined) => Extension[]>(() => []);
  const outlineTimer = useRef<ReturnType<typeof setTimeout>>();
  const cursorFrame = useRef<number>();
  const linksTimer = useRef<ReturnType<typeof setTimeout>>();
  /**
   * 링크 풀이 칸(SP4 Task 8). 풀이는 파일 목록에만 달려 있어 linkIndex 의 filesVersion 이나 준비 상태가 바뀔 때만 갈아 끼운다
   * (타이핑으로는 바뀌지 않는다). adopt 가 상태를 새로 만들 때 resolutionRef 에서 다시 읽는다. 색인이 준비되기 전에는 null.
   */
  const resolutionSlot = useRef(new Compartment());
  const resolutionRef = useRef<LinkResolution | null>(null);
  /** 샘플 설정 칸(D8). adopt 가 상태를 새로 만들 때 samplesRef 에서 다시 읽는다. */
  const samplesSlot = useRef(new Compartment());
  const samplesRef = useRef<SampleEditorConfig | null>(samples);
  /** 조합 중이라 내지 못한 덧씌움이 남았다: 조합이 끝난 첫 갱신에서 낸다. */
  const linksPending = useRef(false);
  /** 링크 색인(linkIndex)에 이 버퍼를 덧씌움으로 낸다. 조합 중에는 색인을 건드리지 않는다(IME 를 깨지 않게). */
  const publishLinks = () => {
    clearTimeout(linksTimer.current);
    const view = viewRef.current;
    if (!view || !alive.current) return;
    if (view.composing) {
      linksPending.current = true;
      return;
    }
    linksPending.current = false;
    linkIndex.setOverlay(path, view.state.sliceDoc());
  };
  /** 개요 패널(outlineStore)에 이 노트의 제목 목록을 낸다. */
  const publishItems = () => {
    clearTimeout(outlineTimer.current);
    const view = viewRef.current;
    if (!view) return;
    // CodeMirror 의 줄로 읽는다: 번호가 doc.line(n) 과 같아야 한다(섞인 줄 끝에서 toString 은 줄을 더 나눈다)
    publishOutline(path, extractOutline(Array.from(view.state.doc.iterLines())));
    // 상태 줄과 보기 머리가 읽는 본문과 단어 수도 같은 때에 낸다(타이핑마다 다시 그리지 않게).
    const text = view.state.sliceDoc();
    publishEditorStatus(path, { text, words: countWords(text) });
  };
  /** 커서 줄(1부터)을 낸다. 한 프레임에 한 번만(선택을 끌며 옮기는 동안 패널을 매번 그리지 않게). */
  const publishCursorLine = () => {
    if (cursorFrame.current !== undefined) return;
    cursorFrame.current = requestAnimationFrame(() => {
      cursorFrame.current = undefined;
      const view = viewRef.current;
      if (view && alive.current) publishCaret(view);
    });
  };
  /** 커서의 줄(개요)과 줄·열(상태 줄)을 낸다. */
  const publishCaret = (view: EditorView) => {
    const head = view.state.selection.main.head;
    const line = view.state.doc.lineAt(head);
    publishCursor(path, line.number);
    publishEditorStatus(path, { line: line.number, col: head - line.from + 1 });
  };
  const locked = useRef(true);
  /** 저장과 디스크 확인을 한 줄로 세운다: 확인이 저장 도중의 반쯤 쓰인 상태를 보지 않게. */
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const checkQueued = useRef(false);
  const latest = useRef({ invoke, autosaveMs, maxAutosaveMs, onContextMenu, onOpenLink, onChangeStatus, sampleEnv, imageFolder, onAddWorkflow, onChecklistTick, upkeep });
  latest.current = { invoke, autosaveMs, maxAutosaveMs, onContextMenu, onOpenLink, onChangeStatus, sampleEnv, imageFolder, onAddWorkflow, onChecklistTick, upkeep };

  const [status, setStatusState] = useState<'loading' | 'ready' | 'error'>('loading');
  /** 명령이 동기적으로 묻는 상태(busy). 렌더를 기다리지 않는다. */
  const statusRef = useRef<'loading' | 'ready' | 'error'>('loading');
  const setStatus = (s: 'loading' | 'ready' | 'error') => {
    statusRef.current = s;
    setStatusState(s);
  };
  /** 마운트된 동안 true. 내려간 편집기의 손잡이는 늘 바쁘다. */
  const alive = useRef(false);
  const firstReveal = useRef(initialReveal);
  const [dirty, setDirty] = useState(false);
  const [external, setExternalState] = useState<External | null>(null);
  const [dialogOpen, setDialogOpenState] = useState(false);
  /** 충돌 대화상자가 열릴 때 초점이 있던 자리(대개 편집 영역). 닫히면 그리로 돌려준다. */
  const restoreFocus = useRef<(() => void) | null>(null);
  /**
   * 대화상자를 열고 닫는다. 여는 순간(autoFocus 가 초점을 가져가기 전, 렌더 전에) 초점 자리를 적어 둔다:
   * effect 에서 적으면 이미 대화상자의 단추가 초점을 가진 뒤다.
   */
  const setDialogOpen = (open: boolean) => {
    if (open && !restoreFocus.current) restoreFocus.current = captureFocus();
    setDialogOpenState(open);
  };
  const [saveError, setSaveError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [closeAsk, setCloseAsk] = useState(false);
  const win = useRef<WindowApi>();

  // 아래 함수들은 ref 와 setState 만 만지므로 렌더마다 새로 만들어도 같은 일을 한다. effect 는 api.current 를 거쳐 부른다.
  const api = useRef({} as ReturnType<typeof makeApi>);
  function makeApi() {
    // sliceDoc 은 상태의 줄 구분자로 잇는다. doc.toString() 은 항상 LF 로 이어서, 섞인 파일의 CRLF 줄이 LF 가 된다.
    const text = () => viewRef.current?.state.sliceDoc() ?? '';
    const isDirty = () => text() !== baseline.current;
    const setExternal = (e: External | null) => {
      externalRef.current = e;
      setExternalState(e);
    };
    const adopt = (doc: LoadedDocument) => {
      const view = viewRef.current;
      // 본문과 줄 구분자가 그대로인 조용한 다시 읽기(디스크의 BOM 만 바뀐 경우 등)는 상태를 갈아 끼우지 않는다:
      // 보이는 것이 같으니 위젯의 DOM(초점이 있는 속성 격자 입력 포함)과 되돌리기 기록을 그대로 둔다. 처음 읽기는 늘 새 상태다.
      const same = !!view && !!docRef.current && view.state.sliceDoc() === doc.text && view.state.lineBreak === lineSeparatorOf(doc);
      if (view && !same) {
        // 새 상태를 통째로 올린다: 되돌리기 기록이 비어서 시작하므로, 불러오기 이전의 본문(빈 본문 포함)으로
        // 되돌릴 수 없다. 되돌리기가 그 본문을 디스크에 저장해 버리는 일이 없다.
        // 조용한 다시 읽기는 보이지 않아야 한다: 커서와 스크롤 위치를 새 본문 안에서 그대로 둔다.
        // 길이는 만들어진 상태의 doc.length 로 잰다 — 섞인 CRLF 노트는 doc.text.length 보다 짧다(CRLF 가 한 칸).
        const { anchor, head } = view.state.selection.main;
        const top = view.scrollDOM.scrollTop;
        const extensionsFor = extensions.current(doc);
        const len = EditorState.create({ doc: doc.text, extensions: extensionsFor }).doc.length;
        const next = EditorState.create({
          doc: doc.text,
          selection: { anchor: Math.min(anchor, len), head: Math.min(head, len) },
          extensions: extensionsFor,
        });
        view.setState(next); // 여기서 던져도 아래의 기준 본문은 아직 바뀌지 않았다
        view.scrollDOM.scrollTop = top;
        requestAnimationFrame(() => (view.scrollDOM.scrollTop = top));
        // 개요는 읽자마자 낸다(다시 읽기 포함). setState 는 updateListener 를 부르지 않는다.
        publishItems();
        publishCaret(view);
      }
      // 읽은(또는 다시 읽은) 본문의 링크를 곧바로 낸다. 조용한 다시 읽기도 낸다: 덧씌움이 디스크와 같아진다.
      if (view) publishLinks();
      // 뷰가 새 본문을 보여 준 뒤에만 기준을 옮긴다: 뷰와 기준이 어긋나면 낡은 버퍼가 저장될 수 있다.
      docRef.current = doc;
      baseline.current = doc.text;
      saveFailures.current = 0; // 다시 읽기는 새 출발이다
      setCloseAsk(false);
      setExternal(null);
      setDialogOpen(false);
      setSaveError(false);
      setDirty(false);
    };
    const run = <T,>(fn: () => Promise<T>): Promise<T> => {
      const p = chain.current.then(fn);
      chain.current = p.catch(() => undefined);
      return p;
    };
    const scheduleAutosave = () => {
      clearTimeout(timer.current);
      if (externalRef.current) return; // 대화상자가 답을 받기 전에는 자동 저장도 멈춘다
      const fire = () => void run(() => doSave());
      timer.current = setTimeout(fire, latest.current.autosaveMs);
      maxTimer.current ??= setTimeout(fire, latest.current.maxAutosaveMs);
    };

    /** 저장. 저장된(또는 저장할 것이 없는) 상태면 true. `force` 는 대화상자에서 덮어쓰기를 고른 경우다. */
    async function doSave(force?: { against?: string }): Promise<boolean> {
      clearTimers();
      const doc = docRef.current;
      if (!doc || !viewRef.current) return false;
      if (!force && externalRef.current) {
        setDialogOpen(true);
        return false;
      }
      // 워크플로 노트의 UO 목록을 버퍼에서 맞춘다(Task 20). 그 편집이 다시 건 자동 저장 시계는 이 저장이 대신한다.
      if (!force && alive.current && latest.current.upkeep?.beforeSave(doc.path, viewRef.current)) clearTimers();
      const body = text();
      if (!force && body === baseline.current) return true;
      let result;
      setSaving(true);
      try {
        result = await saveDocument(doc, body, { force: !!force, against: force?.against, invoke: latest.current.invoke });
      } catch {
        setSaving(false);
        setSaveError(true);
        // 일시적인 실패(백신 잠금, 디스크 가득)면 키를 다시 칠 때까지 기다리지 않고 다시 시도한다 —
        // 간격을 두 배씩 늘리고, MAX_SAVE_ATTEMPTS 번 연달아 실패하면 멈춘다(경고는 남는다).
        saveFailures.current += 1;
        if (saveFailures.current < MAX_SAVE_ATTEMPTS && !externalRef.current) {
          const delay = latest.current.autosaveMs * 2 ** (saveFailures.current - 1);
          timer.current = setTimeout(() => void run(() => doSave()), delay);
        }
        return false;
      }
      setSaving(false);
      if (!result.ok) {
        setExternal({ kind: 'changed', current: result.current });
        setDialogOpen(true);
        return false;
      }
      saveFailures.current = 0;
      docRef.current = { ...doc, text: body, loadedText: toRaw(doc, body) };
      baseline.current = body;
      setExternal(null);
      setDialogOpen(false);
      setSaveError(false);
      if (!isDirty()) setCloseAsk(false);
      // 저장하는 사이 더 쳤을 수 있다.
      const still = isDirty();
      setDirty(still);
      if (still) scheduleAutosave();
      return true;
    }

    /** 파일이 밖에서 바뀌었는지 디스크를 다시 읽어 본다. 이벤트의 종류는 믿지 않는다: 읽은 결과가 진실이다. */
    async function check() {
      const doc = docRef.current;
      if (!doc) return;
      let raw: string;
      try {
        raw = await latest.current.invoke<string>('vault_read', { path: doc.path });
      } catch (e) {
        if (hasErrorKind(e, ERROR_KINDS.notFound)) {
          clearTimers();
          setExternal({ kind: 'gone' });
          setDialogOpen(true);
        }
        return; // 그 밖의 읽기 실패로는 아무것도 단정하지 않는다. 저장 때의 기대값 비교가 마지막 방어선이다.
      }
      if (raw === doc.loadedText) {
        // 내 저장의 메아리이거나, 사라졌다가 같은 내용으로 돌아왔다.
        if (externalRef.current) {
          setExternal(null);
          setDialogOpen(false);
          if (isDirty()) scheduleAutosave();
        }
        return;
      }
      if (!isDirty()) {
        adopt(parseRaw(doc.path, raw)); // 잃을 편집이 없다: 조용히 새 내용을 보여 준다
        return;
      }
      clearTimers();
      const wasOpen = externalRef.current !== null;
      setExternal({ kind: 'changed', current: raw });
      if (!wasOpen) setDialogOpen(true);
    }

    return {
      isDirty,
      scheduleAutosave,
      save: (force?: { against?: string }) => run(() => doSave(force)),
      queueCheck: () => {
        if (checkQueued.current) return;
        checkQueued.current = true;
        void run(async () => {
          checkQueued.current = false;
          await check();
        });
      },
      flush: () => run(async () => (isDirty() ? doSave() : true)),
      adopt,
      reload: () =>
        run(async () => {
          try {
            adopt(await loadDocument(path, latest.current.invoke));
          } catch (e) {
            if (hasErrorKind(e, ERROR_KINDS.notFound)) setExternal({ kind: 'gone' });
            else setSaveError(true);
          }
        }),
    };
  }
  api.current = makeApi();

  /** 바깥(명령, 열린 노트 목록)에 주는 손잡이. 한 번만 만들어 같은 객체를 등록하고 ref 로도 준다. */
  const handle = useRef<EditorHandle>({
    flush: () => api.current.flush(),
    view: () => viewRef.current,
    busy: () => !alive.current || !viewRef.current || statusRef.current !== 'ready' || externalRef.current !== null,
    rawText: () => {
      const doc = docRef.current;
      const view = viewRef.current;
      return doc && view ? toRaw(doc, view.state.sliceDoc()) : undefined;
    },
    publishLinks: () => publishLinks(),
    isDirty: () => api.current.isDirty(),
    reveal: ({ line, ch = 0 }) => {
      const view = viewRef.current;
      if (!view) return;
      const doc = view.state.doc;
      const l = doc.line(Math.max(0, Math.min(Math.floor(line), doc.lines - 1)) + 1);
      const at = l.from + Math.max(0, Math.min(Math.floor(ch), l.length));
      // 제목 줄이 화면 맨 위(조금 띄워서)에 오게 한다: 개요에서 고른 제목이 바로 보인다.
      view.dispatch({ selection: { anchor: at }, effects: EditorView.scrollIntoView(at, { y: 'start', yMargin: 8 }) });
      view.focus();
    },
  }).current;
  useImperativeHandle(ref, () => handle, [handle]);

  // 열기: 읽어서 에디터에 채운다.
  useEffect(() => {
    let live = true;
    // 그림자 루트 안에 만든다: CodeMirror 의 스타일이 <style> 태그 대신 adoptedStyleSheets 로 들어가, CSP 에 'unsafe-inline' 을 열지 않아도 된다.
    // (개발 모드의 StrictMode 는 effect 를 두 번 돌린다: 이미 붙인 루트는 다시 붙일 수 없으니 재사용한다.)
    const shadow = host.current!.shadowRoot ?? host.current!.attachShadow({ mode: 'open' });
    // 표는 격자로 그리고 칸 안에서 고친다. 칸의 입력은 이 문서로 곧바로 들어오므로 저장·자동 저장·되돌리기는 그대로다.
    // 소스 보기에서는 표도 원문 그대로다(Obsidian 의 소스 모드처럼): 이상한 파일을 고치는 안전한 길이다.
    liveExtensions.current = () => [livePreview(), tableExtension({ save: () => void api.current.save(), root: shadow })];
    // 링크 누름과 Alt+Enter 가 함께 쓰는 길(늘 최신 prop 을 부른다).
    const linkDeps: LinkOpenDeps = {
      notePath: () => path,
      onOpen: (target) => latest.current.onOpenLink?.(target),
      toast: (message) => notify('info', message),
      reveal: (line) => handle.reveal({ line }),
    };
    // 위키링크 완성이 읽는 링크 색인. 색인이 준비되기 전에는 null(반쪽 목록을 내지 않는다). 파일·링크 판이 같으면 다시 쓴다.
    let snap: { files: number; links: number; value: ReturnType<WikiCompletionDeps['snapshot']> } | null = null;
    const headingCache = new Map<string, { version: number; items: OutlineItem[] }>();
    const completionDeps: WikiCompletionDeps = {
      notePath: () => path,
      snapshot: () => {
        if (!linkIndex.ready()) return null;
        const files = linkIndex.filesVersion;
        const links = linkIndex.linksVersion;
        if (snap === null || snap.files !== files || snap.links !== links) {
          const all = linkIndex.files();
          const titles = new Map<string, string>();
          for (const f of all) {
            const title = linkIndex.title(f);
            if (title !== undefined) titles.set(f, title);
          }
          snap = { files, links, value: { files: all, aliases: linkIndex.aliases(), titles, resolver: linkIndex.resolver() } };
        }
        return snap.value;
      },
      // 다른 노트의 제목(Task 16): 디스크 본문에서 읽고, 경로와 링크 판(linksVersion)이 같으면 다시 쓴다.
      headings: async (target) => {
        const version = linkIndex.linksVersion;
        const hit = headingCache.get(target);
        if (hit && hit.version === version) return hit.items;
        let items: OutlineItem[];
        try {
          items = extractOutline((await loadDocument(target, latest.current.invoke)).text);
        } catch {
          return []; // 읽지 못한 노트(지워졌거나 잠김): 목록만 비고, 다음 입력에서 다시 읽는다
        }
        headingCache.set(target, { version, items });
        return items;
      },
    };
    // `@` 샘플 완성(D9, D10)이 읽는 것: 노트 경로, 바깥 편집기의 샘플 설정 퍼싯, 앱이 준 SampleEnv(늘 최신 prop).
    const sampleDeps: SampleCompletionDeps = {
      notePath: () => path,
      config: (state) => state.facet(sampleEditorConfig),
      env: () => latest.current.sampleEnv?.(),
    };
    // 상태(확장 포함)는 노트를 채울 때마다 새로 만든다: 되돌리기 기록이 읽기 이전으로 거슬러 가지 못하게.
    extensions.current = (doc) => [
      // 줄 구분자는 파일에서 온 그대로: 섞인 파일에서도 손대지 않은 줄의 바이트가 바뀌지 않는다.
      EditorState.lineSeparator.of(doc ? lineSeparatorOf(doc) : '\n'),
      history(),
      Prec.highest(
        keymap.of([
          {
            key: 'Mod-s',
            preventDefault: true,
            run: () => {
              void api.current.save();
              return true;
            },
          },
          // 표 넣기(머리의 단추와 같다). 잠겨 있으면 insertTable 이 false 를 돌려 아무것도 넣지 않지만, preventDefault 때문에
          // 키는 여기서 처리된 것으로 끝난다(브라우저 기본 동작이나 다른 keymap 으로 넘어가지 않는다).
          // 칸에 포커스가 있을 때는 셀 편집기가 같은 키를 듣고, 잠긴 칸에서도 똑같이 먹는다(commands.ts 의 cellOuterKeys).
          { key: INSERT_TABLE_KEY, preventDefault: true, run: (v) => insertTable(v) },
          // 라이브 미리보기 ↔ 소스 보기. 저장소를 바꾸면 띄워 둔 편집기마다(이 편집기 포함) 아래 구독이 모드 칸을 갈아 끼운다.
          { key: TOGGLE_MODE_KEY, preventDefault: true, run: () => (toggleMode(), true) },
          // 속성 추가(Task 26). 두 모드 모두에서 듣는다(소스 보기에서는 닫는 `---` 앞에 빈 줄을 연다).
          { key: PROPS_ADD_KEY, preventDefault: true, run: (v) => addPropertyCommand(v) },
          // 서식(D10). 두 모드 모두에서 듣는다. 표 칸에서는 아래 cellOuterKeys 로 같은 키가 칸의 셀 편집기에 쓴다.
          ...FORMAT_KEYS.map((f) => ({ key: f.key, preventDefault: true, run: (v: EditorView) => runFormat(v, f) })),
        ]),
      ),
      // 서식 키를 칸 안에서도 듣는다. runFormat 은 바깥 편집기를 받아 그 칸의 셀 편집기에 쓴다(블록 서식은 칸에서 먹기만 한다).
      FORMAT_KEYS.map((f) => cellOuterKeys.of({ key: f.key, run: (outer) => runFormat(outer, f) })),
      // 표 칸 안의 Ctrl+; 는 먹기만 한다: 칸에서 머리말로 뛰지 않고, 브라우저 기본 동작으로도 새지 않는다.
      cellOuterKeys.of({ key: PROPS_ADD_KEY, run: () => true }),
      // 조합 중의 서식 키(compositionend 뒤로 미룬다)와 Ctrl+Alt+C / Ctrl+Alt+T 의 물리 키 대체. 셀 편집기에도 실린다.
      formatExtensions(),
      // 칸에 포커스가 있어도 듣는다. 모드를 바꾸면 표 확장이 빠지면서 셀 편집기가 부서지므로, 셀 편집기의 keydown 처리
      // 안에서 바꾸지 않고 그 처리가 끝난 뒤(마이크로태스크)에 바꾸고 바깥 편집기에 초점을 돌려준다.
      cellOuterKeys.of({
        key: TOGGLE_MODE_KEY,
        run: (outer) => {
          queueMicrotask(() => {
            toggleMode();
            outer.focus();
          });
          return true;
        },
      }),
      // 목록 키(Enter 이어 쓰기, Backspace, Tab/Shift+Tab 들이기·내밀기): 두 모드 모두에서 듣도록 모드 칸 밖에 둔다.
      // 마크다운 언어의 자체 keymap 은 꺼 두었다(markdownSyntax.ts): Enter 처리기는 이것 하나다. 조합 중에는 모두 쉰다.
      Prec.high(keymap.of(LIST_KEYS)),
      // 기본 keymap 의 Alt+←/→(cursorSyntaxLeft/Right)와 Ctrl+Shift+\ 는 뺀다: 앱의 뒤로·앞으로 가기와 오른쪽 사이드바다(App.tsx).
      // 남겨 두면 커서를 옮기며 preventDefault 해 window 의 탐색 처리기가 건너뛴다.
      keymap.of([...defaultKeymap.filter((b) => !NAV_KEYS.has(b.key ?? '')), ...historyKeymap]),
      labnoteMarkdown(),
      // AI 초안 검토 표시: 두 모드 모두에서, 파일에는 쓰지 않는다(live/aiDraftReview.ts).
      aiDraftReview(),
      // 자동 완성: 두 모드 모두에서 되도록 모드 칸 밖에 둔다. 마크다운 언어의 HTML 태그 완성은 꺼 두었다(markdownSyntax.ts).
      // `[[` 뒤의 노트·별칭·제목·(`![[` 뒤) 이미지 완성. 조합 중에도 목록은 열려 거르지만, 받아들이기는 조합이 끝난 뒤에만 한다
      // (completionGuards: 조합 중 Enter/Tab 은 IME 몫, compositionend 뒤 `[[`·`@` 안이면 목록을 다시 연다).
      autocompletion({ override: [wikiCompletionSource(completionDeps), sampleCompletionSource(sampleDeps)], icons: false, optionClass: sampleOptionClass }),
      completionGuards([wikiReopen, sampleReopen]),
      // 동작 줄(새 ID 생성 등)의 결과를 기다리는 트리거 범위. 기다리는 동안의 모든 변경에 따라 옮긴다(D9).
      pendingSampleInsert,
      // 표 칸 편집기에도 같은 완성을 싣는다. 칸 안에서는 별칭 구분자 앞에 백슬래시를 붙이고(inTable), 목록이 열린 동안의
      // Enter·Tab·위아래·Escape 는 칸 이동 대신 완성 목록이 받는다(cellEditor.ts 의 keys()).
      cellExtras.of([
        autocompletion({ override: [wikiCompletionSource(completionDeps), sampleCompletionSource(sampleDeps)], icons: false, optionClass: sampleOptionClass }),
        completionGuards([wikiReopen, sampleReopen]),
        pendingSampleInsert,
      ]),
      // 샘플 ID 강조(D7): 셀 편집기에도 싣는다(바깥 편집기의 설정과 노트 경로를 읽는다).
      cellExtras.of(sampleHighlight),
      mode.current.of(modeRef.current === 'live' ? liveExtensions.current() : []),
      // 링크 풀이: 모드 칸 밖에 두어 모드를 바꿔도 남는다. 조합 중에 미룬 값은 resolutionFlusher 가 조합이 끝난 뒤 넣는다.
      resolutionSlot.current.of(linkResolution.of(resolutionRef.current)),
      // 샘플 설정 칸과 강조(D7, D8): 모드 칸 밖이라 두 모드 모두에서 그린다. 조합 중에 미룬 칸은 reconfigureFlusher 가
      // 조합이 끝난 뒤 한 거래로 모두 넣는다(링크 풀이 칸과 같은 flusher).
      samplesSlot.current.of(sampleEditorConfig.of(samplesRef.current)),
      sampleNotePath.of(path),
      sampleHighlight,
      reconfigureFlusher,
      // 이미지 위젯이 읽는 노트 경로와 이미지 묶음(경로는 이 노트 기준으로 푼다). 소스 보기에서는 쓰는 것이 없다.
      imageLoader.of({ notePath: path, images }),
      // 속성 격자가 앱에 넘기는 일(상태 칩 → 앱의 상태 명령, 머리말 링크 → 앱의 링크 열기). 늘 최신 prop 을 부른다.
      propertiesActions.of({
        onChangeStatus: () => latest.current.onChangeStatus?.(),
        onOpenLink: (target) => latest.current.onOpenLink?.(target),
      }),
      // 실험 README(Task 19): 빈 체크리스트 카드의 "첫 워크플로 추가"와 체크 뒤의 상태 권유. 늘 최신 prop 을 부른다.
      readmeEmptyState.of(latest.current.onAddWorkflow ? { onAddWorkflow: () => latest.current.onAddWorkflow?.() } : null),
      latest.current.onChecklistTick ? checklistTickWatch((prev, next) => latest.current.onChecklistTick?.(prev, next)) : [],
      // 그림·첨부 붙여 넣기·끌어 놓기(Task 17) → 실험의 resources/(그림은 설정에 따라 노트 폴더의 images/)에 새 파일 + 링크.
      // 두 모드 모두에서 되도록 모드 칸 밖에 둔다. 쓴 뒤에는 pasteImages 가 이름 색인을 버리고(isUnique 가 새 파일을 보게)
      // 이름만 넣을지 경로를 넣을지 정한다.
      pasteImages({
        // 감시자는 새 이미지를 알리지 않는다(D1): 쓴 경로를 링크 색인에 바로 넣어 `![[이름]]` 이 풀리게 한다.
        write: async (dir, name, bytes) => {
          const written = await writeVaultImage(dir, name, bytes, latest.current.invoke as unknown as RawInvoke);
          linkIndex.addFiles([written]);
          return written;
        },
        writeAttachment: (dir, name, bytes) => writeVaultAttachment(dir, name, bytes, latest.current.invoke as unknown as RawInvoke),
        // 첨부 이름이 보관함에서 하나뿐인가: 파일 트리(vault_tree, 첨부도 싣는다)에서 같은 이름(대소문자 무시)을 센다
        isUniqueAttachment: async (name) => {
          const want = name.toLowerCase();
          const entries = await latest.current.invoke<{ path: string; isDir: boolean }[]>('vault_tree', {});
          return entries.filter((e) => !e.isDir && e.path.slice(e.path.lastIndexOf('/') + 1).toLowerCase() === want).length === 1;
        },
        imageFolder: () => latest.current.imageFolder,
        reveal: (p) => void revealInFolder(p, latest.current.invoke).catch(() => {}),
      }),
      editorTheme,
      // 섞인 줄바꿈 파일의 소수 쪽 줄 끝(CR 또는 LF)이 눈에 보이는 기호로 나온다 — 줄바꿈처럼 보이는데 줄이 아닌 것이 되지 않게.
      highlightSpecialChars(),
      EditorView.lineWrapping,
      label.current.of(labelAttrs()),
      // 본문의 오른쪽 클릭 → 앱 메뉴. 표 위젯은 ignoreEvent 가 true 라 여기로 오지 않는다. 그래도 표 틀 안의 사건은
      // 한 번 더 걸러 낸다(표 메뉴만 뜨게).
      EditorView.domEventHandlers({
        contextmenu: (e, view) => {
          const handler = latest.current.onContextMenu;
          if (!handler) return false;
          if (e.composedPath().some((n) => n instanceof Element && n.classList.contains('lno-table-wrap'))) return false;
          // 키보드로 연 메뉴는 좌표가 (0, 0) 이다: 커서를 그대로 둔다
          const fromKeyboard = e.clientX === 0 && e.clientY === 0;
          const at = fromKeyboard ? null : view.posAtCoords({ x: e.clientX, y: e.clientY });
          const sel = view.state.selection.main;
          if (at !== null && (sel.empty || at < sel.from || at > sel.to)) view.dispatch({ selection: { anchor: at } });
          handler(e, view);
          return e.defaultPrevented;
        },
      }),
      // 링크 누름(SP4 D4): 렌더된 링크는 그냥 클릭, 두 모드 모두 Ctrl(맥은 Cmd)+클릭, 커서 아래 링크는 Alt+Enter.
      // 노트·만들기·바깥 주소는 앱이 열고(onOpenLink), 이 노트 안의 제목·앵커는 편집기가 직접 옮긴다. 모드 칸 밖에 둔다.
      linkClickHandler(linkDeps),
      keymap.of([{ key: 'Alt-Enter', run: followLinkAtCursor(linkDeps) }]),
      lock.current.of(locked.current ? LOCKED : []),
      // 샘플 동기화(D12): 본문이 바뀔 때마다 이 노트의 `{Type}.json` 쓰기를 800 ms 미룬다. 모드 칸 밖이라 두 모드 모두에서 듣는다.
      // 표 칸 편집기에는 싣지 않는다: 칸의 변경은 바깥 편집기의 변경으로 다시 온다. 조합 중이면 때가 되어도 다시 미룬다.
      // 정렬이 꺼진 워크플로 노트에서 UO 블록을 지우면 그 목록 항목도 같은 트랜잭션에서 뺀다(한 번 되돌리기로 함께 돌아온다).
      EditorState.transactionFilter.of((tr) => {
        try {
          const extra = latest.current.upkeep?.filter(path, tr);
          return extra ? [tr, extra] : tr;
        } catch (err) {
          console.warn('[labnoteo] unit-op list prune failed:', err);
          return tr;
        }
      }),
      EditorView.updateListener.of((u) => {
        if (!u.docChanged) return;
        latest.current.upkeep?.observe(path, u);
        samplesSync.touch(path, u.view);
        // 노트 ID 색인(SP7 A5): 랩 노트를 고친 뒤 2 초 조용하면 그 노트의 labnote_id 를 다시 읽는다(조합 중에는 읽지 않는다).
        noteIdTouch(path, u.view);
      }),
      EditorView.updateListener.of((u) => {
        // 선택 없이 위쪽 줄이 바뀌어도 커서의 줄 번호는 움직인다(한 프레임에 한 번)
        if (u.selectionSet || u.docChanged) publishCursorLine();
        if (!u.docChanged) {
          // 조합 중이라 미뤄 둔 링크 덧씌움: 조합이 끝난 첫 갱신에서 낸다
          if (linksPending.current && !u.view.composing) publishLinks();
          return;
        }
        clearTimeout(outlineTimer.current);
        outlineTimer.current = setTimeout(publishItems, OUTLINE_MS);
        clearTimeout(linksTimer.current);
        linksTimer.current = setTimeout(publishLinks, LINKS_MS);
        const dirty = api.current.isDirty();
        setDirty(dirty);
        if (!dirty) setCloseAsk(false); // 되돌려서 깨끗해졌다: 저장 안 된 편집 때문에 던진 질문은 거둔다
        api.current.scheduleAutosave();
      }),
    ];
    const view = new EditorView({
      parent: shadow,
      root: shadow,
      state: EditorState.create({ doc: '', extensions: extensions.current(undefined) }),
    });
    viewRef.current = view;
    alive.current = true;
    // 모드가 바뀌면(이 편집기의 Ctrl+E, 다른 편집기, 명령) 모드 칸만 갈아 끼운다: 본문과 되돌리기 기록은 그대로다.
    const unsubscribeMode = subscribeMode((m) => {
      modeRef.current = m;
      setModeState(m);
      view.dispatch({ effects: mode.current.reconfigure(m === 'live' ? liveExtensions.current() : []) });
    });
    // 링크 색인을 따른다: 파일 목록(filesVersion)이나 준비 상태가 바뀐 알림에서만 새 풀이를 만든다. linksVersion 만 바뀐 알림
    // (타이핑, 덧씌움, 다른 노트의 본문)은 아무것도 하지 않는다.
    let seenFiles = -1;
    let seenReady = false;
    const refreshResolution = (): boolean => {
      const files = linkIndex.filesVersion;
      const ready = linkIndex.ready();
      if (files === seenFiles && ready === seenReady) return false;
      seenFiles = files;
      seenReady = ready;
      if (!ready) {
        resolutionRef.current = null;
        return true;
      }
      const r = linkIndex.resolver();
      resolutionRef.current = { version: files, resolveWiki: r.resolveWiki, resolveMd: r.resolveMd, isUnknownTarget: r.isUnknownTarget };
      return true;
    };
    refreshResolution();
    if (resolutionRef.current !== null) view.dispatch({ effects: resolutionSlot.current.reconfigure(linkResolution.of(resolutionRef.current)) });
    const unsubscribeLinks = linkIndex.subscribe(() => {
      if (alive.current && refreshResolution()) scheduleResolution(view, resolutionSlot.current, resolutionRef.current);
    });
    const unregister = registerOpenNote(path, handle);
    loadDocument(path, invoke).then(
      (doc) => {
        if (!live) return;
        api.current.adopt(doc);
        setStatus('ready');
        const at = firstReveal.current;
        firstReveal.current = undefined;
        if (at) handle.reveal(at);
      },
      () => live && setStatus('error'),
    );
    return () => {
      live = false;
      alive.current = false;
      unregister();
      unsubscribeMode();
      unsubscribeLinks();
      clearTimers();
      clearTimeout(outlineTimer.current);
      clearTimeout(linksTimer.current);
      linksPending.current = false;
      linkIndex.setOverlay(path, null); // 닫힌 노트는 디스크 본문(setNote)으로 돌아간다
      if (cursorFrame.current !== undefined) cancelAnimationFrame(cursorFrame.current);
      cursorFrame.current = undefined;
      clearOutline(path);
      clearEditorStatus(path);
      // 노트를 닫는데 저장 안 된 편집이 있으면 마지막으로 한 번 저장해 본다(충돌이면 쓰지 않는다).
      if (!externalRef.current && api.current.isDirty()) void api.current.save();
      view.destroy();
    };
    // 노트마다 새로 마운트한다(key): path 가 바뀌는 경우는 없다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 샘플 설정이 바뀌면 샘플 칸만 갈아 끼운다(조합 중이면 끝난 뒤에).
  useEffect(() => {
    const next = samples ?? null;
    if (samplesRef.current === next) return;
    samplesRef.current = next;
    const view = viewRef.current;
    if (view) scheduleReconfigure(view, samplesSlot.current, sampleEditorConfig.of(next));
  }, [samples]);

  // 언어가 바뀌면 언어 칸(이름표 + editorLang)만 갈아 끼운다. 글을 그리는 위젯(속성 격자, 표 도구, 체크박스, 칩 …)이 이 값을
  // 보고 제자리에서 다시 그린다. 본문을 바꾸지 않으므로 저장 안 됨 표시, 자동 저장, 되돌리기 기록, 선택은 움직이지 않는다.
  // 한글 조합 중이면 조합이 끝난 뒤에 바꾼다(조합 중의 다시 그리기는 IME 를 깬다).
  // 비교는 마지막으로 요청한 언어와 한다(편집기 값이 아니다): 조합 중에 ko→en→ko 로 바뀌면 미뤄 둔 en 을 ko 가 덮어써야 한다.
  const requestedLang = useRef(lang);
  useEffect(() => {
    const view = viewRef.current;
    if (requestedLang.current === lang) return;
    requestedLang.current = lang;
    // 편집기가 아직 없으면 새로 만들 때 지금 언어(labelAttrs)로 만든다.
    if (view) scheduleReconfigure(view, label.current, labelAttrs());
  }, [lang]);

  // 대화상자가 열려 있는 동안, 그리고 읽기가 끝나기 전에는 편집을 막는다: 사용자가 결정하는 내용이 바뀌지 않게.
  useEffect(() => {
    locked.current = status !== 'ready' || dialogOpen;
    viewRef.current?.dispatch({ effects: lock.current.reconfigure(locked.current ? LOCKED : []) });
  }, [status, dialogOpen]);

  // 대화상자가 닫히면 열 때의 초점 자리로 돌려준다. 위의 잠금 effect 가 먼저 돌아 편집 영역은 이미 다시 편집할 수 있다.
  useEffect(() => {
    if (dialogOpen || !restoreFocus.current) return;
    const restore = restoreFocus.current;
    restoreFocus.current = null;
    restore();
  }, [dialogOpen]);

  // 밖에서 바뀜: 이 노트나 이 노트를 담은 폴더가 바뀌었거나, 무엇이 바뀌었는지 놓쳤다(빈 경로).
  useEffect(() => {
    let live = true;
    let unlisten: (() => void) | undefined;
    listen(VAULT_CHANGED, (e) => {
      const p = e.payload.path;
      if (live && (p === '' || p === path || path.startsWith(`${p}/`))) api.current.queueCheck();
    }).then(
      (fn) => (live ? (unlisten = fn) : fn()),
      () => undefined,
    );
    return () => {
      live = false;
      unlisten?.();
    };
  }, [path, listen]);

  // 창을 닫을 때: 저장 안 된 편집이 있으면 저장한 뒤에 닫는다. 이 가드는 항상 켜져 있다 — 닫기 요청마다 다시 검사한다.
  // 저장하지 못하면(충돌 등) 닫지 않고, 저장하지 않고 닫을지 명시적으로 묻는다. 그 편집이 유일한 사본일 수 있다.
  useEffect(() => {
    let live = true;
    let unlisten: (() => void) | undefined;
    try {
      win.current = windowApi ?? (getCurrentWindow() as unknown as WindowApi);
    } catch {
      return; // 창 API 가 없는 환경(테스트 등)
    }
    const w = win.current;
    w.onCloseRequested(async (ev) => {
      if (!api.current.isDirty()) return; // 잃을 것이 없다: 기본 동작대로 닫힌다
      ev.preventDefault();
      // flush() 는 지금은 자기 실패를 직접 잡는다. 그래도 거부되면 이 핸들러가 죽어 창이 닫히지도 묻지도 않는다 —
      // 닫기 버튼이 아무 말 없이 먹통이 된다. 던진 저장은 저장되지 않은 것이므로 묻는다.
      let saved = false;
      try {
        saved = await api.current.flush();
      } catch {
        saved = false;
      }
      if (saved) await w.destroy();
      else setCloseAsk(true);
    }).then(
      (fn) => (live ? (unlisten = fn) : fn()),
      () => undefined,
    );
    return () => {
      live = false;
      unlisten?.();
    };
  }, [windowApi]);

  const gone = external?.kind === 'gone';
  // 편집기가 잠긴 동안(읽기 전, 대화상자가 열린 동안)에는 표 넣기 단추도 꺼진다
  const editLocked = status !== 'ready' || dialogOpen;
  // 명령 단추는 바깥 변경이 풀리지 않은 동안에도 쉰다("그대로 두기" 뒤 포함): 명령은 그 노트를 고치지 않는다(NoteBusyError)
  const commandsBusy = editLocked || external !== null;
  const liveMode = modeState === 'live';
  const modeLabel = t(liveMode ? 'editor.mode.live' : 'editor.mode.source');
  // 상태 줄의 저장 표시: 읽는 중, 바깥 변경(충돌), 저장 실패, 저장 중, 저장 안 됨, 저장됨 순으로 앞선 것.
  const saveState: SaveState =
    status !== 'ready' ? 'loading' : external ? 'conflict' : saveError ? 'error' : saving ? 'saving' : dirty ? 'dirty' : 'saved';
  useEffect(() => publishEditorStatus(path, { save: saveState }), [path, saveState]);
  return (
    <section className="editor-view" data-path={path} aria-label={t('editor.label')}>
      <ViewHeader
        lead={headerLead}
        actions={
          <>
            {headerActions?.(commandsBusy)}
            <button
              type="button"
              className="btn"
              title={t('ribbon.withKey', t('table.insert'), 'Ctrl+Alt+T')}
              data-command-id="editor.insert.table"
              disabled={editLocked}
              onClick={() => {
                const view = viewRef.current;
                if (view) insertTable(view);
              }}
            >
              <Icon name="table" />
              <span className="btn-label-collapsible">{t('table.insert')}</span>
            </button>
            {headerTools?.(commandsBusy)}
            <button
              type="button"
              className="ibtn editor-mode"
              aria-label={modeLabel}
              title={t('header.mode', modeLabel, 'Ctrl+E')}
              aria-keyshortcuts="Control+E"
              data-command-id="editor-toggle-source"
              onClick={() => toggleMode()}
            >
              <Icon name={liveMode ? 'book-open' : 'code'} />
            </button>
            {headerTrail}
          </>
        }
      />
      {status === 'loading' && <p>{t('editor.loading')}</p>}
      {status === 'error' && <p role="alert">{t('editor.loadError')}</p>}
      {saveError && <p role="alert">{t('editor.saveError')}</p>}
      {closeAsk && (
        <p role="alert">
          {t('editor.closeAsk.body')}{' '}
          <button type="button" onClick={() => void win.current?.destroy()}>
            {t('editor.closeAsk.discard')}
          </button>{' '}
          <button type="button" onClick={() => setCloseAsk(false)}>
            {t('editor.closeAsk.stay')}
          </button>
        </p>
      )}
      <div ref={host} className="editor-frame" hidden={status !== 'ready'} />
      {dialogOpen && external && (
        <div
          className="dialog"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="editor-ext-title"
          aria-describedby="editor-ext-body"
          onKeyDown={(e) => e.key === 'Escape' && setDialogOpen(false)}
        >
          <h2 id="editor-ext-title">{t(gone ? 'editor.gone.title' : 'editor.changed.title')}</h2>
          <p id="editor-ext-body">{t(gone ? 'editor.gone.body' : 'editor.changed.body')}</p>
          <div className="dialog-actions">
            {!gone && (
              <button type="button" onClick={() => void api.current.reload()}>
                {t('editor.changed.reload')}
              </button>
            )}
            <button
              type="button"
              onClick={() => void api.current.save({ against: external.kind === 'changed' ? external.current : '' })}
            >
              {t(gone ? 'editor.gone.recreate' : 'editor.changed.overwrite')}
            </button>
            <button type="button" className="primary" autoFocus onClick={() => setDialogOpen(false)}>
              {t('editor.keep')}
            </button>
          </div>
        </div>
      )}
    </section>
  );
});
