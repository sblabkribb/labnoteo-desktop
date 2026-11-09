import type { Translator } from '@labnoteo/core';
import { getLang } from '../i18n/lang';
import type { InvokeFn } from '../integrations/netIpc';
import type { CommandContext } from '../labnote/commands/context';
import type { AppHost } from '../labnote/host/createAppHost';
import { createLlmProvider, type LlmProvider } from '../labnote/port/llmProvider';
import type { AppSettings } from '../labnote/settings';
import { createSampleEnv, type SampleEnv } from '../samples/env';

/**
 * AI 명령이 플러그인의 `LabnotePlugin` 대신 받는 것(SP6 Task 31). 명령 하나가 `createAiEnv(ctx)` 로 만든다.
 * - `provider` 는 만들 때의 설정으로 한 번 만든다. AI 를 끈 설정(`llmProvider: 'none'`)이면 null.
 * - `sampleEnv()` 는 처음 부를 때 만들어 두고 같은 것을 돌려준다.
 * - `invoke` 는 테스트가 넣는 가짜 Rust(없으면 Tauri). 제공자와 이후의 vaultGuard 가 쓴다.
 */
export interface AiEnv {
  readonly ctx: CommandContext;
  readonly host: AppHost;
  /** 플러그인 키 번역(coreT): 부를 때의 언어. */
  readonly t: Translator;
  settings(): AppSettings;
  readonly provider: LlmProvider | null;
  sampleEnv(): SampleEnv;
  /** 화면 언어(플러그인의 getObsidianLanguage). */
  lang(): 'ko' | 'en';
  readonly invoke?: InvokeFn;
}

export function createAiEnv(ctx: CommandContext, invoke?: InvokeFn): AiEnv {
  let samples: SampleEnv | undefined;
  return {
    ctx,
    host: ctx.host,
    t: ctx.host.t,
    settings: () => ctx.settings,
    provider: createLlmProvider(ctx.settings, invoke),
    sampleEnv: () => (samples ??= createSampleEnv(ctx)),
    lang: () => getLang(),
    invoke,
  };
}
