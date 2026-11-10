// Commands of the context-aware AI (feat/ai-context, spec §7, §12.1). App
// commands, not vendor-registry ones: the plugin has no such ids
// (commandInventory.test.ts).
import type { AppCommand } from '../editor/commands/appCommands';
import { contextSourcesDialog } from '../labnote/context/ContextSourcesDialog';
import { answerDialogShowDraft, draftPlanningCommand, prefillInputCommand } from '../labnote/context/draftPlanning';
import { providerLabel } from '../labnote/context/sourcesModel';
import { createAiEnv } from './aiEnv';

export const contextAppCommands: AppCommand[] = [
  {
    id: 'ai-draft-planning',
    nameKey: 'aiCtx.cmd.draftPlanning',
    run: (ctx) => {
      const env = createAiEnv(ctx);
      const settings = env.settings();
      return draftPlanningCommand({
        env,
        pickSources: (built, window) =>
          contextSourcesDialog(built, window, providerLabel(settings.llmProvider), settings.llmModel),
        showDraft: answerDialogShowDraft,
      });
    },
  },
  {
    id: 'ai-prefill-input',
    nameKey: 'aiCtx.cmd.prefillInput',
    run: (ctx) => prefillInputCommand(createAiEnv(ctx)),
  },
];
