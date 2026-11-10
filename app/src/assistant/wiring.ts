/**
 * 말풍선을 앱에 잇는 곳(plan Task 10). App 이 명령 맥락(CommandContext)을 얻은 뒤 부른다.
 * - `connectAssistant`: 내장 런타임(`builtinRuntime`, 실행마다 새 `createAiEnv(ctx)`)을 등록하고 대화 갈래에 준다.
 *   차례 전 압축도 같은 제공자로 한다(`prepareHistory`, 문맥 창은 설정의 값).
 * - `bubbleActions`: 출처 열기(노트는 편집기, 주소는 `links/openExternal.ts` 로 시스템 브라우저)와 "노트에 넣기"
 *   (aiAnswerDialog 의 onInsert 처럼 `insertBlock`; 바깥 내용이 닿은 답은 `ai.confirm.tainted` 로 먼저 묻는다).
 */
import { createAiEnv } from '../ai/aiEnv';
import { t } from '../i18n/t';
import type { CommandContext } from '../labnote/commands/context';
import { insertBlock } from '../labnote/port/aiCommon';
import { openExternal, tauriExternalDeps } from '../links/openExternal';
import { builtinRuntime } from './builtinRuntime';
import { prepareHistory } from './compact';
import type { BubbleActions } from './MessageView';
import { registerRuntime, type AssistantRuntime } from './runtime';
import { safeTarget, type Source } from './sources';
import { assistantSession, type AssistantSession } from './useAssistantSession';

/** 출처 하나를 연다. 장부가 받지 않을 대상(다른 스킴, `..`)은 열지 않는다. */
export async function openSourceWith(
  src: Source,
  deps: { openFile(path: string): unknown; openUrl(url: string): unknown }
): Promise<void> {
  const target = safeTarget(src.kind, src.target);
  if (!target) return;
  if (src.kind === 'note') await deps.openFile(target);
  else await deps.openUrl(target);
}

export function bubbleActions(getCtx: () => CommandContext | undefined): BubbleActions {
  return {
    openSource(src) {
      const ctx = getCtx();
      if (!ctx) return;
      const notify = (kind: 'info' | 'warn', message: string) => ctx.host.notify(kind, message);
      void openSourceWith(src, {
        openFile: (path) => ctx.openFile(path),
        openUrl: (url) => openExternal(url, tauriExternalDeps(notify)),
      }).catch((err: unknown) => {
        console.warn('[labnoteo] assistant source did not open:', err);
        notify('warn', t('pet.openFailed'));
      });
    },
    async insert(text, tainted) {
      const ctx = getCtx();
      if (!ctx) return;
      if (tainted && !(await ctx.host.confirm(t('ai.confirm.tainted'), { confirmLabel: t('pet.insert') }))) return;
      const target = ctx.host.editTarget();
      if (!target) {
        ctx.host.notify('info', t('pet.noNote'));
        return;
      }
      try {
        await insertBlock(createAiEnv(ctx), target, text);
      } catch (err) {
        console.warn('[labnoteo] assistant insert failed:', err);
        ctx.host.notify('warn', t('pet.insertFailed'));
      }
    },
  };
}

/** 내장 런타임과 압축을 대화 갈래에 잇는다. 되돌리는 함수를 준다. */
export function connectAssistant(getCtx: () => CommandContext | undefined, session: AssistantSession = assistantSession): () => void {
  const runtime: AssistantRuntime = builtinRuntime(() => {
    const ctx = getCtx();
    if (!ctx) throw new Error('assistant: no command context');
    return createAiEnv(ctx);
  });
  let unregister: () => void = () => {};
  try {
    unregister = registerRuntime(runtime);
  } catch (err) {
    // Another connection (a second App mount) already holds the id; this one still drives its session.
    console.warn('[labnoteo] assistant runtime already registered:', err);
  }
  const off = session.configure({
    runtime: () => (getCtx() ? runtime : undefined),
    prepare: async (doc, signal) => {
      const ctx = getCtx();
      const provider = ctx ? createAiEnv(ctx).provider : null;
      if (!ctx || !provider) return { doc, compacted: false, failed: false };
      return prepareHistory(doc, provider, ctx.settings.llmContextWindow, signal);
    },
  });
  return () => {
    off();
    unregister();
  };
}
