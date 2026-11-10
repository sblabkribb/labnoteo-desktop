import { describe, expect, it } from 'vitest';
import { buildChain, type UnitOpNode } from '../chain';
import { applyBudget, contextBudget, outlineUnitOp, summariseUnitOp, toggleSource } from '../budget';
import { estimateTokens } from '../tokens';
import type { ContextSource, SourceKind } from '../types';
import { buildFixtureVault, EXP_MAIN, EXP_STRESS, MAIN_FILES } from './fixtures';

/** A unit op as the builder would show it verbatim: heading plus every section. */
function verbatim(uo: UnitOpNode): string {
  return [uo.heading, ...Object.entries(uo.sections).map(([k, v]) => `#### ${k}\n${v}`)].join('\n\n');
}

function src(id: string, kind: SourceKind, text: string, extra: Partial<ContextSource> = {}): ContextSource {
  return {
    id,
    kind,
    label: id,
    text,
    mode: 'verbatim',
    tokens: estimateTokens(text),
    distance: 0,
    required: false,
    included: true,
    ...extra,
  };
}

const byId = (sources: readonly ContextSource[], id: string): ContextSource => {
  const s = sources.find(x => x.id === id);
  if (!s) throw new Error(`no source ${id}`);
  return s;
};

/** The stress folder: target = the very last of 40 unit ops, every earlier unit op a source. */
async function stressSources(): Promise<{
  sources: ContextSource[];
  uoOf: (id: string) => UnitOpNode | undefined;
  ids: string[];
}> {
  const chain = await buildChain(await buildFixtureVault(), EXP_STRESS);
  const all = chain.workflows.flatMap(w => w.unitOps);
  expect(all).toHaveLength(40);
  const target = all[all.length - 1];
  const map = new Map<string, UnitOpNode>();
  const sources: ContextSource[] = [src('readme:goal', 'goal', chain.goal)];
  const ids: string[] = [];
  all.slice(0, -1).forEach((uo, k) => {
    const id = `uo:${uo.workflowPath}#${uo.index}`;
    map.set(id, uo);
    ids.push(id);
    sources.push(
      src(id, 'unitOp', verbatim(uo), { path: uo.workflowPath, heading: uo.heading, distance: all.length - 1 - k })
    );
  });
  map.set('target', target);
  sources.push(
    src('target', 'target', verbatim(target), { required: true, path: target.workflowPath, heading: target.heading })
  );
  return { sources, uoOf: id => map.get(id), ids };
}

describe('contextBudget', () => {
  it('is floor(window * 0.6) - fixed, never below 0', () => {
    expect(contextBudget(4096, 300)).toBe(2457 - 300);
    expect(contextBudget(8192, 0)).toBe(4915);
    expect(contextBudget(4096, 5000)).toBe(0);
    expect(contextBudget(Number.NaN, 10)).toBe(0);
  });
});

describe('summariseUnitOp / outlineUnitOp', () => {
  it('summarises heading, IDs, the first two Method lines and Parameters as key: value (no LLM)', async () => {
    const chain = await buildChain(await buildFixtureVault(), EXP_MAIN);
    const codon = chain.workflows.find(w => w.path === MAIN_FILES.expression)!.unitOps[0];
    const summary = summariseUnitOp(codon);
    expect(summary).toContain('### [USW010 Codon Check] 코돈 확인');
    expect(summary).toContain('Input: DNA-3');
    expect(summary).toContain('Output: DNA-4');
    expect(summary).toContain('host: E. coli');
    expect(summary).not.toContain('(method used in this step)'); // a placeholder Method is left out
    expect(summary).not.toContain('Windows 11');
    expect(outlineUnitOp(codon)).toBe('### [USW010 Codon Check] 코돈 확인\nInput: DNA-3\nOutput: DNA-4');
  });

  it('keeps at most 2 Method lines and 10 Parameters, including table rows', () => {
    const uo: UnitOpNode = {
      workflowPath: 'w.md',
      index: 0,
      heading: '### [UHW010 PCR]',
      opId: 'UHW010',
      title: 'PCR',
      alias: '',
      kind: 'hw',
      sections: {
        Method: '```\nnot me\n```\n- first\n\n- second\n- third',
        Parameters: ['| Parameter | Value |', '|---|---|', ...Array.from({ length: 12 }, (_, i) => `| p${i} | ${i} |`)].join(
          '\n'
        ),
      },
      inputIds: [],
      outputIds: ['DNA-2'],
    };
    const summary = summariseUnitOp(uo);
    expect(summary).toContain('- first');
    expect(summary).toContain('- second');
    expect(summary).not.toContain('third');
    expect(summary).not.toContain('not me');
    expect(summary).not.toContain('Parameter: Value');
    expect(summary).toContain('p0: 0');
    expect(summary).toContain('p9: 9');
    expect(summary).not.toContain('p10');
    expect(summary).toContain('Input: (none)');
    expect(outlineUnitOp(uo)).toBe('### [UHW010 PCR]\nInput: (none)\nOutput: DNA-2');
  });
});

describe('applyBudget: priority order (spec §5.5)', () => {
  const RANKED: [string, SourceKind, Partial<ContextSource>][] = [
    ['uo:prev', 'unitOp', { distance: 1 }],
    ['target:input-prefill', 'prefill', {}],
    ['readme:goal', 'goal', {}],
    ['uo:near', 'unitOp', { distance: 2 }],
    ['uo:far', 'unitOp', { distance: 3 }],
    ['sample:DNA:DNA-1', 'sample', {}],
    ['catalog:UHW020', 'catalog', {}],
    ['wf:near', 'workflow', { distance: 4 }],
    ['wf:far', 'workflow', { distance: 9 }],
    ['named:labnote/009_X', 'named', {}],
    ['uo:a#0:results', 'results', { distance: 2 }],
  ];
  const TEN = 'x'.repeat(40); // 10 tokens

  function shuffled(): ContextSource[] {
    const list = RANKED.map(([id, kind, extra]) => src(id, kind, TEN, extra));
    // Input order must not matter: reverse it and put the required sources in the middle.
    const required = [
      src('target', 'target', TEN, { required: true }),
      src('catalog:UHW030', 'catalog', TEN, { required: true }),
    ];
    const rev = list.reverse();
    return [...rev.slice(0, 5), ...required, ...rev.slice(5)];
  }

  it('keeps required sources first, then the highest-ranked sources that fit', () => {
    for (let k = 0; k <= RANKED.length; k++) {
      const res = applyBudget(shuffled(), 20 + 10 * k);
      const kept = res.sources.filter(s => s.included && !s.required).map(s => s.id);
      expect(new Set(kept)).toEqual(new Set(RANKED.slice(0, k).map(r => r[0])));
      expect(res.sources.filter(s => s.required).every(s => s.included)).toBe(true);
      expect(res.totalTokens).toBe(20 + 10 * k);
      expect(res.overBudget).toBe(false);
      for (const s of res.sources.filter(x => !x.included)) expect(s.reason).toBe('trimmed');
      expect(new Set(res.trimmed)).toEqual(new Set(RANKED.slice(k).map(r => r[0])));
    }
  });

  it('keeps the input order of sources in the result', () => {
    const input = shuffled();
    expect(applyBudget(input, 10_000).sources.map(s => s.id)).toEqual(input.map(s => s.id));
  });

  it('truncates the goal to 1500 tokens', () => {
    const res = applyBudget([src('readme:goal', 'goal', 'goal '.repeat(3000))], 100_000);
    const goal = byId(res.sources, 'readme:goal');
    expect(goal.included).toBe(true);
    expect(goal.tokens).toBeLessThanOrEqual(1500);
    expect(goal.tokens).toBe(estimateTokens(goal.text));
    expect(res.trimmed).toEqual(['readme:goal']);
  });

  it('leaves default-excluded results out unless ticked', () => {
    const res = applyBudget([src('uo:a#0:results', 'results', TEN, { included: false, reason: 'default' })], 10_000);
    expect(byId(res.sources, 'uo:a#0:results')).toMatchObject({ included: false, reason: 'default' });
    expect(res.trimmed).toEqual([]);
    const ticked = applyBudget(toggleSource(res.sources, 'uo:a#0:results', true), 10_000);
    expect(byId(ticked.sources, 'uo:a#0:results').included).toBe(true);
  });
});

describe('applyBudget: the 40-UO folder at 4096 (nearest verbatim, older summarised)', () => {
  it('keeps the target and the previous UO verbatim, summarises mid-distance UOs and outlines or drops far ones', async () => {
    const { sources, uoOf, ids } = await stressSources();
    const budget = contextBudget(4096, 300);
    const res = applyBudget(sources, budget, uoOf);

    expect(res.budget).toBe(budget);
    expect(res.overBudget).toBe(false);
    expect(res.totalTokens).toBeLessThanOrEqual(budget);
    expect(res.totalTokens).toBe(res.sources.filter(s => s.included).reduce((n, s) => n + s.tokens, 0));

    expect(byId(res.sources, 'target')).toMatchObject({ included: true, mode: 'verbatim' });
    const nearestFirst = [...ids].reverse().map(id => byId(res.sources, id));
    expect(nearestFirst[0]).toMatchObject({ distance: 1, included: true, mode: 'verbatim' });
    expect(nearestFirst[1]).toMatchObject({ included: true, mode: 'verbatim' });

    // Monotone by distance: verbatim, then summary, then outline, then dropped.
    const rank = (s: ContextSource) => (!s.included ? 3 : s.mode === 'verbatim' ? 0 : s.mode === 'summary' ? 1 : 2);
    const ranks = nearestFirst.map(rank);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(ranks.filter(r => r === 1).length).toBeGreaterThanOrEqual(3);
    expect(ranks.filter(r => r === 2).length).toBeGreaterThanOrEqual(3);
    expect(rank(nearestFirst[nearestFirst.length - 1])).toBeGreaterThanOrEqual(2);

    for (const s of nearestFirst) {
      const uo = uoOf(s.id)!;
      if (s.included && s.mode === 'summary') expect(s.text).toBe(summariseUnitOp(uo));
      if (s.included && s.mode === 'outline') expect(s.text).toBe(outlineUnitOp(uo));
      expect(s.tokens).toBe(estimateTokens(s.text));
      if (s.mode !== 'verbatim' || !s.included) expect(res.trimmed).toContain(s.id);
    }
  });

  it('is deterministic and does not mutate its input', async () => {
    const { sources, uoOf } = await stressSources();
    const before = structuredClone(sources);
    const a = applyBudget(sources, 2000, uoOf);
    const b = applyBudget(sources, 2000, uoOf);
    expect(a).toEqual(b);
    expect(sources).toEqual(before);
  });

  it('brings trimmed sources back verbatim when the window grows', async () => {
    const { sources, uoOf, ids } = await stressSources();
    const small = applyBudget(sources, contextBudget(4096, 300), uoOf);
    expect(small.trimmed.length).toBeGreaterThan(0);
    const big = applyBudget(small.sources, contextBudget(128_000, 300), uoOf);
    expect(big.trimmed).toEqual([]);
    for (const id of ids) {
      const s = byId(big.sources, id);
      expect(s).toMatchObject({ included: true, mode: 'verbatim', text: byId(sources, id).text });
      expect(s.reason).toBeUndefined();
    }
    // Shrinking again gives the same result as the first run.
    expect(applyBudget(big.sources, contextBudget(4096, 300), uoOf)).toEqual(small);
  });
});

describe('applyBudget: required sources and user choices', () => {
  it('keeps required sources and flags overBudget when the target alone is too large', () => {
    const huge = ['### [UHW010 PCR]', '#### Input', '- DNA-1', '#### Method', 'm'.repeat(20_000), '#### Output', '- DNA-2'].join(
      '\n'
    );
    const sources = [
      src('target', 'target', huge, { required: true }),
      src('catalog:UHW010', 'catalog', 'PCR: amplify DNA', { required: true }),
      src('readme:goal', 'goal', 'goal'),
    ];
    const res = applyBudget(sources, 200);
    expect(res.overBudget).toBe(true);
    const target = byId(res.sources, 'target');
    expect(target.included).toBe(true);
    expect(target.text).toContain('- DNA-1');
    expect(target.text).toContain('- DNA-2');
    expect(target.text).toContain('m'.repeat(400));
    expect(target.text).not.toContain('m'.repeat(401));
    expect(target.tokens).toBe(estimateTokens(target.text));
    expect(byId(res.sources, 'catalog:UHW010').included).toBe(true);
    expect(byId(res.sources, 'readme:goal')).toMatchObject({ included: false, reason: 'trimmed' });
    expect(res.trimmed).toEqual(expect.arrayContaining(['target', 'readme:goal']));
  });

  it('never re-includes a source the user unticked, even with room to spare', async () => {
    const { sources, uoOf, ids } = await stressSources();
    const id = ids[ids.length - 1];
    const off = toggleSource(sources, id, false);
    expect(byId(off, id)).toMatchObject({ included: false, reason: 'user' });
    const res = applyBudget(off, 1_000_000, uoOf);
    expect(byId(res.sources, id)).toMatchObject({ included: false, reason: 'user' });
    expect(res.trimmed).not.toContain(id);
    const back = applyBudget(toggleSource(res.sources, id, true), 1_000_000, uoOf);
    expect(byId(back.sources, id)).toMatchObject({ included: true, mode: 'verbatim' });
    expect(byId(back.sources, id).reason).toBeUndefined();
  });

  it('toggleSource on a required id is a no-op, and on an unknown id too', () => {
    const sources = [src('target', 'target', 'T', { required: true }), src('readme:goal', 'goal', 'G')];
    expect(toggleSource(sources, 'target', false)).toEqual(sources);
    expect(toggleSource(sources, 'nope', false)).toEqual(sources);
    expect(sources[0].included).toBe(true);
  });

  it('includes a required source even when it arrives unticked', () => {
    const res = applyBudget([src('target', 'target', 'T', { required: true, included: false, reason: 'user' })], 100);
    expect(byId(res.sources, 'target').included).toBe(true);
    expect(byId(res.sources, 'target').reason).toBeUndefined();
  });
});
