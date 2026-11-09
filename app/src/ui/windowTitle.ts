import { getCurrentWindow } from '@tauri-apps/api/window';
import { t } from '../i18n/t';

/** 창 제목에 쓰는 이음새. 기본은 Tauri 창(core:window:allow-set-title). */
export interface TitleWindowApi {
  setTitle(title: string): Promise<void>;
}

/**
 * 창 제목을 `labnoteO — <보관함>` 으로 건다(보관함이 없으면 `labnoteO`). 왼쪽 독을 숨겨도 어느 보관함인지 보인다.
 * 창 API 가 없거나(테스트, 브라우저 하네스) 권한이 없으면 조용히 넘어간다.
 */
export function setWindowTitle(vaultName: string | undefined, win?: TitleWindowApi): void {
  const title = vaultName ? t('window.title', vaultName) : t('app.title');
  // 문서 제목도 같게(브라우저 하네스와 작업 표시줄 미리 보기)
  if (typeof document !== 'undefined') document.title = title;
  try {
    const w = win ?? (getCurrentWindow() as unknown as Partial<TitleWindowApi>);
    if (typeof w.setTitle !== 'function') return;
    Promise.resolve(w.setTitle(title)).catch(() => undefined);
  } catch {
    // 창 API 가 없다
  }
}
