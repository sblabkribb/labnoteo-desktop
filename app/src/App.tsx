import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { t } from './i18n/t';

export function App() {
  const [version, setVersion] = useState('');
  useEffect(() => {
    invoke<string>('app_version').then(setVersion).catch(() => setVersion(''));
  }, []);
  return (
    <main>
      <h1>{t('app.title')}</h1>
      <p>
        {t('app.ready')} {version}
      </p>
    </main>
  );
}
