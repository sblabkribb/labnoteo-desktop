/**
 * 바깥 주소 열기(SP4 Task 11).
 * - 허용 스킴(http, https, mailto, partbank)만 시스템 브라우저/앱으로 넘긴다. capabilities/default.json 의
 *   opener:allow-open-url 범위와 같은 목록이다.
 * - 그 밖의 주소(file:, javascript: 등)는 열지 않고 클립보드에 복사한 뒤 알린다.
 * - 열기가 실패해도 주소를 잃지 않도록 복사하고 알린다. 복사마저 실패해도 알림은 남는다.
 */
import { openUrl } from '@tauri-apps/plugin-opener';
import { t } from '../i18n/t';

export const EXTERNAL_SCHEMES = /^(https?:\/\/|mailto:|partbank:)/i;

export interface ExternalDeps {
  open(url: string): Promise<void>;
  copy(text: string): Promise<void>;
  notify(kind: 'info' | 'warn', message: string): void;
}

async function copyAndWarn(url: string, failed: boolean, deps: ExternalDeps) {
  try {
    await deps.copy(url);
  } catch {
    // 클립보드를 못 써도 알림에 주소가 그대로 남는다
  }
  deps.notify('warn', t(failed ? 'links.external.failed' : 'links.external.copied', url));
  return 'copied' as const;
}

export async function openExternal(url: string, deps: ExternalDeps): Promise<'opened' | 'copied'> {
  if (!EXTERNAL_SCHEMES.test(url)) return copyAndWarn(url, false, deps);
  try {
    await deps.open(url);
    return 'opened';
  } catch {
    return copyAndWarn(url, true, deps);
  }
}

export function tauriExternalDeps(notify: ExternalDeps['notify']): ExternalDeps {
  return {
    open: (url) => openUrl(url),
    copy: (text) => navigator.clipboard.writeText(text),
    notify,
  };
}
