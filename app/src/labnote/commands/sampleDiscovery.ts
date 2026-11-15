/**
 * 보관함을 열고 설정을 읽은 뒤 한 번: 샘플 추적이 켜져 있으면 설정에 없는 시료 종류의 대장(공동 작업자가 받아 온 것 등)을 찾아
 * 등록할지 묻는다(플러그인 main.ts 의 시작 때 discoverSampleTypes). 일은 옮겨 온 port/sampleDiscovery.ts 가 한다.
 * 여는 것을 막지 않고 던지지 않는다. 대장은 읽기만 한다.
 */
import { createSampleEnv } from '../../samples/env';
import { discoverSampleTypes } from '../port/sampleDiscovery';
import type { CommandContext } from './context';

export async function discoverSampleTypesOnOpen(ctx: CommandContext): Promise<void> {
  try {
    if (!ctx.settings.sampleTracking) return;
    await discoverSampleTypes(createSampleEnv(ctx));
  } catch (e) {
    console.error('[labnote] sample type discovery failed:', e);
  }
}
