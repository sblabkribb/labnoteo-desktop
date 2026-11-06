import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { t } from './i18n/t';
import { VaultPicker } from './vault/VaultPicker';
import { useVault, type VaultInfo } from './vault/useVault';
import { NoteTree } from './tree/NoteTree';
import { useTree } from './tree/useTree';

function VaultView({ vault, version }: { vault: VaultInfo; version: string }) {
  const { entries, failed } = useTree(vault.root);
  const [selected, setSelected] = useState<string>();
  return (
    <>
      <p>{t('vault.open', vault.name)}</p>
      {vault.hasObsidianConfig && <p>{t('vault.obsidian')}</p>}
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
    invoke<string>('app_version').then(setVersion).catch(() => setVersion(''));
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
