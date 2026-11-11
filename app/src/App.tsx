import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { t } from './i18n/t';
import { FirstRun } from './onboarding/FirstRun';
import { useVault, type VaultInfo } from './vault/useVault';
import { useVaultEvents } from './vault/useVaultEvents';
import { vaultImages } from './editor/live/vaultImages';
import { NoteTree } from './tree/NoteTree';
import { newNoteDialog } from './tree/NewNoteDialog';
import { useTree, visibleEntries } from './tree/useTree';
import { fileKind, isNotePath, type FileKind } from './labnote/panel/treeIcons';
import { FileCard } from './viewers/FileCard';
import { CsvViewer } from './viewers/CsvViewer';
import { ImageViewer } from './viewers/ImageViewer';
import { viewerFor } from './viewers/viewerFor';
import { SearchPanel } from './search/SearchPanel';
import { rebuildIndex } from './search/indexApi';
import { useLinkIndex } from './links/useLinkIndex';
import { linkIndex } from './links/linkIndex';
import { linkJournal } from './links/journal';
import { recoverJournal } from './links/undoRename';
import { handleOpenLink } from './links/createFromLink';
import { openExternal, tauriExternalDeps } from './links/openExternal';
import { Editor, type EditorHandle } from './editor/Editor';
import { followLink, linkAt, type OpenTarget } from './editor/live/links';
import type { EditorView } from '@codemirror/view';
import { fetchAppVersion } from './appVersion';
import { UpdateButton } from './update/UpdateButton';
import { startUpdateChecks } from './update/updateStore';
import { ThemeToggle } from './theme/ThemeToggle';
import { chooseTheme, useTheme, type Theme } from './theme/useTheme';
import { LanguageToggle } from './i18n/LanguageToggle';
import { applyHtmlLang, getLang, setLang } from './i18n/lang';
import { useLang } from './i18n/useLang';
import { useVaultSettings } from './labnote/settings';
import { offerPluginLlmKey } from './integrations/importLlmKey';
import { integrationDepsFor } from './integrations/IntegrationSettingsDialog';
import { applySampleSettings, pickSampleSettings } from './samples/SampleSettingsDialog';
import { registerLlmProbe } from './ai/llmProbe';
import { useSampleEditorConfig, useSampleStoreWiring } from './samples/useSampleStore';
import { createSampleEnv } from './samples/env';
import { wireSampleFollowUps } from './samples/followUps';
import { installSampleActionRunners } from './samples/actionRunners';
import { registerSampleSources } from './samples/sources';
import { samplesSync, setSampleSyncEnv } from './samples/sync';
import { noteSyncEnv, startPartbank } from './partbank/partbankApp';
import { TauriLabnoteFs } from './fs/tauriLabnoteFs';
import { createAppHost } from './labnote/host/createAppHost';
import { DialogLayer, PET_LAYER_ID } from './labnote/host/DialogLayer';
import { Toaster } from './labnote/host/Toaster';
import { closeAllDialogs } from './labnote/host/dialogStore';
import { clearToasts, notify as notifyToast } from './labnote/host/toastStore';
import { startMcpForVault } from './labnote/mcp/commands';
import { cancelAllRequests } from './integrations/netIpc';
import { startBfworkflow } from './bfworkflow/bfwApp';
import { editorAwareFs } from './labnote/editorAwareFs';
import { activeEditTarget, flushAllNotes, openNote as openEditor } from './labnote/openNotes';
import { registerAllCommands } from './labnote/commands/registerAll';
import { commandById } from './labnote/commands/registry';
import { runCommand } from './labnote/commands/runCommand';
import { createWorkflow, isExperimentReadme, offerWorkflowDoneNudge, readWorkflowTick, toggleWorkflowDone } from './labnote/commands/workflow';
import { isValidWorkflowPath } from '@labnoteo/core/lib/workflowStructure';
import { createUpkeep, setAppUpkeep } from './labnote/commands/autoUpkeep';
import { offerStatusNudge, type ChecklistCounts } from './labnote/commands/statusNudge';
import { findCommand, registerAllAppCommands } from './editor/commands/appCommands';
import { catalogNoticeOnOpen } from './labnote/commands/catalogs';
import { githubActions } from './github/commands';
import { githubNoticeOnOpen, onceForThisVault } from './github/startupNotice';
import { clearGithubStatuses, scheduleGithubStatusRefresh } from './github/statusStore';
import { legacyNotesOfferOnOpen } from './labnote/commands/legacyConvert';
import { useCommandContext, useNoteSwitcher } from './labnote/commands/useCommandContext';
import { usePaletteHotkey } from './labnote/ui/CommandPalette';
import { ContextMenu } from './labnote/ui/ContextMenu';
import { closeMenu, openMenu } from './labnote/ui/menuStore';
import { EditorActions, NoteQrButton } from './labnote/ui/EditorActions';
import { editorMenu, noteTreeMenu, viewMoreMenu } from './labnote/menus';
import { ExperimentsPanel } from './labnote/panel/ExperimentsPanel';
import { SamplesPanel } from './samples/SamplesPanel';
import { OutlinePanel } from './editor/outline/OutlinePanel';
import { LinksPanel } from './links/LinksPanel';
import { createFromLink } from './links/createFromLink';
import { NavHistory, type NavEntry } from './links/navHistory';
import { renameEvents } from './links/renameWithLinks';
import { deleteEvents, newFolder } from './labnote/commands/fileOps';
import { currentDialog } from './labnote/host/dialogStore';
import { subscribeVaultChanges, type ListenFn } from './vault/useVaultEvents';
import { useVaultChanges } from './labnote/panel/useVaultChanges';
import { listen as tauriListen } from '@tauri-apps/api/event';
import { vaultCreatedTimes } from './fs/vaultImage';
import { NoteIdIndex, currentNoteIdIndex, setNoteIdIndex } from './labnote/barcode/noteIdIndex';
import { appNoteIdSource } from './labnote/barcode/noteIdSource';
import { cancelNoteIdTouches, notifyingRun, startIdWatch } from './labnote/barcode/idWatch';
import { startScan } from './labnote/scan/commands';
import { NoteIdService } from './labnote/port/noteIdService';
import { unsolicitedHost } from './labnote/host/whenNotComposing';
import { Ribbon } from './ui/Ribbon';
import { PetLayer } from './assistant/PetLayer';
import { openAssistant, toggleAssistant } from './assistant/commands';
import { bubbleActions, connectAssistant } from './assistant/wiring';
import { EmptyState } from './ui/EmptyState';
import { Dock } from './ui/Dock';
import { RightDock } from './ui/RightDock';
import { VaultBar } from './ui/VaultBar';
import { layoutStore, useLayout, type LeftTab, type RightTab } from './ui/layoutStore';
import { setWindowTitle } from './ui/windowTitle';
import { shellShortcut } from './ui/shellKeys';
import { NavButtons, ViewHeader } from './ui/ViewHeader';
import { NoteLead } from './ui/Breadcrumb';
import { StatusBar } from './ui/StatusBar';
import { AppearanceButton } from './ui/AppearancePopover';
import { Icon } from './ui/Icon';
import { openSettings as openSettingsModal, setSettingsSource } from './ui/SettingsModal';

/** 명령(showPanel)이 부르는 이름. 'workflows' 는 플러그인의 워크플로 뷰라 왼쪽 독의 실험 탭으로 간다. */
type PanelName = 'files' | 'workflows' | 'samples' | 'outline' | 'links';

/** 마우스의 뒤로(3)·앞으로(4) 단추. */
const MOUSE_BACK = 3;
const MOUSE_FORWARD = 4;

/** Alt+←/→ 만(다른 수식 키 없이, 한글 조합 중이 아닐 때). 뒤로면 'back', 앞으로면 'forward'. */
function navKey(e: globalThis.KeyboardEvent): 'back' | 'forward' | undefined {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.isComposing || e.keyCode === 229) return undefined;
  return e.key === 'ArrowLeft' ? 'back' : e.key === 'ArrowRight' ? 'forward' : undefined;
}

/**
 * 왼쪽 독의 탭은 앱 전체에서 하나(layoutStore, ui.json)다. 이 표시는 보관함마다 "탭을 고른 적이 있다"만 적는다(이 PC 의 브라우저
 * 저장소): 고른 적 없는 보관함에 labnote/ 폴더가 있으면 처음 열 때 실험 탭을 보인다. 읽거나 쓰지 못하면 아무것도 바꾸지 않는다.
 */
const tabKey = (root: string) => `labnoteo-sidebar-tab:${root}`;

function tabChosen(root: string): boolean {
  try {
    return localStorage.getItem(tabKey(root)) !== null;
  } catch {
    return true;
  }
}

function markTabChosen(root: string, tab: string): void {
  try {
    localStorage.setItem(tabKey(root), tab);
  } catch {
    // 저장소가 막혀 있다: 표시 없이 지나간다
  }
}

interface ViewProps {
  vault: VaultInfo;
  version: string;
  onChangeVault: () => void;
  theme: Theme;
  setTheme: (theme: Theme) => void;
}

function VaultView({ vault, version, onChangeVault, theme, setTheme }: ViewProps) {
  const { entries, failed, reload } = useTree(vault.root);
  // 보관함 밖에서 파일이 바뀌면(git pull, 동기화, Obsidian, 탐색기) 트리를 다시 읽는다. 색인은 Rust 가 같은 변경으로 갱신한다.
  useVaultEvents(reload);
  const editor = useRef<EditorHandle>(null);
  const shell = useRef<HTMLDivElement>(null);
  // 저장 안 된 편집이 있으면 먼저 저장한다. 저장하지 못하면(충돌 등) 노트를 바꾸지 않는다 — 편집이 사라지지 않게.
  const notes = useNoteSwitcher(editor);
  const { selected, closeActive } = notes;
  // 뒤로·앞으로 가기(SP4 Task 28, D4): 보관함마다 하나(VaultView 는 보관함마다 새로 마운트된다).
  // 링크, 링크 탭, 팔레트의 명령, 파일 트리, 검색이 여는 노트는 모두 아래 openFile(=navigate)을 지난다.
  const nav = useRef<NavHistory>();
  nav.current ??= new NavHistory();
  // 노트가 아닌 파일(그림, 표, 그 밖의 첨부)을 보고 있으면 그 경로와 종류. 편집기는 그동안 뒤에 숨어 있다(편집은 그대로 남는다).
  const [viewing, setViewing] = useState<{ path: string; kind: FileKind }>();
  // 기록이 바뀌면 보기 머리의 뒤로·앞으로 단추를 다시 그린다.
  const [, setNavTick] = useState(0);
  const navFns = useRef({
    changed: () => setNavTick((n) => n + 1),
    /** 지금 노트와 커서 줄. 열린 노트가 없으면 undefined. */
    here(): NavEntry | undefined {
      const path = notes.activePath();
      if (path === undefined) return undefined;
      const view = editor.current?.view();
      return { path, line: view ? view.state.doc.lineAt(view.state.selection.main.head).number - 1 : 0 };
    },
    /** 노트를 연다. 다른 노트로 넘어갔으면 떠난 자리를 기록에 쌓는다(저장하지 못해 넘어가지 않았으면 쌓지 않는다). */
    /** 한글 조합 중(창 전체에서 compositionstart 와 compositionend 사이). 조합 중에는 기록을 따라가지 않는다. */
    composing: false,
    /**
     * 편집기 안의 입력(Properties 격자 등)에 쳐 두고 아직 적지 않은 값을 적는다: 그런 입력은 Enter 나 blur 에서만 적고,
     * 노트를 바꾸면 떼어 낸 입력의 blur 는 아무것도 적지 않는다. 가장 깊은 초점(그림자 DOM 안까지)을 blur 한다.
     */
    commitPending(): void {
      let el: Element | null = document.activeElement;
      while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
      const dom = editor.current?.view()?.dom;
      if (!el || !dom?.contains(el) || !(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) return;
      el.blur();
    },
    async navigate(path: string, at?: { line: number; ch?: number }): Promise<void> {
      // 노트가 아닌 파일은 텍스트로 읽지 않는다: 본문에 파일 카드를 보인다(기록에는 쌓지 않는다)
      if (!isNotePath(path)) {
        setViewing({ path, kind: fileKind(path) });
        return;
      }
      setViewing(undefined);
      navFns.commitPending();
      const from = navFns.here();
      await notes.openFile(path, at);
      if (from && notes.activePath() !== from.path) nav.current!.push(from);
      navFns.changed();
    },
    busy: false,
    /** 기록을 따라 연다. 지금 노트를 저장하지 못해 넘어가지 않았으면 기록을 되돌린다. */
    async go(dir: 'back' | 'forward'): Promise<void> {
      // 조합 중이면 가지 않는다: 떼어 낸 입력은 조합이 끝난 글을 적지 못한다(Alt+←/→ 는 navKey 가 이미 거른다)
      if (navFns.busy || navFns.composing) return;
      navFns.busy = true;
      try {
        navFns.commitPending();
        const history = nav.current!;
        const from = navFns.here();
        const to = dir === 'back' ? history.back(from) : history.forward(from);
        if (!to) return;
        setViewing(undefined);
        const same = from !== undefined && (to.path === from.path || (editor.current !== null && openEditor(to.path) === editor.current));
        await notes.openFile(to.path, { line: to.line });
        if (from && !same && notes.activePath() === from.path) {
          if (dir === 'back') history.forward(to);
          else history.back(to);
        }
      } finally {
        navFns.busy = false;
        navFns.changed();
      }
    },
  }).current;
  const openFile = navFns.navigate;
  // Alt+←/→ 는 편집기 밖에서도 듣는다(편집기의 키는 그림자 DOM 을 지나 window 까지 온다. CodeMirror 기본 keymap 은
  // Alt+←/→ 를 cursorSyntaxLeft/Right 에 묶지만 Editor.tsx 가 그 둘을 뺀다). 마우스 단추는 mousedown 의 기본 동작(브라우저의 뒤로 가기)을 막고 mouseup 에서 간다.
  useEffect(() => {
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      const dir = navKey(e);
      if (!dir || e.defaultPrevented || currentDialog() !== null) return;
      e.preventDefault();
      void navFns.go(dir);
    };
    const onMouseDown = (e: MouseEvent) => {
      if (e.button === MOUSE_BACK || e.button === MOUSE_FORWARD) e.preventDefault();
    };
    const onMouseUp = (e: MouseEvent) => {
      if (e.button !== MOUSE_BACK && e.button !== MOUSE_FORWARD) return;
      e.preventDefault();
      if (currentDialog() !== null) return;
      void navFns.go(e.button === MOUSE_BACK ? 'back' : 'forward');
    };
    // 조합 사건은 그림자 DOM 을 지나 window 까지 온다. 조합이 끝났다는 알림 없이 초점이 옮겨 가면(입력을 떼어 냈다) 푼다.
    const onCompositionStart = () => (navFns.composing = true);
    const onCompositionEnd = () => (navFns.composing = false);
    window.addEventListener('compositionstart', onCompositionStart, true);
    window.addEventListener('compositionend', onCompositionEnd, true);
    window.addEventListener('focusin', onCompositionEnd, true);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup', onMouseUp);
    // 이름 바꾸기는 기록의 경로를 옮기고, 지운 파일·폴더(앱에서든 감시자가 알린 것이든)는 기록에서 뺀다.
    const offRename = renameEvents.subscribe((moves) => {
      nav.current!.rename(moves);
      navFns.changed();
    });
    const offDelete = deleteEvents.subscribe((path) => {
      nav.current!.drop(path);
      navFns.changed();
    });
    const offWatch = subscribeVaultChanges(tauriListen as ListenFn, (change) => {
      if (change.kind !== 'removed' || change.path === '') return;
      const gone = change.path.toLowerCase();
      setViewing((v) => (v && (v.path.toLowerCase() === gone || v.path.toLowerCase().startsWith(`${gone}/`)) ? undefined : v));
      nav.current!.drop(change.path);
      navFns.changed();
    });
    return () => {
      window.removeEventListener('compositionstart', onCompositionStart, true);
      window.removeEventListener('compositionend', onCompositionEnd, true);
      window.removeEventListener('focusin', onCompositionEnd, true);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mouseup', onMouseUp);
      offRename();
      offDelete();
      offWatch();
    };
  }, [navFns]);
  // 화면 배치(왼쪽 독의 탭·너비·숨김, 오른쪽 사이드바): 앱 전체에서 하나, Rust 의 ui.json 이 기준이다.
  const layout = useLayout();
  const tab = layout.leftTab;
  // 파일 탭: 시스템 파일(카탈로그 JSON, 샘플 등록부)은 켜 두었을 때만 보인다. 이름 바꾸기 등은 늘 전체 목록을 쓴다.
  const shownEntries = useMemo(() => visibleEntries(entries, layout.showSystemFiles), [entries, layout.showSystemFiles]);
  const collapseFiles = useRef<() => void>();
  const hasLabnote = entries.some((e) => e.isDir && e.depth === 0 && e.path.toLowerCase() === 'labnote');
  // 탭을 고른 적 없는 보관함에 labnote/ 가 있으면 처음 한 번 실험 탭을 보인다(실험 → 워크플로 → UO 가 이 보관함의 길이다).
  useEffect(() => {
    if (!hasLabnote || tabChosen(vault.root)) return;
    markTabChosen(vault.root, 'experiments');
    layoutStore.update({ leftTab: 'experiments' });
  }, [hasLabnote, vault.root]);
  const showLeft = (next: LeftTab) => {
    markTabChosen(vault.root, next);
    layoutStore.update({ leftTab: next, leftHidden: false });
  };
  const showRight = (next: RightTab) => layoutStore.update({ rightTab: next, rightOpen: true });
  const showPanel = (next: PanelName) => {
    if (next === 'outline' || next === 'links') showRight(next);
    else showLeft(next === 'workflows' ? 'experiments' : next);
  };
  const openNote = (path: string) => openFile(path);
  // 파일 탭에서 펼쳐 보일 경로(실험 탭의 images/·resources/ 줄). seq 는 같은 경로를 다시 골라도 다시 보이게 한다.
  const [fileReveal, setFileReveal] = useState<{ path: string; seq: number }>();
  const revealInFiles = (path: string) => {
    showLeft('files');
    setFileReveal((prev) => ({ path, seq: (prev?.seq ?? 0) + 1 }));
  };
  // 개요에서 제목을 고르면: 열린 편집기면 그 줄로 커서를 옮기고 초점을 편집기로 돌려준다(reveal 이 focus 한다).
  // 열려 있지 않으면(개요가 낡았다) 열면서 그 줄로 간다.
  const onOutlineReveal = (path: string, line0: number) => {
    const handle = openEditor(path);
    if (handle) handle.reveal({ line: line0 });
    else void openFile(path, { line: line0 });
  };
  // 보관함별 설정(앱 설정 폴더에 둔다). 처음 여는 Obsidian 보관함이면 플러그인 설정을 한 번 가져온다.
  const { settings, imported: settingsImported, foundLlmKey, update: updateSettings } = useVaultSettings(vault.root);
  // 명령이 쓰는 호스트: 대화상자, 알림, 열린 노트는 버퍼를 기준으로 하는 파일 시스템, 열린 편집기의 편집 대상.
  const host = useMemo(
    () =>
      createAppHost({
        fs: editorAwareFs(new TauriLabnoteFs()),
        editTarget: () => activeEditTarget(notes.activePath()),
        openFile,
      }),
    // notes 의 함수들은 마운트 동안 같은 객체다
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  // 플러그인 설정을 처음 가져올 때 data.json 에 LLM 키가 있었으면(D9) 자격 증명 관리자에 저장할지 한 번 묻는다.
  // 값은 웹뷰로 오지 않는다: Rust 가 data.json 을 다시 읽어 저장한다. 보관함마다 한 번만 묻는다.
  const llmKeyOffered = useRef<string>();
  useEffect(() => {
    if (!foundLlmKey || llmKeyOffered.current === vault.root) return;
    llmKeyOffered.current = vault.root;
    void offerPluginLlmKey(host);
  }, [foundLlmKey, vault.root, host]);
  // 샘플 저장소(알려진 ID, README 의 sample_tracking)를 이 보관함의 fs 와 설정에 묶고, 대장 JSON 변경과 창 초점을 잇는다.
  useSampleStoreWiring(host.fs, settings);
  // 편집기의 샘플 설정(D8): 저장소 판이나 샘플 설정이 바뀔 때만 새 객체다.
  const sampleConfig = useSampleEditorConfig(settings);
  const ctx = useCommandContext({
    host,
    vaultRoot: vault.root,
    settings,
    updateSettings,
    selected,
    activePath: notes.activePath,
    editor,
    reloadTree: reload,
    openFile,
    closeActive,
    showPanel,
    revealInFiles,
    navigate: (dir) => void navFns.go(dir),
    newNote: () => void newNote(),
    switchVault: () => void switchVault(),
    treeFiles: () => shownEntries.filter((e) => !e.isDir).map((e) => e.path),
  });
  usePaletteHotkey(ctx);
  // 떠 있는 도우미의 대화(assistant 명세 §4.5): 내장 런타임과 압축은 지금 명령 맥락으로 돈다(실행마다 새 AiEnv).
  const assistantCtx = useRef(ctx);
  assistantCtx.current = ctx;
  useEffect(() => connectAssistant(() => assistantCtx.current), []);
  const petActions = useMemo(() => bubbleActions(() => assistantCtx.current), []);
  // 쓰는 동안의 손질(Task 20): last_updated_date 찍기와 저장 때의 UO 목록 맞추기. 보관함마다 새로 만든다(손으로 정한 날짜도 보관함마다).
  const upkeepSettings = useRef(settings);
  upkeepSettings.current = settings;
  const upkeep = useMemo(
    () =>
      createUpkeep({
        fs: host.fs,
        settings: () => ({
          autoUpdateLastUpdated: upkeepSettings.current?.autoUpdateLastUpdated ?? false,
          autoSyncUnitOpToc: upkeepSettings.current?.autoSyncUnitOpToc ?? false,
        }),
        notify: (message) => host.notify('info', message),
      }),
    // vault.root 는 안에서 읽지 않지만 일부러 넣는다: 보관함을 바꾸면 새 upkeep(새 추적기)을 만들어 앞 보관함의 손으로 정한 날짜와 기다리던 편집을 버린다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [host, vault.root],
  );
  useEffect(() => {
    setAppUpkeep(upkeep);
    return () => {
      upkeep.dispose();
      setAppUpkeep(undefined);
    };
  }, [upkeep]);
  // 설정을 다시 켜면 손으로 정한 날짜와 기다리던 편집을 잊는다(플러그인 resetLastUpdatedTracking, #202).
  // 처음 그릴 때나 설정을 처음 읽었을 때(undefined → 값)는 지울 것이 없으니, 읽은 꺼짐 → 켜짐일 때만 부른다.
  const stampOn = settings?.autoUpdateLastUpdated;
  const prevStampOn = useRef(stampOn);
  useEffect(() => {
    if (stampOn === true && prevStampOn.current === false) upkeep.reset();
    prevStampOn.current = stampOn;
  }, [stampOn, upkeep]);
  // 설정 창의 값: 열 때마다 지금 값으로 만든다. 보관함 설정을 읽기 전(ctx 없음)에는 열지 않는다.
  const settingsLive = useRef({ ctx, theme, version });
  settingsLive.current = { ctx, theme, version };
  useEffect(
    () =>
      setSettingsSource(() => {
        const first = settingsLive.current;
        const c = first.ctx;
        if (!c) return undefined;
        const now = () => settingsLive.current.ctx ?? c;
        return {
          theme: () => settingsLive.current.theme,
          setTheme: chooseTheme,
          settings: () => now().settings,
          update: async (patch) => {
            await now().updateSettings(patch);
          },
          version: first.version,
          integrations: integrationDepsFor(c),
          samples: {
            value: () => pickSampleSettings(now().settings),
            apply: (before, after) => applySampleSettings(createSampleEnv(now()), now(), before, after),
          },
        };
      }),
    [],
  );
  // 창 제목: `labnoteO — <보관함>`. 독을 숨겨도 어느 보관함인지 보인다. 보관함을 떠나면 앱 이름만.
  useEffect(() => {
    setWindowTitle(vault.name);
    return () => setWindowTitle(undefined);
  }, [vault.name]);
  // 새 버전 확인(B-R8): 지금, 6시간마다, 오래 떠나 있다 돌아왔을 때. 새 버전은 뒤에서 받고, 상태 줄 맨 앞의 UpdateButton 이 보인다.
  useEffect(() => startUpdateChecks(), []);
  // 저장 때의 샘플 동기화(D12)가 쓸 SampleEnv. 맥락이 바뀌거나 보관함 화면이 내려가면, 기다리던 동기화를 그 맥락으로 먼저 돌린다.
  useEffect(() => {
    // 노트 동기화가 쓴 대장은 partbank 사용처의 재대조를 부르지 않는다(노트는 제 변경으로 간다).
    setSampleSyncEnv(() => ctx && noteSyncEnv(createSampleEnv(ctx)));
    return ctx ? () => void samplesSync.flush() : undefined;
  }, [ctx]);
  // 앱에서 한 이름 바꾸기와 삭제 뒤의 샘플 후속 처리(D14): sources 이름, 대장과 labsamples 되돌리기, 지운 대장 알림.
  useEffect(() => (ctx ? wireSampleFollowUps(() => createSampleEnv(ctx)) : undefined), [ctx]);
  // PartBank(SP6 Task 26): 기능, 카탈로그 저장소, `@` 출처, 연결 시험, 노트 사용처 동기화. 보관함을 바꾸면 모두 거둔다.
  useEffect(() => (ctx ? startPartbank(ctx) : undefined), [ctx]);
  // SP7 Part C: MCP 서버(C6). 보관함마다 웹뷰 호스트가 mcp://call 을 듣고, 설정이 켜져 있으면 서버를 시작한다(실패하면 알리고
  // 설정은 그대로 둔다). 보관함을 바꾸면 기다리는 호출을 끝내고(-32002) 서버를 멈추고 듣기를 그만둔다. 이 효과는 아래
  // closeAllDialogs 효과보다 먼저 선언되어 먼저 정리된다. 페이지 새로 고침은 Rust 가 비운다(Task 34).
  useEffect(() => (ctx ? startMcpForVault(ctx) : undefined), [ctx]);
  // 앱 밖에서 고친 노트(감시자의 변경)도 동기화한다. 지워진 노트는 읽지 못해 아무것도 하지 않는다.
  useVaultChanges((paths) => {
    // 실험 폴더가 밖에서 바뀌면 GitHub 상태 표시(안 올린 변경 수)를 다시 읽는다. 네트워크는 쓰지 않는다.
    if (paths === 'all' || paths.some((p) => p.startsWith('labnote/') || p.includes('/labnote/'))) scheduleGithubStatusRefresh();
    if (paths === 'all') return;
    for (const p of paths) if (p.endsWith('.labnote.md')) samplesSync.touchPath(p);
  });
  // 설정을 읽은 뒤 보관함마다 한 번: 번들 카탈로그가 바뀌었으면 알린다. 여는 것을 막지 않는다(기다리지 않고, 던지지 않는다).
  const catalogNoticed = useRef(false);
  useEffect(() => {
    if (!ctx || catalogNoticed.current) return;
    catalogNoticed.current = true;
    void catalogNoticeOnOpen(ctx);
  }, [ctx]);
  // GitHub(P-R9): 보관함마다 한 번 상태를 새로 읽고(앞 보관함의 것은 버린다), 끝나지 않은 올리기가 있으면 [마저 하기] 알림 하나.
  // 가드는 이 화면의 ref 에 한 번만 만든다: StrictMode 의 효과 두 번 돌기에도 알림은 하나다.
  const githubCtx = useRef(ctx);
  githubCtx.current = ctx;
  const githubNotice = useRef<() => Promise<void>>();
  githubNotice.current ??= onceForThisVault(async () => {
    clearGithubStatuses();
    await githubNoticeOnOpen({
      notify: (kind, message, opts) => githubCtx.current?.host.notify(kind, message, opts),
      finish: (folder) => {
        const c = githubCtx.current;
        return c ? githubActions.finish(c, folder) : undefined;
      },
    });
  });
  useEffect(() => {
    if (ctx) void githubNotice.current?.();
  }, [ctx]);
  // SP7 Part B: 스캔 가져오기(Task 31). 보관함을 열면 ScanFeature 를 놓고 Rust 의 스캔 폴더 감시, 폴더 감시자(30초 폴링),
  // Slack 받은 편지함(90초, 연결을 켠 보관함만), 노트를 따라가는 스캔 옮기기를 시작한다. 보관함을 바꾸면 모두 거두고 해독 워커를 끝낸다.
  // 이 효과는 아래 명령 등록 효과보다 먼저 선언한다: 내려갈 때 정리는 선언 순서로 돌므로 cancelAllRequests 보다 먼저 멈춘다.
  useEffect(() => (ctx ? startScan(ctx) : undefined), [ctx]);
  useEffect(() => {
    registerAllCommands();
    registerSampleSources();
    installSampleActionRunners();
    registerAllAppCommands();
    // 연동 설정의 AI "연결 시험"(Task 28).
    const offLlmProbe = registerLlmProbe();
    // 보관함을 바꾸면 이 보관함의 명령이 띄운 대화상자, 알림(스캔 결과의 Details 같은 동작 단추), 메뉴는 의미가 없다.
    // 이 보관함을 위해 기다리던 네트워크 요청도 모두 취소한다(D11: 보관함 신호가 끊겨 쓰기 전 확인이 멈춘다).
    return () => {
      offLlmProbe();
      closeAllDialogs();
      clearToasts();
      void cancelAllRequests();
      closeMenu();
    };
  }, []);
  const [indexing, setIndexing] = useState(true);
  const [skipped, setSkipped] = useState(0);
  // 이미지 캐시(blob: URL)와 이름 색인은 보관함마다 다르다: 보관함을 열 때와 닫을(바꿀) 때 비운다.
  useEffect(() => {
    vaultImages.clear();
    return () => vaultImages.clear();
  }, [vault.root]);
  // 색인은 캐시다: 보관함을 열 때마다 파일에서 다시 채운다. 실패해도 노트 사용은 막지 않는다.
  // 그 약속은 상태로 남겨 링크 색인이 기다린다(성공이든 실패든 끝난 뒤에 본문을 읽는다).
  const [rebuild, setRebuild] = useState<{ root: string; done: Promise<unknown> }>();
  useEffect(() => {
    let live = true;
    setIndexing(true);
    setSkipped(0);
    setRebuild({
      root: vault.root,
      done: rebuildIndex()
        .then((stats) => live && setSkipped(stats.skipped))
        .catch(() => undefined)
        .then(() => live && setIndexing(false)),
    });
    return () => {
      live = false;
    };
  }, [vault.root]);
  // 링크 색인: 보관함이 바뀌면 비우고, 위 재구성이 끝나면 싣고, 보관함 변경을 따라간다.
  useLinkIndex(vault.root, rebuild?.root === vault.root ? rebuild.done : undefined);
  // 링크 고침 기록(SP4 D15): 보관함마다 한 번, 링크 색인이 준비된 뒤 읽는다. 끊긴 이름 바꾸기는 마칠지 묻고,
  // 끝난 것은 "마지막 이름 바꾸기 되돌리기"를 위해 남긴다. 그다음 예전 형식 노트 제안(한 번 여는 동안 한 번).
  // VaultView 는 보관함마다 새로 마운트된다.
  const recoverCtx = useRef(ctx);
  recoverCtx.current = ctx;
  const hasCtx = ctx !== undefined;
  useEffect(() => {
    if (!hasCtx) return;
    let live = true;
    void linkIndex
      .whenReady()
      .then(() => (live && recoverCtx.current ? recoverJournal(recoverCtx.current, linkJournal) : undefined))
      // 끊긴 이름 바꾸기를 마친 뒤: 예전 형식(.md) 실험 노트가 있으면 .labnote.md 로 바꿀지 묻는다(묻기만 한다).
      .then(() => (live && recoverCtx.current ? legacyNotesOfferOnOpen(recoverCtx.current) : undefined))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [hasCtx]);
  // bfworkflow(SP6 Part C): 보관함마다 키 상태를 읽고 연결 시험을 등록한다. 키를 저장하거나 주소를 바꾸면 명령이 따라 보인다.
  useEffect(() => (hasCtx && recoverCtx.current ? startBfworkflow(recoverCtx.current) : undefined), [hasCtx, vault.root]);
  // SP7 Part A: 노트 ID 색인과 감시(A5, Task 12). 링크 색인이 준비된 뒤(파일 목록이 찬 뒤) 색인을 놓고 첫 빌드를 기다린 다음
  // 중복·바뀐·서식 ID 감시를 시작한다. 감시가 묻는 대화상자는 사용자가 부르지 않은 것이라(A9) 활성 편집기의 조합이 끝나기를
  // 기다리고 처음 500 ms 동안 Enter 와 Space 를 무시한다. 보관함을 바꾸면(VaultView 가 내려가면) 감시를 끊고 색인을 치운다.
  useEffect(() => {
    if (!hasCtx) return;
    let live = true;
    let stop: (() => void) | undefined;
    const index = new NoteIdIndex({
      files: async () => linkIndex.files().filter((p) => p.endsWith('.md')),
      read: (p) => host.fs.read(p),
      ctimes: (paths) => vaultCreatedTimes(paths),
    });
    void linkIndex
      .whenReady()
      .then(async () => {
        if (!live) return;
        setNoteIdIndex(index);
        await index.ready();
        if (!live) return;
        const service = new NoteIdService(
          appNoteIdSource(index, host.fs),
          unsolicitedHost(host, () => recoverCtx.current?.activeView()),
        );
        stop = startIdWatch({ index, service, listen: tauriListen as ListenFn, run: notifyingRun(host) });
      })
      .catch((e: unknown) => console.error('[labnoteo] note-ID index failed:', e));
    return () => {
      live = false;
      stop?.();
      cancelNoteIdTouches();
      if (currentNoteIdIndex() === index) setNoteIdIndex(undefined);
    };
  }, [hasCtx, host]);
  const flush = async () => !editor.current || (await editor.current.flush());
  // 업데이트 설치 전(spec §3.4): 열린 노트 모두와 지금 편집기, 그리고 샘플 동기화를 저장한다. 하나라도 못 하면 설치하지 않는다.
  const flushAll = () => flushAllNotes(editor.current, samplesSync);
  // 새 노트(리본, Ctrl+N, 팔레트): 대화상자에서 이름을 받아 보관함 맨 위에 만들고 연다.
  async function newNote(): Promise<void> {
    if (currentDialog() !== null) return;
    const path = await newNoteDialog(flush);
    if (path === undefined) return;
    reload();
    await openFile(path);
  }
  const switchVault = async () => {
    if (await flush()) onChangeVault();
  };
  // 설정 창(Task 8): Ctrl+,, 보관함 줄의 톱니, 모양 창의 "모든 설정 열기". 실패(샘플 폴더 옮기기 등)는 알림으로 바뀐다.
  const openSettings = () => {
    if (ctx) void runCommand(ctx, () => openSettingsModal());
  };
  // 리본 단추와 셸 단축키는 등록된 명령을 id 로 부른다(Task 12). 보관함 설정을 읽기 전(ctx 없음)에는 설정이 필요 없는
  // 셋(사이드바 둘, 새 노트)만 돈다. 리본은 그동안 나머지 단추를 끈다.
  const runShellCommand = (id: string) => {
    if (ctx) {
      const c = findCommand(id);
      if (c) void runCommand(ctx, c);
      return;
    }
    if (id === 'app.toggleLeft') layoutStore.toggleLeft();
    else if (id === 'app.toggleRight') layoutStore.toggleRight();
    // 어시스턴트 보이기·열기도 보관함 설정 없이 돈다(이 PC 의 ui.json 만 쓴다)
    else if (id === 'assistant.toggleVisible') toggleAssistant(notifyToast);
    else if (id === 'assistant.open') openAssistant();
    else if (id === 'app.newNote') void newNote();
  };
  // 셸 단축키(shellKeys.ts): Ctrl+\ 왼쪽 독, Ctrl+Shift+\ 오른쪽 사이드바, Ctrl+N 새 노트, Ctrl+O 빠른 이동, Ctrl+, 설정,
  // Ctrl+Shift+Y 어시스턴트 열기.
  // 편집기 키는 그림자 DOM 을 지나 window 까지 온다. 대화상자가 열려 있으면 듣지 않는다.
  const shellRun = useRef(runShellCommand);
  shellRun.current = runShellCommand;
  useEffect(() => {
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const id = shellShortcut(e);
      if (!id) return;
      e.preventDefault();
      if (e.repeat || currentDialog() !== null) return;
      shellRun.current(id);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
  // 맥락 메뉴: 항목은 여는 순간 만든다. 명령 맥락이 아직 없으면(설정을 읽는 중) 기본 동작 그대로다.
  const onTreeMenu = ctx
    ? (entry: (typeof entries)[number], anchor: { x: number; y: number } | { element: Element }) =>
        openMenu(ctx, anchor, noteTreeMenu(ctx, entry, entries))
    : undefined;
  // 편집기의 링크 열기(SP4 Task 10): 노트는 subpath/앵커 줄에서 열고, 없는 노트는 만들어 열고, 바깥 주소는 openExternal 로 보낸다.
  // 바깥 주소는 범위를 좁힌 opener 로 시스템 브라우저에서 열고, 열 수 없는 주소는 복사하고 알린다(Task 11).
  const openExternalUrl = (url: string) => openExternal(url, tauriExternalDeps(host.notify));
  // 실패는 알림으로 바꾸고(runCommand), 설정을 읽는 중이면 노트 링크는 그대로 열고 나머지는 안내한다.
  const onOpenLink = (target: OpenTarget) => {
    if (!selected) return;
    void handleOpenLink(ctx, target, selected, openExternalUrl, { openFile, notify: host.notify });
  };
  // 링크 탭(SP4 Task 17): 백링크는 그 줄에서 열고, 나가는 링크의 없는 노트는 열린 노트 기준으로 만든다.
  const onLinksOpen = (path: string, line?: number) => void openFile(path, line === undefined ? undefined : { line });
  const onLinksCreate = (linkpath: string) => {
    if (!ctx || !selected) return;
    void runCommand(ctx, () => createFromLink(ctx, linkpath, selected));
  };
  const onEditorMenu = (e: MouseEvent, view: EditorView) => {
    const path = notes.activePath();
    if (!ctx || !path) return;
    // 커서 아래 링크(오른쪽 클릭은 선택 밖이면 커서를 먼저 옮긴다): 링크 열기는 클릭과 같은 길(followLink)이다.
    const hit = linkAt(view.state, view.state.selection.main.head);
    const link = hit
      ? {
          hit,
          text: view.state.sliceDoc(hit.from, hit.to),
          open: () =>
            followLink(view, hit, {
              notePath: () => path,
              onOpen: onOpenLink,
              reveal: (line) => editor.current?.reveal({ line }),
              toast: (message) => host.notify('info', message),
            }),
        }
      : undefined;
    const items = editorMenu(ctx, path, link);
    if (items.length === 0) return;
    e.preventDefault();
    // 키보드로 연 메뉴(좌표 0, 0)는 커서 자리에 연다
    const caret = e.clientX === 0 && e.clientY === 0 ? view.coordsAtPos(view.state.selection.main.head) : null;
    openMenu(ctx, caret ? { x: caret.left, y: caret.bottom } : { x: e.clientX, y: e.clientY }, items, e);
  };
  // 보기 머리: 뒤로·앞으로, 경로 표시, 상태 칩, 주 동작, 표 넣기, QR, 보기 방식, ⋯ 메뉴, 오른쪽 사이드바 단추.
  const navButtons = (
    <NavButtons
      canBack={nav.current.canBack(selected)}
      canForward={nav.current.canForward(selected)}
      onBack={() => void navFns.go('back')}
      onForward={() => void navFns.go('forward')}
    />
  );
  const rightToggle = (
    <button
      type="button"
      className="ibtn"
      aria-label={t('ribbon.toggleRight')}
      title={t('ribbon.withKey', t('ribbon.toggleRight'), 'Ctrl+Shift+\\')}
      aria-expanded={layout.rightOpen}
      aria-controls="right-dock"
      data-command-id="app.toggleRight"
      onClick={() => layoutStore.toggleRight()}
    >
      <Icon name="panel-right" />
    </button>
  );
  const moreButton = (path: string) => (
    <button
      type="button"
      className="ibtn"
      aria-label={t('header.more')}
      title={t('header.more')}
      aria-haspopup="menu"
      disabled={!ctx}
      onClick={(e) => ctx && openMenu(ctx, { element: e.currentTarget }, viewMoreMenu(ctx, path))}
    >
      <Icon name="ellipsis" />
    </button>
  );
  const changeStatus = ctx ? () => void runCommand(ctx, commandById('change-experiment-status')!) : undefined;
  // 실험 README(Task 19): 빈 체크리스트 카드의 "첫 워크플로 추가"는 이 실험에 워크플로를 만들고(카탈로그 고르기),
  // 편집기에서 체크하면 상태 권유 알림을 띄운다. 열린 노트가 README 일 때만 편집기에 넘긴다.
  const readmeOpen = !!selected && isExperimentReadme(selected);
  const addFirstWorkflow = (readme: string) => () => {
    if (ctx) void runCommand(ctx, () => createWorkflow(ctx, undefined, { experimentDir: readme.slice(0, readme.lastIndexOf('/')) }));
  };
  const checklistTick = (readme: string) => (prev: ChecklistCounts, next: ChecklistCounts) => {
    if (ctx) offerStatusNudge(ctx, readme, prev, next);
  };
  // Workflow 노트: 머리의 완료 체크 칩(README 체크리스트 [ ] / [x])과, 모든 Unit Operation 이 끝났을 때의 완료 권유
  const workflowOpen = !!selected && isValidWorkflowPath(selected);
  const workflowTick = ctx
    ? {
        read: (path: string) => readWorkflowTick(ctx, path),
        toggle: async (path: string) => {
          let after: boolean | undefined;
          await runCommand(ctx, async () => {
            after = await toggleWorkflowDone(ctx, path);
          });
          return after;
        },
      }
    : undefined;
  const uoAllDone = (path: string) => () => {
    if (ctx) void offerWorkflowDoneNudge(ctx, path);
  };
  return (
    <>
      <div className="shell" ref={shell}>
        <Ribbon
          onCommand={runShellCommand}
          leftHidden={layout.leftHidden}
          rightOpen={layout.rightOpen}
          ready={ctx !== undefined}
          assistantVisible={!layout.pet.hidden}
        />
        <div className="notices">
          {failed && <p role="alert">{t('tree.error')}</p>}
          {settingsImported && <p role="status">{t('settings.imported')}</p>}
        </div>
        <Dock tab={tab} onTab={showLeft} footer={<VaultBar name={vault.name} root={vault.root} ctx={ctx} onSwitchVault={switchVault} onOpenSettings={openSettings} />}>
          {/* 파일 탭은 숨겨도 내리지 않는다: 접어 둔 폴더와 찾던 말이 남는다 */}
          <div role="tabpanel" id="sidebar-panel-files" className="sidebar-panel" aria-labelledby="sidebar-tab-files" hidden={tab !== 'files'}>
            <div className="nav-header">
              <span className="nav-header-title">{t('files.title')}</span>
              <div className="nav-header-actions">
                <button
                  type="button"
                  className="ibtn"
                  aria-label={t('files.newNote')}
                  title={t('ribbon.withKey', t('files.newNote'), 'Ctrl+N')}
                  data-command-id="app.newNote"
                  onClick={() => void newNote()}
                >
                  <Icon name="file-plus" />
                </button>
                <button
                  type="button"
                  className="ibtn"
                  aria-label={t('files.newFolder')}
                  title={t('files.newFolder')}
                  disabled={!ctx}
                  onClick={() => {
                    if (ctx) void runCommand(ctx, () => newFolder(ctx, ''));
                  }}
                >
                  <Icon name="folder-plus" />
                </button>
                <button
                  type="button"
                  className="ibtn"
                  aria-label={t('settings.systemFiles')}
                  title={t('settings.systemFiles')}
                  aria-pressed={layout.showSystemFiles}
                  data-command-id="app.showSystemFiles"
                  onClick={() => layoutStore.update({ showSystemFiles: !layout.showSystemFiles })}
                >
                  <Icon name="eye" />
                </button>
                <button type="button" className="ibtn" aria-label={t('files.collapseAll')} title={t('files.collapseAll')} onClick={() => collapseFiles.current?.()}>
                  <Icon name="chevrons-up-down" />
                </button>
              </div>
            </div>
            <SearchPanel onOpen={openNote} showSystem={layout.showSystemFiles} />
            {/* 다시 읽기만 실패했다면 보이던 줄은 그대로 둔다. 읽은 적이 없을 때만 알림만 보인다. */}
            {!(failed && entries.length === 0) && (
              <NoteTree
                entries={shownEntries}
                selected={viewing?.path ?? selected}
                onSelect={openNote}
                onView={(path, kind) => setViewing({ path, kind })}
                onContextMenu={onTreeMenu}
                collapseAllRef={collapseFiles}
                reveal={fileReveal}
              />
            )}
          </div>
          {tab === 'experiments' && (
            <div role="tabpanel" id="sidebar-panel-experiments" className="sidebar-panel" aria-labelledby="sidebar-tab-experiments">
              {/* 첨부를 보는 동안은 열린 노트가 가려져 있다: 실험 트리도 앞 노트를 강조하지 않는다 */}
              {ctx ? <ExperimentsPanel ctx={ctx} activePath={selected} noteHidden={viewing !== undefined} /> : <p>{t('workflows.loading')}</p>}
            </div>
          )}
          {tab === 'samples' && (
            <div role="tabpanel" id="sidebar-panel-samples" className="sidebar-panel" aria-labelledby="sidebar-tab-samples">
              {ctx ? <SamplesPanel ctx={ctx} activePath={selected} /> : <p>{t('workflows.loading')}</p>}
            </div>
          )}
        </Dock>
        <main className={viewing ? 'content viewing-file' : 'content'}>
          {viewing && (
            <section className="file-view" data-path={viewing.path}>
              <ViewHeader
                lead={
                  <>
                    {navButtons}
                    {/* 명세 §3.4: 보기 화면의 머리는 파일 이름(전체 경로는 툴팁) */}
                    <span className="view-file-path" title={viewing.path}>
                      {viewing.path.slice(viewing.path.lastIndexOf('/') + 1)}
                    </span>
                  </>
                }
                actions={rightToggle}
              />
              {viewerFor(viewing.path) === 'image' ? (
                <ImageViewer key={viewing.path} path={viewing.path} />
              ) : viewerFor(viewing.path) === 'csv' ? (
                <CsvViewer key={viewing.path} path={viewing.path} />
              ) : (
                <FileCard path={viewing.path} kind={viewing.kind} />
              )}
            </section>
          )}
          {selected ? (
            <Editor
              key={selected}
              ref={editor}
              path={selected}
              initialReveal={notes.reveal}
              onContextMenu={onEditorMenu}
              onOpenLink={onOpenLink}
              onChangeStatus={changeStatus}
              headerLead={
                <>
                  {navButtons}
                  <NoteLead
                    path={selected}
                    onOpen={openNote}
                    onJump={(line) => editor.current?.reveal({ line })}
                    onMenu={(anchor, items) => ctx && openMenu(ctx, { element: anchor }, items)}
                    onStatus={changeStatus}
                    workflowTick={workflowTick}
                  />
                </>
              }
              headerActions={ctx ? (busy) => <EditorActions ctx={ctx} path={selected} disabled={busy} /> : undefined}
              headerTools={ctx ? (busy) => <NoteQrButton ctx={ctx} path={selected} disabled={busy} /> : undefined}
              headerTrail={
                <>
                  {moreButton(selected)}
                  {rightToggle}
                </>
              }
              samples={sampleConfig}
              sampleEnv={() => ctx && createSampleEnv(ctx)}
              imageFolder={settings?.imageFolder}
              onAddWorkflow={readmeOpen ? addFirstWorkflow(selected) : undefined}
              onChecklistTick={readmeOpen ? checklistTick(selected) : undefined}
              onUoAllDone={workflowOpen ? uoAllDone(selected) : undefined}
              upkeep={upkeep}
            />
          ) : (
            <>
              <ViewHeader lead={navButtons} actions={rightToggle} />
              <EmptyState onCommand={runShellCommand} ready={ctx !== undefined} />
            </>
          )}
        </main>
        <RightDock
          outline={<OutlinePanel onReveal={onOutlineReveal} />}
          links={<LinksPanel activePath={selected} onOpen={onLinksOpen} onCreate={onLinksCreate} ctx={ctx} />}
        />
        <StatusBar
          path={viewing ? undefined : selected}
          viewerPath={viewing?.path}
          onReveal={() => showLeft('experiments')}
          leading={<UpdateButton flushAll={flushAll} />}
          notes={
            <>
              {indexing && <span className="statusbar-item">{t('search.indexing')}</span>}
              {skipped > 0 && (
                <span className="statusbar-item" role="status">
                  {t('search.skipped', skipped)}
                </span>
              )}
              {vault.hasObsidianConfig && (
                <span className="statusbar-item statusbar-note" title={t('vault.obsidian')}>
                  {t('vault.obsidian')}
                </span>
              )}
            </>
          }
          trailing={
            <>
              <span className="statusbar-item status-version">
                {t('app.ready')} {version}
              </span>
              <AppearanceButton theme={theme} onTheme={setTheme} lang={getLang()} onLang={setLang} onOpenSettings={openSettings} />
            </>
          }
        />
      </div>
      {/* .shell 밖: 대화상자가 열려 있는 동안 .shell 은 inert 다. 알림과 메뉴는 그 위에 뜬다 */}
      <DialogLayer blockRef={shell} />
      <Toaster />
      {/* 떠 있는 도우미 층(assistant 명세 §4.1). 탭 순서의 맨 끝(상태 줄 뒤)이다. 대화상자가 열려 있는 동안 DialogLayer 가 inert 로 막는다 */}
      <div id={PET_LAYER_ID}>
        <PetLayer activePath={selected} actions={petActions} />
      </div>
      <ContextMenu />
    </>
  );
}

export function App() {
  const [version, setVersion] = useState('');
  const { state, open, create, change } = useVault();
  useEffect(() => {
    fetchAppVersion().then(setVersion);
  }, []);
  const { theme, setTheme } = useTheme();
  // 언어를 바꾸면 여기서부터 아래가 같은 자리에서 다시 그려진다: 아무것도 다시 마운트하지 않는다(편집기의 저장 안 된 편집이 남는다).
  // 루트의 key 를 바꿔 다시 그리게 하지 않는다. 그러면 편집기가 새로 뜨며 편집을 잃는다.
  const lang = useLang();
  useLayoutEffect(() => applyHtmlLang(lang), [lang]);
  // 보관함이 열린 화면은 VaultView 가 자기 main 을 가진다. 그 밖의 화면(불러오는 중, 선택)은 여기서 감싼다.
  if (state.status === 'ready') {
    return <VaultView key={state.vault.root} vault={state.vault} version={version} onChangeVault={change} theme={theme} setTheme={setTheme} />;
  }
  return (
    <main className="standalone">
      <div className="standalone-head">
        <h1>{t('app.title')}</h1>
        <div className="standalone-actions">
          <ThemeToggle theme={theme} onChange={setTheme} />
          <LanguageToggle lang={lang} onChange={setLang} />
        </div>
      </div>
      {state.status === 'loading' && <p>{t('vault.loading')}</p>}
      {state.status === 'picker' && <FirstRun error={state.error} onOpen={open} onCreate={create} />}
    </main>
  );
}
