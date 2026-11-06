import { useEffect, useState } from 'react';
import { t } from './i18n/t';
import { VaultPicker } from './vault/VaultPicker';
import { useVault, type VaultInfo } from './vault/useVault';
import { useVaultEvents } from './vault/useVaultEvents';
import { NoteTree } from './tree/NoteTree';
import { useTree } from './tree/useTree';
import { SearchPanel } from './search/SearchPanel';
import { rebuildIndex } from './search/indexApi';
import { fetchAppVersion } from './appVersion';

function VaultView({ vault, version }: { vault: VaultInfo; version: string }) {
  const { entries, failed, reload } = useTree(vault.root);
  // 보관함 밖에서 파일이 바뀌면(git pull, 동기화, Obsidian, 탐색기) 트리를 다시 읽는다. 색인은 Rust 가 같은 변경으로 갱신한다.
  useVaultEvents(reload);
  const [selected, setSelected] = useState<string>();
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
  return (
    <>
      <p>{t('vault.open', vault.name)}</p>
      {vault.hasObsidianConfig && <p>{t('vault.obsidian')}</p>}
      <SearchPanel onOpen={setSelected} indexing={indexing} skipped={skipped} />
      {failed ? <p role="alert">{t('tree.error')}</p> : <NoteTree entries={entries} selected={selected} onSelect={setSelected} />}
      <p>
        {t('app.ready')} {version}
      </p>
    </>
  );
}

export function App() {
  const [version, setVersion] = useState('');
  const { state, open } = useVault();
  useEffect(() => {
    fetchAppVersion().then(setVersion);
  }, []);
  return (
    <main>
      <h1>{t('app.title')}</h1>
      {state.status === 'loading' && <p>{t('vault.loading')}</p>}
      {state.status === 'picker' && <VaultPicker error={state.error} onPick={open} />}
      {state.status === 'ready' && <VaultView key={state.vault.root} vault={state.vault} version={version} />}
    </main>
  );
}
