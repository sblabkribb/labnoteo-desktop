import { getVersion } from '@tauri-apps/api/app';
import type { CommandContext } from '../labnote/commands/context';
import { t } from '../i18n/t';
import { checkForUpdatesNow, type UpdateState } from './updateStore';

export interface CheckCommandDeps {
  check: () => Promise<UpdateState>;
  version: () => Promise<string>;
}

/**
 * 팔레트의 "업데이트 확인". 최신이면 지금 버전을, 실패하면 연결을 확인하라고 알린다. 새 버전은 뒤에서 조용히
 * 받으므로, 받는 중이면 이미 받고 있다고, 다 받았으면 왼쪽 아래 '업데이트'를 누르라고 알린다. 설치는 그 버튼을
 * 누를 때만 한다.
 */
export async function runCheckForUpdates(ctx: CommandContext, over: Partial<CheckCommandDeps> = {}): Promise<UpdateState> {
  const d: CheckCommandDeps = { check: checkForUpdatesNow, version: getVersion, ...over };
  const s = await d.check();
  if (s.kind === 'upToDate') {
    let v = '';
    try {
      v = await d.version();
    } catch {
      // 버전을 못 읽어도 최신이라는 것은 알린다
    }
    ctx.host.notify('info', t('update.upToDate', v));
  } else if (s.kind === 'failed') {
    ctx.host.notify('warn', t('update.checkFailed'));
  } else if (s.kind === 'downloading') {
    ctx.host.notify('info', t('update.alreadyGetting', s.version));
  } else if (s.kind === 'ready') {
    ctx.host.notify('info', t('update.readyToast', s.version));
  }
  return s;
}
