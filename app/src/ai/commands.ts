import type { Command } from '../labnote/commands/registry';
import { askAgentCommand } from '../labnote/port/aiAskAgent';
import { draftMethodCommand } from '../labnote/port/aiDraftMethod';
import { extractSamplesCommand } from '../labnote/port/aiExtractSamples';
import { isExperimentReadme, summarizeExperimentCommand, summarizeResultsCommand } from '../labnote/port/aiSummaries';
import { createAiEnv } from './aiEnv';

/** 열린 노트가 실험 README 인가. 열린 노트가 없으면 아니다. */
const onReadme = (path: string | undefined): boolean => !!path && isExperimentReadme(path);

/**
 * 다섯 AI 명령(SP6 Task 36). 플러그인 main.ts:658-692 의 id, 이름, 차례, 보이는 조건 그대로다.
 * 제공자를 검사해 숨기지 않는다(D21): 제공자가 없으면 명령이 t('ai.configureFirst') 를 알린다.
 */
export const aiCommands: Command[] = [
  {
    id: 'ai-draft-method',
    nameKey: 'AI: Draft Method section',
    run: (ctx) => draftMethodCommand(createAiEnv(ctx)),
  },
  {
    id: 'ai-summarize-results',
    nameKey: 'AI: Summarize workflow results',
    available: (ctx) => !onReadme(ctx.activePath()),
    run: (ctx) => summarizeResultsCommand(createAiEnv(ctx)),
  },
  {
    id: 'ai-summarize-experiment',
    nameKey: 'AI: Summarize experiment results',
    available: (ctx) => onReadme(ctx.activePath()),
    run: (ctx) => summarizeExperimentCommand(createAiEnv(ctx)),
  },
  {
    id: 'ai-extract-samples',
    nameKey: 'AI: Extract sample definitions',
    run: (ctx) => extractSamplesCommand(createAiEnv(ctx)),
  },
  {
    id: 'ai-ask-agent',
    nameKey: 'AI: Ask assistant (uses tools)',
    run: (ctx) => askAgentCommand(createAiEnv(ctx)),
  },
];
