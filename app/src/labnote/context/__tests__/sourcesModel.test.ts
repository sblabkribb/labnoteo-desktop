import { describe, expect, it } from 'vitest';
import { contextBudget } from '../budget';
import { buildContext, type BuildInput, type BuiltContext } from '../contextBuilder';
import {
  fillPercent,
  fixedTokensOf,
  providerLabel,
  rebudget,
  tickSource,
  unitOpLookup,
  WINDOW_PRESETS,
  windowChoices,
} from '../sourcesModel';
import { buildFixtureVault, EXP_STRESS } from './fixtures';

const catalog: BuildInput['catalog'] = async () => undefined;
const STAGE4 = `${EXP_STRESS}/004_WB040_Stage 4.labnote.md`;

async function stress(window: number, fixed = 100): Promise<BuiltContext> {
  return buildContext({
    fs: await buildFixtureVault(),
    scope: { folder: EXP_STRESS, explicit: false, named: [] },
    target: { workflowPath: STAGE4, unitOpIndex: 9 },
    budgetTokens: contextBudget(window, fixed),
    catalog,
  });
}

describe('sourcesModel', () => {
  it('derives the fixed tokens back from the budget and the window', async () => {
    const built = await stress(2048, 100);
    expect(fixedTokensOf(built, 2048)).toBe(100);
    expect(fixedTokensOf({ budget: 0 }, 2048)).toBe(Math.floor(2048 * 0.6));
  });

  it('maps every unit op source id of the chain to its node', async () => {
    const built = await stress(2048);
    const uoOf = unitOpLookup(built.chain);
    expect(uoOf(`uo:${STAGE4}#8`)?.index).toBe(8);
    expect(uoOf('uo:elsewhere#0')).toBeUndefined();
  });

  it('a larger window turns summaries back to verbatim; a smaller one trims again', async () => {
    const small = await stress(2048);
    const summarised = small.sources.filter(s => s.kind === 'unitOp' && s.mode !== 'verbatim');
    expect(summarised.length).toBeGreaterThan(0);
    const fixed = fixedTokensOf(small, 2048);

    const large = rebudget(small, 200_000, fixed);
    expect(large.budget).toBe(contextBudget(200_000, fixed));
    for (const s of summarised) {
      const after = large.sources.find(x => x.id === s.id)!;
      expect(after).toMatchObject({ included: true, mode: 'verbatim' });
      expect(after.fullText).toBeUndefined();
    }
    expect(large.scope).toBe(small.scope);
    expect(large.issues).toBe(small.issues);

    const back = rebudget(large, 2048, fixed);
    expect(back.sources.map(s => [s.id, s.mode, s.included])).toEqual(small.sources.map(s => [s.id, s.mode, s.included]));
  });

  it('unticking removes a source and lowers the total; required sources cannot be unticked', async () => {
    const built = await stress(200_000);
    const fixed = fixedTokensOf(built, 200_000);
    const victim = built.sources.find(s => s.kind === 'unitOp' && s.included)!;
    const off = tickSource(built, victim.id, false, 200_000, fixed);
    expect(off.sources.find(s => s.id === victim.id)).toMatchObject({ included: false, reason: 'user' });
    expect(off.totalTokens).toBe(built.totalTokens - victim.tokens);

    const on = tickSource(off, victim.id, true, 200_000, fixed);
    expect(on.sources.find(s => s.id === victim.id)?.included).toBe(true);
    expect(on.totalTokens).toBe(built.totalTokens);

    const same = tickSource(built, 'target', false, 200_000, fixed);
    expect(same.sources.find(s => s.id === 'target')?.included).toBe(true);
  });

  it('offers the presets plus the current window, sorted and unique', () => {
    expect(windowChoices(8192)).toEqual([...WINDOW_PRESETS]);
    expect(windowChoices(10_000)).toEqual([...WINDOW_PRESETS, 10_000].sort((a, b) => a - b));
  });

  it('fill percent is clamped to 0..100', () => {
    expect(fillPercent(50, 200)).toBe(25);
    expect(fillPercent(500, 200)).toBe(100);
    expect(fillPercent(10, 0)).toBe(100);
    expect(fillPercent(0, 0)).toBe(0);
  });

  it('names the provider like the integration settings do', () => {
    expect(providerLabel('ollama')).toBe('Ollama');
    expect(providerLabel('openai')).toBe('OpenAI-compatible');
  });
});
