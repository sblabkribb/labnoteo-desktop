import { useState } from 'react';
import { open as pickFolder, save as pickNewFolder } from '@tauri-apps/plugin-dialog';
import { t } from '../i18n/t';
import type { VaultErrorKey } from '../vault/useVault';

interface Props {
  /** 번역 키. 그릴 때 번역한다: 오류가 떠 있는 동안 언어를 바꿔도 따라 바뀐다. */
  error?: VaultErrorKey;
  /** 새 보관함 폴더를 만들 경로(아직 없는 폴더). */
  onCreate: (path: string) => void;
  /** 이미 있는 폴더(노트 폴더나 Obsidian 보관함). */
  onOpen: (path: string) => void;
}

/**
 * 보관함이 없을 때만 보이는 화면. 선택지는 둘뿐이다: 새로 만들기, 기존 폴더 열기.
 * "새로 만들기"는 저장 대화상자를 쓴다 — 위치 고르기와 폴더 이름 적기를 한 창에서 한다.
 */
export function FirstRun({ error, onCreate, onOpen }: Props) {
  const [failed, setFailed] = useState(false);

  async function ask(pick: () => Promise<unknown>, then: (path: string) => void) {
    setFailed(false);
    try {
      const picked = await pick();
      // 취소하면 문자열이 아닌 값(null)이 온다: 아무 일도 하지 않는다.
      if (typeof picked === 'string' && picked !== '') then(picked);
    } catch {
      setFailed(true);
    }
  }

  return (
    <section className="first-run">
      <h2>{t('firstRun.title')}</h2>
      <p>{t('firstRun.hint')}</p>
      <div className="first-run-choices">
        <div>
          <button type="button" className="primary" onClick={() => ask(() => pickNewFolder({ title: t('firstRun.createDialogTitle') }), onCreate)}>
            {t('firstRun.create')}
          </button>
          <p>{t('firstRun.createHint')}</p>
        </div>
        <div>
          <button
            type="button"
            onClick={() =>
              ask(() => pickFolder({ directory: true, multiple: false, title: t('firstRun.openDialogTitle') }), onOpen)
            }
          >
            {t('firstRun.open')}
          </button>
          <p>{t('firstRun.openHint')}</p>
        </div>
      </div>
      {(error || failed) && <p role="alert">{t(error ?? 'vault.error.generic')}</p>}
    </section>
  );
}
