/**
 * PartBank 명령(SP6). 플러그인 main.ts 의 addCommand 를 본뜬다. 플러그인은 'download-partbank-catalog' 를 실수로 두 번
 * 등록하지만(main.ts:603-621) 앱은 한 번만 등록한다. 연결이 설정되지 않았으면 플러그인의 checkCallback 처럼 팔레트에서 숨는다.
 */
import type { CommandContext } from '../labnote/commands/context';
import type { Command } from '../labnote/commands/registry';
import { overrideOr } from '../labnote/i18n';
import { downloadPartbankCatalog } from '../labnote/port/partbankCatalog';
import { createSampleEnv } from '../samples/env';
import { currentCatalogStore } from './catalogOverlay';
import { partbank } from './current';

/** partbank 연결이 하나라도 있는가(팔레트에 보일지). */
const configured = (ctx: CommandContext): boolean => partbank(ctx)?.configured === true;

export const partbankCommands: Command[] = [
  {
    id: 'download-partbank-catalog',
    nameKey: 'Download partbank catalog',
    available: configured,
    run: async (ctx) => {
      const feature = partbank(ctx);
      if (!feature) {
        // plugin: 'Set up a partbank connection in the plugin settings first.'
        ctx.host.notify('info', overrideOr('partbank.setupFirst'));
        return;
      }
      await downloadPartbankCatalog(createSampleEnv(ctx), feature, currentCatalogStore());
    },
  },
];
