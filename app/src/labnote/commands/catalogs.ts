/**
 * 카탈로그 명령: 'update-catalogs'(플러그인 main.ts 의 같은 명령), 그리고 보관함을 열 때 한 번 하는 "카탈로그 업데이트가
 * 있다" 알림(플러그인 main.ts 의 시작 알림). 일은 옮겨 온 port/catalogUpdate.ts 가 한다. 루트는 그 안의 '.'(VAULT_ROOT)다.
 */
import { catalogUpdateNotice, updateCatalogsCommand } from '../port/catalogUpdate';
import type { CommandContext } from './context';
import type { Command } from './registry';

/** 'update-catalogs': 바뀔 것을 보여 주고, 확인하면 쓴다. 쓴 파일이 있으면 화면을 다시 읽는다. */
export async function updateCatalogs(ctx: CommandContext): Promise<void> {
  if (await updateCatalogsCommand(ctx.host)) ctx.refresh();
}

/**
 * 보관함을 열고 설정을 읽은 뒤 한 번: 번들 카탈로그가 바뀌었으면(해시가 settings.catalogNoticeHash 와 다르면) 업데이트할 것이
 * 있는지 알리고 해시를 저장한다. 여는 것을 막지 않고 던지지 않는다. 읽지 못하면 해시를 그대로 두어 다음에 다시 본다.
 */
export async function catalogNoticeOnOpen(ctx: CommandContext): Promise<void> {
  try {
    const stored = ctx.settings.catalogNoticeHash ?? '';
    const next = await catalogUpdateNotice(ctx.host, stored);
    if (next !== stored) ctx.updateSettings({ catalogNoticeHash: next });
  } catch (e) {
    console.error('[labnote] catalog notice failed:', e);
  }
}

/** registerAll.ts 가 등록하는 카탈로그 명령. */
export const catalogCommands: Command[] = [
  { id: 'update-catalogs', nameKey: 'Update catalogs', icon: 'refresh-cw', run: (ctx) => updateCatalogs(ctx) },
];
