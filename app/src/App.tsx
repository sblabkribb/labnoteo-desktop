import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { t } from './i18n/t';
import { FirstRun } from './onboarding/FirstRun';
import { useVault, type VaultInfo } from './vault/useVault';
import { ChangeVault } from './vault/ChangeVault';
import { useVaultEvents } from './vault/useVaultEvents';
import { NoteTree } from './tree/NoteTree';
import { NewNote } from './tree/NewNote';
import { useTree } from './tree/useTree';
import { SearchPanel } from './search/SearchPanel';
import { rebuildIndex } from './search/indexApi';
import { Editor, type EditorHandle } from './editor/Editor';
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
import { activeEditTarget } from './labnote/openNotes';
import { registerAllCommands } from './labnote/commands/registerAll';
import { catalogNoticeOnOpen } from './labnote/commands/catalogs';
import { useCommandContext, useNoteSwitcher } from './labnote/commands/useCommandContext';
import { PaletteButton, usePaletteHotkey } from './labnote/ui/CommandPalette';
import { ContextMenu } from './labnote/ui/ContextMenu';
import { closeMenu } from './labnote/ui/menuStore';

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
  const openNote = (path: string) => openFile(path);
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
    // 보관함을 바꾸면 이 보관함의 명령이 띄운 대화상자와 메뉴는 의미가 없다
    return () => {
      closeAllDialogs();
      closeMenu();
    };
  }, []);
  const [indexing, setIndexing] = useState(true);
  const [skipped, setSkipped] = useState(0);
  // 색인은 캐시다: 보관함을 열 때마다 파일에서 다시 채운다. 실패해도 노트 사용은 막지 않는다.
  useEffect(() => {
    let live = true;
    setIndexing(true);
    setSkipped(0);
    rebuildIndex()
      .then((stats) => live && setSkipped(stats.skipped))
      .catch(() => undefined)
      .then(() => live && setIndexing(false));
    return () => {
      live = false;
    };
  }, [vault.root]);
  const flush = async () => !editor.current || (await editor.current.flush());
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
          <SearchPanel onOpen={openNote} />
          {/* 다시 읽기만 실패했다면 보이던 줄은 그대로 둔다. 읽은 적이 없을 때만 알림만 보인다. */}
          {!(failed && entries.length === 0) && <NoteTree entries={entries} selected={selected} onSelect={openNote} />}
        </aside>
        <main className="content">
          {selected ? (
            <Editor key={selected} ref={editor} path={selected} initialReveal={notes.reveal} />
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
