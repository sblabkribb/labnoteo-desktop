import { useEffect, useState } from 'react';
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { t } from '../i18n/t';

/** plugin-updater 의 `Update` 중 쓰는 부분만. */
export interface PendingUpdate {
  version: string;
  downloadAndInstall: () => Promise<void>;
}

interface Props {
  /** 설치 전에 저장 안 된 편집을 저장한다. false 면 편집이 남아 있으니 설치하지 않는다. */
  beforeInstall: () => Promise<boolean>;
  checkForUpdate?: () => Promise<PendingUpdate | null>;
  restart?: () => Promise<void>;
}

/**
 * 시작할 때 한 번 새 버전을 확인한다. 오프라인이거나 확인이 실패하면 아무것도 보이지 않는다 —
 * 업데이트는 노트 사용을 막지 않는다. 설치는 사용자가 누를 때만 한다.
 */
export function UpdateBanner({ beforeInstall, checkForUpdate = check, restart = relaunch }: Props) {
  const [update, setUpdate] = useState<PendingUpdate | null>(null);
  const [phase, setPhase] = useState<'idle' | 'installing' | 'unsaved' | 'failed'>('idle');

  useEffect(() => {
    let live = true;
    checkForUpdate()
      .then((u) => live && setUpdate(u))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [checkForUpdate]);

  if (!update) return null;

  async function install(u: PendingUpdate) {
    setPhase('installing');
    try {
      // Windows 설치 프로그램은 앱을 끝내고 시작하므로, 편집은 그 전에 디스크에 있어야 한다.
      if (!(await beforeInstall())) {
        setPhase('unsaved');
        return;
      }
      await u.downloadAndInstall();
      await restart();
    } catch {
      setPhase('failed');
    }
  }

  return (
    <aside aria-label={t('update.install')}>
      <p>{t('update.available', update.version)}</p>
      <button type="button" disabled={phase === 'installing'} onClick={() => install(update)}>
        {t('update.install')}
      </button>
      {phase === 'installing' && <p role="status">{t('update.installing')}</p>}
      {phase === 'unsaved' && <p role="alert">{t('update.unsaved')}</p>}
      {phase === 'failed' && <p role="alert">{t('update.error')}</p>}
    </aside>
  );
}
