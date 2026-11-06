import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { t } from './i18n/t';
import { VaultPicker } from './vault/VaultPicker';
import { useVault } from './vault/useVault';

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
      {state.status === 'ready' && (
        <>
          <p>{t('vault.open', state.vault.name)}</p>
          {state.vault.hasObsidianConfig && <p>{t('vault.obsidian')}</p>}
          <p>
            {t('app.ready')} {version}
          </p>
        </>
      )}
    </main>
  );
}
