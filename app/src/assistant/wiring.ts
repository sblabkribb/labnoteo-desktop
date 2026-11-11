/**
 * 말풍선을 앱에 잇는 곳(plan Task 10). App 이 명령 맥락(CommandContext)을 얻은 뒤 부른다.
 * - `connectAssistant`: 내장 런타임(`builtinRuntime`, 실행마다 새 `createAiEnv(ctx)`)을 등록하고 대화 갈래에 준다.
 *   차례 전 압축도 같은 제공자로 한다(`prepareHistory`, 문맥 창은 설정의 값).
 * - `bubbleActions`: 출처 열기(노트는 편집기, 주소는 `links/openExternal.ts` 로 시스템 브라우저)와 "노트에 넣기"
 *   (aiAnswerDialog 의 onInsert 처럼 `insertBlock`; 바깥 내용이 닿은 답은 `ai.confirm.tainted` 로 먼저 묻는다).
 *   칩(Task 11B)을 위해: 명령 부르기(`findCommand` → `runCommand`, 실패는 알림), 열린 노트의 글과 커서 줄,
 *   실험 폴더의 워크플로 노트 목록(`###_….md`, README 빼고, 번호 차례). 웹 검색 주소가 있는지(Task 14, 안내 칩).
 */
import { createAiEnv } from '../ai/aiEnv';
import { t } from '../i18n/t';
import { findCommand } from '../editor/commands/appCommands';
import type { CommandContext } from '../labnote/commands/context';
import { runCommand } from '../labnote/commands/runCommand';
import { insertBlock } from '../labnote/port/aiCommon';
import { openExternal, tauriExternalDeps } from '../links/openExternal';
import { builtinRuntime } from './builtinRuntime';
import { isWorkflowNotePath } from './chips';
import { readAssistantConfig } from './config';
import { prepareHistory } from './compact';
import type { BubbleActions } from './MessageView';
import { registerRuntime, type AssistantRuntime } from './runtime';
import { catalogIdOf, noteFileOf, safeTarget, type Source } from './sources';
import { revealCatalogEntry } from '../labnote/panel/catalogReveal';
import { assistantSession, type AssistantSession } from './useAssistantSession';

/**
 * 출처 하나를 연다. 장부가 받지 않을 대상(다른 스킴, `..`)은 열지 않는다. 카탈로그 항목(`…json#WB150`)은 `revealCatalog` 가
 * 있으면 실험 탭 카탈로그에서 그 항목을 보인다(JSON 파일을 열면 "노트가 아닌 파일" 카드뿐이고 항목은 보이지 않는다).
 */
export async function openSourceWith(
  src: Source,
  deps: { openFile(path: string): unknown; openUrl(url: string): unknown; revealCatalog?(id: string): unknown }
): Promise<void> {
  const target = safeTarget(src.kind, src.target);
  if (!target) return;
  if (src.kind !== 'note') {
    await deps.openUrl(target);
    return;
  }
  const catalogId = catalogIdOf(target);
  if (catalogId !== undefined && deps.revealCatalog) await deps.revealCatalog(catalogId);
  else await deps.openFile(noteFileOf(target));
}

/** 글자 위치(offset)의 줄 번호(0부터). */
export function lineAt(text: string, offset: number): number {
  let line = 0;
  const end = Math.max(0, Math.min(offset, text.length));
  for (let i = 0; i < end; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

export function bubbleActions(getCtx: () => CommandContext | undefined): BubbleActions {
  return {
    runCommand(id) {
      const ctx = getCtx();
      const cmd = findCommand(id);
      if (!ctx || !cmd) {
        console.warn('[labnoteo] assistant: no command', id);
        return;
      }
      void runCommand(ctx, cmd);
    },
    async activeNote() {
      const target = getCtx()?.host.editTarget();
      if (!target) return undefined;
      const text = await target.getText();
      const offset = await target.getCursorOffset?.();
      return { path: target.path, text, ...(offset !== undefined ? { cursorLine: lineAt(text, offset) } : {}) };
    },
    async workflowNotes(folder) {
      const ctx = getCtx();
      if (!ctx) return [];
      const dir = folder.replace(/\\/g, '/').replace(/\/+$/, '');
      const names = await ctx.host.fs.list(dir);
      return names
        .filter((n) => !n.includes('/') && isWorkflowNotePath(n))
        .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
        .map((n) => `${dir}/${n}`);
    },
    async webSearchConfigured() {
      return !!(await readAssistantConfig()).searxngUrl;
    },
    openSource(src) {
      const ctx = getCtx();
      if (!ctx) return;
      const notify = (kind: 'info' | 'warn', message: string) => ctx.host.notify(kind, message);
      void openSourceWith(src, {
        openFile: (path) => ctx.openFile(path),
        openUrl: (url) => openExternal(url, tauriExternalDeps(notify)),
        revealCatalog: (id) => {
          ctx.showPanel('workflows');
          revealCatalogEntry(id);
        },
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
