/**
 * 샘플 명령(plan SP5). 플러그인 main.ts 의 addCommand 를 본뜬다. 명령은 `available` 로 숨지 않고(D19), 못 할 때는
 * 플러그인의 문장으로 왜인지 말한다.
 */
import { t } from '../i18n/t';
import type { CommandContext } from '../labnote/commands/context';
import type { Command } from '../labnote/commands/registry';
import { openSampleDefinitionCommand } from '../labnote/port/sampleCommands';
import { insertExperimentSamplesTable } from '../labnote/port/sampleInsert';
import { createSampleEnv } from './env';
import { samples } from './sampleStore';

/**
 * 이 노트에서 샘플 추적이 켜져 있는가. 꺼져 있으면 플러그인처럼 원인(전역 설정, 또는 실험 README)을 말하고 false.
 * README 의 sample_tracking 을 아직 읽지 않았으면 읽을 때까지 기다린다(D11).
 */
export async function sampleTrackingOrExplain(ctx: CommandContext): Promise<boolean> {
  const path = ctx.activePath();
  const env = createSampleEnv(ctx);
  if (samples.configured) await samples.ready(path);
  if (env.trackingFor(path)) return true;
  ctx.host.notify(
    'info',
    ctx.settings.sampleTracking
      ? ctx.host.t("Sample tracking is off for this experiment: its README sets sample_tracking: 'no'.")
      : ctx.host.t('Sample tracking is turned off in {0}.', t('cmd.sampleSettings')),
  );
  return false;
}

export const sampleCommands: Command[] = [
  {
    id: 'insert-experiment-samples-table',
    nameKey: 'Insert sample list of this experiment',
    run: async (ctx) => {
      if (!(await sampleTrackingOrExplain(ctx))) return false;
      return insertExperimentSamplesTable(createSampleEnv(ctx));
    },
  },
  {
    id: 'open-sample-definition',
    nameKey: 'Open sample definition',
    run: async (ctx) => {
      // 원인을 말하는 문장은 옮겨 온 명령이 한다. README 의 sample_tracking 은 그 전에 읽어 둔다(D11).
      if (samples.configured) await samples.ready(ctx.activePath());
      await openSampleDefinitionCommand(createSampleEnv(ctx));
    },
  },
];
