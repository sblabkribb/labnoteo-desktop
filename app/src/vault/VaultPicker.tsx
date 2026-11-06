import { useState } from 'react';
import { open as pickFolder } from '@tauri-apps/plugin-dialog';
import { t } from '../i18n/t';

interface Props {
  error?: string;
  onPick: (path: string) => void;
}

/** 보관함이 없을 때만 보이는 화면. 폴더 선택은 Tauri dialog 플러그인이 한다. */
export function VaultPicker({ error, onPick }: Props) {
  const [failed, setFailed] = useState(false);

  async function choose() {
    setFailed(false);
    try {
      const picked = await pickFolder({ directory: true, multiple: false, title: t('vault.picker.dialogTitle') });
      if (typeof picked === 'string') onPick(picked);
    } catch {
      setFailed(true);
    }
  }

  return (
    <section>
      <h2>{t('vault.picker.title')}</h2>
      <p>{t('vault.picker.hint')}</p>
      <button type="button" onClick={choose}>
        {t('vault.picker.choose')}
      </button>
      {(error || failed) && <p role="alert">{error ?? t('vault.error.generic')}</p>}
    </section>
  );
}
