import { useSyncExternalStore } from 'react';
import { t } from '../i18n/t';
import { installUpdate, subscribeUpdate, updateState } from './updateStore';

/** 옮겨 간 타입. Task 2 가 이 배너를 지울 때까지 예전 import 를 살려 둔다. */
export type { PendingUpdate } from './updateStore';

interface Props {
  /** 설치 전에 저장 안 된 편집을 저장한다. false 면 편집이 남아 있으니 설치하지 않는다. */
  beforeInstall: () => Promise<boolean>;
}

/**
 * 잠깐만 쓰는 배너: 새 버전은 updateStore 가 뒤에서 받고, 다 받으면(ready) 여기서 설치를 누를 수 있다.
 * 왼쪽 아래 업데이트 버튼(Task 2)이 이 배너를 대신한다. 오류는 막지 않고 조용히 보인다.
 */
export function UpdateBanner({ beforeInstall }: Props) {
  const state = useSyncExternalStore(subscribeUpdate, updateState);
  if (state.kind !== 'ready' && state.kind !== 'installing' && state.kind !== 'installFailed') return null;
  const busy = state.kind === 'installing';
  return (
    <aside aria-label={t('update.install')}>
      <p>{t('update.available', state.version)}</p>
      <button type="button" className="primary" disabled={busy} onClick={() => void installUpdate(beforeInstall)}>
        {t('update.install')}
      </button>
      {busy && <p role="status">{t('update.installing')}</p>}
      {state.kind === 'installFailed' && <p role="alert">{t('update.error')}</p>}
    </aside>
  );
}
