import { getVersion } from '@tauri-apps/api/app';
import type { CommandContext } from '../labnote/commands/context';
import { t } from '../i18n/t';
import { checkForUpdatesNow, type UpdateState } from './updateStore';

export interface CheckCommandDeps {
  check: () => Promise<UpdateState>;
  version: () => Promise<string>;
}

/**
 * 팔레트의 "업데이트 확인". 직접 확인이라 "나중에"를 지운다. 최신이면 지금 버전을, 실패하면 연결을 확인하라고
 * 알린다. 새 버전이면 알림(UpdateBanner)이 보이니 토스트는 띄우지 않는다. 내려받기와 설치는 알림에서 누를 때만 한다.
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
  }
  return s;
}
