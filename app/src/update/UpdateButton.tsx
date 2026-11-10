import { useEffect, useLayoutEffect, useRef, useSyncExternalStore, type JSX } from 'react';
import { t } from '../i18n/t';
import { useLang } from '../i18n/useLang';
import { notify } from '../labnote/host/toastStore';
import { Icon, type IconName } from '../ui/Icon';
import { installUpdate, retryUpdate, subscribeUpdate, updateState, type UpdateState } from './updateStore';

/** 처음 다 받은 버전을 알렸는지 적어 두는 localStorage 키 (spec §3.5). */
export const TOASTED_KEY = 'labnoteo.update.toasted';

/** localStorage 를 못 쓸 때도 한 세션에 한 번만 알리도록 기억한다. */
let toastedInSession: string | null = null;

/** 테스트 전용. */
export function resetUpdateButtonForTest(): void {
  toastedInSession = null;
}

function alreadyToasted(version: string): boolean {
  if (toastedInSession === version) return true;
  try {
    return localStorage.getItem(TOASTED_KEY) === version;
  } catch {
    return false;
  }
}

function rememberToasted(version: string): void {
  toastedInSession = version;
  try {
    localStorage.setItem(TOASTED_KEY, version);
  } catch {
    // 막힌 저장소: 이 세션에서만 기억한다
  }
}

type ToastFn = (kind: 'info' | 'warn', text: string) => void;

interface View {
  label: string;
  icon: IconName;
  /** downloading: 막대 모양. 'determinate' 면 --update-progress 를 쓴다. */
  state: 'determinate' | 'indeterminate' | 'ready' | 'installing' | 'failed';
  title?: string;
  disabled: boolean;
  spin?: boolean;
  percent?: number;
}

function viewOf(s: UpdateState): View | null {
  switch (s.kind) {
    case 'downloading': {
      if (s.total !== undefined && s.total > 0) {
        const percent = Math.max(0, Math.min(100, Math.floor((s.received / s.total) * 100)));
        return { label: t('update.downloading', percent), icon: 'download', state: 'determinate', disabled: true, percent };
      }
      return { label: t('update.downloadingUnknown'), icon: 'download', state: 'indeterminate', disabled: true };
    }
    case 'ready':
      return { label: t('update.ready'), icon: 'arrow-up-circle', state: 'ready', title: t('update.readyTitle', s.version), disabled: false };
    case 'installing':
      return { label: t('update.installing'), icon: 'loader', state: 'installing', disabled: true, spin: true };
    case 'downloadFailed':
      return { label: t('update.retry'), icon: 'alert-circle', state: 'failed', title: t('update.error.tooltip'), disabled: false };
    case 'installFailed':
      return { label: t('update.retry'), icon: 'alert-circle', state: 'failed', title: t('update.installError.tooltip'), disabled: false };
    default:
      return null;
  }
}

/**
 * 왼쪽 아래(상태 줄 첫 칸)의 업데이트 버튼 (spec §3.3). 새 버전은 updateStore 가 뒤에서 받는다: 받는 동안은 진행을,
 * 다 받으면 "업데이트" 를 보이고, 누르면 열린 노트를 모두 저장한 뒤 설치하고 다시 켠다. 저장하지 못하면 설치하지 않는다.
 * 오류는 막지 않는다: 툴팁과 다시 시도만. 처음 다 받은 버전마다 알림 한 번.
 */
export function UpdateButton(p: { flushAll: () => Promise<boolean>; toast?: ToastFn }): JSX.Element | null {
  useLang();
  const state = useSyncExternalStore(subscribeUpdate, updateState, updateState);
  const button = useRef<HTMLButtonElement>(null);
  const toastRef = useRef<ToastFn>(p.toast ?? ((kind, text) => notify(kind, text)));
  toastRef.current = p.toast ?? ((kind, text) => notify(kind, text));
  const view = viewOf(state);

  // 진행 막대 폭: CSP(style-src 'self') 때문에 style 속성이 아니라 CSSOM 으로만 정한다
  const percent = view?.percent;
  useLayoutEffect(() => {
    const el = button.current;
    if (!el) return;
    if (percent === undefined) el.style.removeProperty('--update-progress');
    else el.style.setProperty('--update-progress', `${percent}%`);
  }, [percent, view !== null]);

  const readyVersion = state.kind === 'ready' ? state.version : undefined;
  useEffect(() => {
    if (readyVersion === undefined || alreadyToasted(readyVersion)) return;
    rememberToasted(readyVersion);
    toastRef.current('info', t('update.readyToast', readyVersion));
  }, [readyVersion]);

  if (!view) return null;

  const onClick = () => {
    const s = updateState();
    if (s.kind === 'downloadFailed') {
      retryUpdate();
      return;
    }
    if (s.kind !== 'ready' && s.kind !== 'installFailed') return;
    let unsaved = false;
    const guarded = async (): Promise<boolean> => {
      let ok = false;
      try {
        ok = (await p.flushAll()) === true;
      } catch {
        ok = false;
      }
      unsaved = !ok;
      return ok;
    };
    void installUpdate(guarded).then(() => {
      if (unsaved) toastRef.current('warn', t('update.unsaved'));
    });
  };

  const isReady = view.state === 'ready';
  return (
    <button
      ref={button}
      type="button"
      className="statusbar-item update-pill"
      data-state={view.state}
      title={view.title}
      aria-disabled={view.disabled ? 'true' : undefined}
      onClick={view.disabled ? undefined : onClick}
    >
      <Icon name={view.icon} size={14} className={view.spin ? 'spin' : undefined} />
      <span aria-live="polite">{isReady ? view.label : ''}</span>
      {!isReady && <span>{view.label}</span>}
    </button>
  );
}
