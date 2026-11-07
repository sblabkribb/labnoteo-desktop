import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { t } from './i18n/t';
import { FirstRun } from './onboarding/FirstRun';
import { useVault, type VaultInfo } from './vault/useVault';
import { ChangeVault } from './vault/ChangeVault';
import { useVaultEvents } from './vault/useVaultEvents';
import { vaultImages } from './editor/live/vaultImages';
import { NoteTree } from './tree/NoteTree';
import { NewNote } from './tree/NewNote';
import { useTree } from './tree/useTree';
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
import { UpdateBanner } from './update/UpdateBanner';
import { ThemeToggle } from './theme/ThemeToggle';
import { useTheme, type Theme } from './theme/useTheme';
import { LanguageToggle } from './i18n/LanguageToggle';
import { applyHtmlLang, setLang, type Lang } from './i18n/lang';
import { useLang } from './i18n/useLang';
import { useVaultSettings } from './labnote/settings';
import { TauriLabnoteFs } from './fs/tauriLabnoteFs';
import { createAppHost } from './labnote/host/createAppHost';
import { DialogLayer } from './labnote/host/DialogLayer';
import { Toaster } from './labnote/host/Toaster';
import { closeAllDialogs } from './labnote/host/dialogStore';
import { editorAwareFs } from './labnote/editorAwareFs';
import { activeEditTarget, openNote as openEditor } from './labnote/openNotes';
import { registerAllCommands } from './labnote/commands/registerAll';
import { commandById } from './labnote/commands/registry';
import { runCommand } from './labnote/commands/runCommand';
import { registerAllAppCommands } from './editor/commands/appCommands';
import { catalogNoticeOnOpen } from './labnote/commands/catalogs';
import { useCommandContext, useNoteSwitcher } from './labnote/commands/useCommandContext';
import { PaletteButton, usePaletteHotkey } from './labnote/ui/CommandPalette';
import { ContextMenu } from './labnote/ui/ContextMenu';
import { closeMenu, openMenu } from './labnote/ui/menuStore';
import { EditorActions } from './labnote/ui/EditorActions';
import { editorMenu, noteTreeMenu } from './labnote/menus';
import { WorkflowsPanel } from './labnote/panel/WorkflowsPanel';
import { OutlinePanel } from './editor/outline/OutlinePanel';
import { LinksPanel } from './links/LinksPanel';
import { createFromLink } from './links/createFromLink';

type SidebarTab = 'files' | 'workflows' | 'outline' | 'links';

const TAB_ORDER: readonly SidebarTab[] = ['files', 'workflows', 'outline', 'links'];

/** 보관함마다 기억하는 사이드바 탭(이 PC 의 브라우저 저장소). 읽거나 쓰지 못하면 기억하지 않는다. */
const tabKey = (root: string) => `labnoteo-sidebar-tab:${root}`;

function storedTab(root: string): SidebarTab | undefined {
  try {
    const v = localStorage.getItem(tabKey(root));
    return TAB_ORDER.find((tab) => tab === v);
  } catch {
    return undefined;
  }
}

function storeTab(root: string, tab: SidebarTab): void {
  try {
    localStorage.setItem(tabKey(root), tab);
  } catch {
    // 저장소가 막혀 있다: 이번 실행 동안만 기억한다
  }
}

interface ViewProps {
  vault: VaultInfo;
  version: string;
  onChangeVault: () => void;
  theme: Theme;
  setTheme: (theme: Theme) => void;
  lang: Lang;
}

function VaultView({ vault, version, onChangeVault, theme, setTheme, lang }: ViewProps) {
  const { entries, failed, reload } = useTree(vault.root);
  // 보관함 밖에서 파일이 바뀌면(git pull, 동기화, Obsidian, 탐색기) 트리를 다시 읽는다. 색인은 Rust 가 같은 변경으로 갱신한다.
  useVaultEvents(reload);
  const editor = useRef<EditorHandle>(null);
  const shell = useRef<HTMLDivElement>(null);
  // 저장 안 된 편집이 있으면 먼저 저장한다. 저장하지 못하면(충돌 등) 노트를 바꾸지 않는다 — 편집이 사라지지 않게.
  const notes = useNoteSwitcher(editor);
  const { selected, openFile, closeActive } = notes;
  // 사이드바 탭: 고른 적이 없으면 labnote/ 폴더가 있는 보관함은 Workflows, 아니면 Files.
  const [chosenTab, setChosenTab] = useState<SidebarTab | undefined>(() => storedTab(vault.root));
  const hasLabnote = entries.some((e) => e.isDir && e.depth === 0 && e.path.toLowerCase() === 'labnote');
  const tab: SidebarTab = chosenTab ?? (hasLabnote ? 'workflows' : 'files');
  const showPanel = (next: SidebarTab) => {
    setChosenTab(next);
    storeTab(vault.root, next);
  };
  // WAI-ARIA 탭 패턴: 고른 탭만 Tab 순서에 있으니 화살표·Home·End 로 탭을 옮기고 초점도 함께 옮긴다.
  const onTabKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const order = TAB_ORDER;
    const at = order.indexOf(tab);
    const next =
      e.key === 'ArrowRight' ? order[(at + 1) % order.length]
      : e.key === 'ArrowLeft' ? order[(at - 1 + order.length) % order.length]
      : e.key === 'Home' ? order[0]
      : e.key === 'End' ? order[order.length - 1]
      : undefined;
    if (!next) return;
    e.preventDefault();
    showPanel(next);
    document.getElementById(`sidebar-tab-${next}`)?.focus();
  };
  const openNote = (path: string) => openFile(path);
  // 개요에서 제목을 고르면: 열린 편집기면 그 줄로 커서를 옮기고 초점을 편집기로 돌려준다(reveal 이 focus 한다).
  // 열려 있지 않으면(개요가 낡았다) 열면서 그 줄로 간다.
  const onOutlineReveal = (path: string, line0: number) => {
    const handle = openEditor(path);
    if (handle) handle.reveal({ line: line0 });
    else void openFile(path, { line: line0 });
  };
  // 보관함별 설정(앱 설정 폴더에 둔다). 처음 여는 Obsidian 보관함이면 플러그인 설정을 한 번 가져온다.
  const { settings, imported: settingsImported, update: updateSettings } = useVaultSettings(vault.root);
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
  });
  usePaletteHotkey(ctx);
  // 설정을 읽은 뒤 보관함마다 한 번: 번들 카탈로그가 바뀌었으면 알린다. 여는 것을 막지 않는다(기다리지 않고, 던지지 않는다).
  const catalogNoticed = useRef(false);
  useEffect(() => {
    if (!ctx || catalogNoticed.current) return;
    catalogNoticed.current = true;
    void catalogNoticeOnOpen(ctx);
  }, [ctx]);
  useEffect(() => {
    registerAllCommands();
    registerAllAppCommands();
    // 보관함을 바꾸면 이 보관함의 명령이 띄운 대화상자와 메뉴는 의미가 없다
    return () => {
      closeAllDialogs();
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
  // 끝난 것은 "마지막 이름 바꾸기 되돌리기"를 위해 남긴다. VaultView 는 보관함마다 새로 마운트된다.
  const recoverCtx = useRef(ctx);
  recoverCtx.current = ctx;
  const hasCtx = ctx !== undefined;
  useEffect(() => {
    if (!hasCtx) return;
    let live = true;
    void linkIndex
      .whenReady()
      .then(() => (live && recoverCtx.current ? recoverJournal(recoverCtx.current, linkJournal) : undefined))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [hasCtx]);
  const flush = async () => !editor.current || (await editor.current.flush());
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
    openMenu(ctx, caret ? { x: caret.left, y: caret.bottom } : { x: e.clientX, y: e.clientY }, items);
  };
  return (
    <>
      <div className="shell" ref={shell}>
        <header className="topbar">
          <h1>{t('app.title')}</h1>
          <p className="vault-name" title={vault.name}>
            {t('vault.open', vault.name)}
          </p>
          <div className="topbar-actions">
            <PaletteButton ctx={ctx} />
            <NewNote flush={flush} onCreated={openNote} />
            <ChangeVault flush={flush} onChange={onChangeVault} />
            <ThemeToggle theme={theme} onChange={setTheme} />
            <LanguageToggle lang={lang} onChange={setLang} />
          </div>
        </header>
        <div className="notices">
          <UpdateBanner beforeInstall={flush} />
          {failed && <p role="alert">{t('tree.error')}</p>}
          {settingsImported && <p role="status">{t('settings.imported')}</p>}
        </div>
        <aside className="sidebar" aria-label={t('app.sidebar')}>
          <div className="sidebar-tabs" role="tablist" aria-label={t('sidebar.tabs')} onKeyDown={onTabKeyDown}>
            <button
              type="button"
              role="tab"
              id="sidebar-tab-files"
              aria-controls="sidebar-panel-files"
              aria-selected={tab === 'files'}
              tabIndex={tab === 'files' ? 0 : -1}
              className="sidebar-tab"
              onClick={() => showPanel('files')}
            >
              {t('sidebar.tab.files')}
            </button>
            <button
              type="button"
              role="tab"
              id="sidebar-tab-workflows"
              aria-controls="sidebar-panel-workflows"
              aria-selected={tab === 'workflows'}
              tabIndex={tab === 'workflows' ? 0 : -1}
              className="sidebar-tab"
              onClick={() => showPanel('workflows')}
            >
              {t('sidebar.tab.workflows')}
            </button>
            <button
              type="button"
              role="tab"
              id="sidebar-tab-outline"
              aria-controls="sidebar-panel-outline"
              aria-selected={tab === 'outline'}
              tabIndex={tab === 'outline' ? 0 : -1}
              className="sidebar-tab"
              onClick={() => showPanel('outline')}
            >
              {t('sidebar.outline')}
            </button>
            <button
              type="button"
              role="tab"
              id="sidebar-tab-links"
              aria-controls="sidebar-panel-links"
              aria-selected={tab === 'links'}
              tabIndex={tab === 'links' ? 0 : -1}
              className="sidebar-tab"
              onClick={() => showPanel('links')}
            >
              {t('sidebar.tab.links')}
            </button>
          </div>
          {/* 파일 탭은 숨겨도 내리지 않는다: 접어 둔 폴더와 찾던 말이 남는다 */}
          <div role="tabpanel" id="sidebar-panel-files" className="sidebar-panel" aria-labelledby="sidebar-tab-files" hidden={tab !== 'files'}>
            <SearchPanel onOpen={openNote} />
            {/* 다시 읽기만 실패했다면 보이던 줄은 그대로 둔다. 읽은 적이 없을 때만 알림만 보인다. */}
            {!(failed && entries.length === 0) && <NoteTree entries={entries} selected={selected} onSelect={openNote} onContextMenu={onTreeMenu} />}
          </div>
          {tab === 'workflows' && (
            <div role="tabpanel" id="sidebar-panel-workflows" className="sidebar-panel" aria-labelledby="sidebar-tab-workflows">
              {ctx ? <WorkflowsPanel ctx={ctx} activePath={selected} /> : <p>{t('workflows.loading')}</p>}
            </div>
          )}
          {tab === 'outline' && (
            <div role="tabpanel" id="sidebar-panel-outline" className="sidebar-panel" aria-labelledby="sidebar-tab-outline">
              <OutlinePanel onReveal={onOutlineReveal} />
            </div>
          )}
          {tab === 'links' && (
            <div role="tabpanel" id="sidebar-panel-links" className="sidebar-panel" aria-labelledby="sidebar-tab-links">
              <LinksPanel activePath={selected} onOpen={onLinksOpen} onCreate={onLinksCreate} ctx={ctx} />
            </div>
          )}
        </aside>
        <main className="content">
          {selected ? (
            <Editor
              key={selected}
              ref={editor}
              path={selected}
              initialReveal={notes.reveal}
              onContextMenu={onEditorMenu}
              onOpenLink={onOpenLink}
              onChangeStatus={ctx ? () => void runCommand(ctx, commandById('change-experiment-status')!) : undefined}
              headerActions={ctx ? (busy) => <EditorActions ctx={ctx} path={selected} disabled={busy} /> : undefined}
            />
          ) : (
            <p className="empty-state">{t('editor.empty')}</p>
          )}
        </main>
        <footer className="statusbar">
          <div className="status-notes">
            {indexing && <span>{t('search.indexing')}</span>}
            {skipped > 0 && <span role="status">{t('search.skipped', skipped)}</span>}
            {vault.hasObsidianConfig && <span>{t('vault.obsidian')}</span>}
          </div>
          <span className="status-version">
            {t('app.ready')} {version}
          </span>
        </footer>
      </div>
      {/* .shell 밖: 대화상자가 열려 있는 동안 .shell 은 inert 다. 알림과 메뉴는 그 위에 뜬다 */}
      <DialogLayer blockRef={shell} />
      <Toaster />
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
    return <VaultView key={state.vault.root} vault={state.vault} version={version} onChangeVault={change} theme={theme} setTheme={setTheme} lang={lang} />;
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
