// Commands of the context-aware AI (feat/ai-context, spec §7, §12.1). App
// commands, not vendor-registry ones: the plugin has no such ids
// (commandInventory.test.ts). `ai-draft-planning` joins in Task 16 with its dialog.
import type { AppCommand } from '../editor/commands/appCommands';
import { prefillInputCommand } from '../labnote/context/draftPlanning';
import { createAiEnv } from './aiEnv';

export const contextAppCommands: AppCommand[] = [
  {
    id: 'ai-prefill-input',
    nameKey: 'aiCtx.cmd.prefillInput',
    run: (ctx) => prefillInputCommand(createAiEnv(ctx)),
  },
];
