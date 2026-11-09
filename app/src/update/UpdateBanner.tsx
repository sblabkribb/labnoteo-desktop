import { useState, useSyncExternalStore } from 'react';
import { relaunch } from '@tauri-apps/plugin-process';
import { t } from '../i18n/t';
import { dismissUpdate, subscribeUpdate, updateState } from './updateStore';

/** plugin-updater 의 `Update` 중 쓰는 부분만. */
export interface PendingUpdate {
  version: string;
  download: () => Promise<void>;
  install: () => Promise<void>;
}

interface Props {
  /** 설치 전에 저장 안 된 편집을 저장한다. false 면 편집이 남아 있으니 설치하지 않는다. */
  beforeInstall: () => Promise<boolean>;
  restart?: () => Promise<void>;
}

/**
 * updateStore 가 찾은 새 버전을 알린다(확인은 App 이 startUpdateChecks 로 시작한다). 오프라인이거나 주기 확인이
 * 실패하면 아무것도 보이지 않는다 — 업데이트는 노트 사용을 막지 않는다. 설치는 사용자가 누를 때만 한다(B-R9).
 * "나중에"는 이 버전 알림을 앱을 다시 켜거나 직접 확인할 때까지 감춘다(B-R10).
 */
export function UpdateBanner({ beforeInstall, restart = relaunch }: Props) {
  const state = useSyncExternalStore(subscribeUpdate, updateState);
  const [phase, setPhase] = useState<'idle' | 'installing' | 'unsaved' | 'failed'>('idle');

  if (state.kind === 'checking' && state.manual) {
    return (
      <aside aria-label={t('update.install')}>
        <p role="status">{t('update.checking')}</p>
      </aside>
    );
  }
  if (state.kind !== 'available' || state.dismissed) return null;
  const update = state.update;

  async function install(u: PendingUpdate) {
    setPhase('installing');
    try {
      // 내려받는 동안에는 계속 쓸 수 있다. 그래서 저장은 내려받은 뒤, 설치 바로 전에 한다:
      // Windows 설치 프로그램은 앱을 끝내므로, 그 사이에 친 글자는 디스크에 있어야 한다.
      await u.download();
      if (!(await beforeInstall())) {
        setPhase('unsaved');
        return;
      }
      await u.install();
      await restart();
    } catch {
      setPhase('failed');
    }
  }

  return (
    <aside aria-label={t('update.install')}>
      <p>{t('update.available', update.version)}</p>
      <button type="button" className="primary" disabled={phase === 'installing'} onClick={() => install(update)}>
        {t('update.install')}
      </button>
      <button type="button" disabled={phase === 'installing'} onClick={() => dismissUpdate()}>
        {t('update.later')}
      </button>
      {phase === 'installing' && <p role="status">{t('update.installing')}</p>}
      {phase === 'unsaved' && <p role="alert">{t('update.unsaved')}</p>}
      {phase === 'failed' && <p role="alert">{t('update.error')}</p>}
    </aside>
  );
}
