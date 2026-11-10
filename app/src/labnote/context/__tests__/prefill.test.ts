import { describe, expect, it } from 'vitest';
import { HW_PLACEHOLDERS, SW_PLACEHOLDERS } from '@labnoteo/core/lib/unitOpTemplate';
import { buildChain, type ExperimentChain } from '../chain';
import { applyPrefill, prefillInput, type PrefillResult } from '../prefill';
import { buildFixtureVault, EXP_LEGACY, EXP_MAIN, MAIN_FILES } from './fixtures';

async function mainChain(): Promise<ExperimentChain> {
  return buildChain(await buildFixtureVault(), EXP_MAIN);
}

const NAMES: Record<string, string> = { 'DNA-2': 'PCR product', 'Protein-1': '발현 단백질' };
const registryName = (id: string): string | undefined => NAMES[id];
const noName = (): string | undefined => undefined;

describe('prefillInput', () => {
  it('takes the previous Output of the same workflow, with registry names', async () => {
    const chain = await mainChain();
    expect(prefillInput(chain, { workflowPath: MAIN_FILES.cloning, unitOpIndex: 1 }, registryName)).toEqual({
      ids: ['DNA-2'],
      lines: ['- DNA-2 — PCR product'],
      from: { path: MAIN_FILES.cloning, heading: '### [UHW010 PCR] 증폭' },
    });
  });

  it('hands the last Output of workflow N to the first Input of workflow N+1', async () => {
    const chain = await mainChain();
    expect(prefillInput(chain, { workflowPath: MAIN_FILES.check, unitOpIndex: 0 }, registryName)).toEqual({
      ids: ['Protein-1'],
      lines: ['- Protein-1 — 발현 단백질'],
      from: { path: MAIN_FILES.expression, heading: '### [UHW030 Induction]' },
    });
  });

  it('skips a workflow without unit ops and works on legacy workflow names', async () => {
    const chain = await mainChain();
    // 005 Analysis has no UOs; the legacy `007_Old Step.md` follows 004 Purify.
    expect(prefillInput(chain, { workflowPath: MAIN_FILES.legacy, unitOpIndex: 0 }, noName)).toEqual({
      ids: ['Protein-2'],
      lines: ['- Protein-2'],
      from: { path: MAIN_FILES.purify, heading: '### [UHW050 Ni-NTA]' },
    });
    const legacy = await buildChain(await buildFixtureVault(), EXP_LEGACY);
    expect(prefillInput(legacy, { workflowPath: `${EXP_LEGACY}/001_Prep.md`, unitOpIndex: 0 }, noName)).toEqual({
      reason: 'noPrevious',
    });
  });

  it('ignores `(new: …)` lines', async () => {
    const chain = await mainChain();
    const r = prefillInput(chain, { workflowPath: MAIN_FILES.expression, unitOpIndex: 0 }, noName);
    expect(r).toMatchObject({ ids: ['DNA-3'], lines: ['- DNA-3'] });
  });

  it('reports noPrevious at the first unit op and noOutput when the previous Output has no IDs', async () => {
    const chain = await mainChain();
    expect(prefillInput(chain, { workflowPath: MAIN_FILES.cloning, unitOpIndex: 0 }, registryName)).toEqual({
      reason: 'noPrevious',
    });
    // 003 Check's Output is `- (none)`.
    expect(prefillInput(chain, { workflowPath: MAIN_FILES.purify, unitOpIndex: 0 }, registryName)).toEqual({
      reason: 'noOutput',
    });
  });
});

const NOTE = (input: string[] | undefined, opts: { meta?: boolean } = {}): string =>
  [
    '## [WB010 Cloning]',
    '',
    '### [UHW010 PCR]',
    '',
    '#### Output',
    '- DNA-2',
    '',
    '#### Results & Discussions',
    '- Band at 1.2 kb',
    '',
    '### [UHW020 Gel Purification] 겔',
    '',
    ...(opts.meta === false ? [] : ['#### Meta', '- Experimenter: Kim', '']),
    ...(input === undefined ? [] : ['#### Input', ...input, '']),
    '#### Method',
    '- run the gel',
    '',
    '#### Results & Discussions',
    '- DNA-7 looked fine',
    '',
    '#### QC Metrics',
    '- yield',
    '',
  ].join('\n');

const HEADING = '### [UHW020 Gel Purification] 겔';
const TARGET = { unitOpIndex: 1, heading: HEADING };
const TWO: PrefillResult = {
  ids: ['DNA-2', 'DNA-3'],
  lines: ['- DNA-2 — PCR product', '- DNA-3'],
  from: { path: 'w.md', heading: '### [UHW010 PCR]' },
};
const FILLED = ['- DNA-2 — PCR product', '- DNA-3'];

describe('applyPrefill', () => {
  it('replaces an empty Input', () => {
    expect(applyPrefill(NOTE([]), TARGET, TWO)).toBe(NOTE(FILLED));
  });

  it('replaces a placeholder-only Input (HW and SW placeholders)', () => {
    expect(applyPrefill(NOTE([HW_PLACEHOLDERS.Input]), TARGET, TWO)).toBe(NOTE(FILLED));
    expect(applyPrefill(NOTE([SW_PLACEHOLDERS.Input]), TARGET, TWO)).toBe(NOTE(FILLED));
  });

  it('keeps researcher text and appends only the missing IDs', () => {
    const before = NOTE(['- DNA-2 ; from the PCR', '- buffer left over']);
    expect(applyPrefill(before, TARGET, TWO)).toBe(NOTE(['- DNA-2 ; from the PCR', '- buffer left over', '- DNA-3']));
  });

  it('does not count a longer ID or a `(new: …)` line as present', () => {
    const before = NOTE(['- DNA-2-1', '- (new: DNA-3 later)']);
    expect(applyPrefill(before, TARGET, TWO)).toBe(NOTE(['- DNA-2-1', '- (new: DNA-3 later)', ...FILLED]));
  });

  it('gives undefined when there is nothing to do', () => {
    expect(applyPrefill(NOTE(['- DNA-2', '- DNA-3 ; insert']), TARGET, TWO)).toBeUndefined();
    expect(applyPrefill(NOTE([]), TARGET, { reason: 'noPrevious' })).toBeUndefined();
    expect(applyPrefill(NOTE([]), TARGET, { reason: 'noOutput' })).toBeUndefined();
  });

  it('inserts a missing Input heading right after Meta', () => {
    expect(applyPrefill(NOTE(undefined), TARGET, TWO)).toBe(NOTE(FILLED));
  });

  it('inserts a missing Input heading right after the UO heading when there is no Meta', () => {
    expect(applyPrefill(NOTE(undefined, { meta: false }), TARGET, TWO)).toBe(NOTE(FILLED, { meta: false }));
  });

  it('writes nothing when the heading at unitOpIndex changed or the UO is gone', () => {
    const md = NOTE([]);
    expect(applyPrefill(md, { unitOpIndex: 1, heading: '### [UHW020 Gel Purification]' }, TWO)).toBeUndefined();
    expect(applyPrefill(md, { unitOpIndex: 0, heading: HEADING }, TWO)).toBeUndefined();
    expect(applyPrefill(md, { unitOpIndex: 5, heading: HEADING }, TWO)).toBeUndefined();
  });

  it('leaves every byte outside the target Input unchanged, Results and other UOs included', () => {
    const md = NOTE(['- buffer']);
    const after = applyPrefill(md, TARGET, TWO)!;
    const cut = md.indexOf('- buffer\n') + '- buffer\n'.length;
    expect(after.slice(0, cut)).toBe(md.slice(0, cut));
    expect(after.slice(cut)).toBe(`${FILLED.join('\n')}\n${md.slice(cut)}`);
  });

  it('keeps CRLF line endings and a missing final newline', () => {
    const crlf = (s: string) => s.replace(/\n/g, '\r\n');
    expect(applyPrefill(crlf(NOTE([])), TARGET, TWO)).toBe(crlf(NOTE(FILLED)));
    const tail = `${HEADING}\n\n#### Input`;
    expect(applyPrefill(tail, { unitOpIndex: 0, heading: HEADING }, TWO)).toBe(`${tail}\n${FILLED.join('\n')}`);
  });

  it('ignores an Input heading inside a code fence and finds the real one', () => {
    const head = [HEADING, '', '#### Method', '```', '#### Input', '```', '', '#### Input'];
    const md = [...head, '', '#### Output', ''].join('\n');
    expect(applyPrefill(md, { unitOpIndex: 0, heading: HEADING }, TWO)).toBe([...head, ...FILLED, '', '#### Output', ''].join('\n'));
  });

  it('accepts a Korean Input heading', () => {
    const md = [HEADING, '', '#### 입력', '', '#### 방법', '- x', ''].join('\n');
    expect(applyPrefill(md, { unitOpIndex: 0, heading: HEADING }, TWO)).toBe(
      [HEADING, '', '#### 입력', ...FILLED, '', '#### 방법', '- x', ''].join('\n')
    );
  });

  it('applies the prefillInput result to a legacy workflow note end to end', async () => {
    const fs = await buildFixtureVault();
    const chain = await buildChain(fs, EXP_MAIN);
    const original = await fs.read(MAIN_FILES.legacy);
    const emptied = original.replace('- Protein-2\n', '');
    const r = prefillInput(chain, { workflowPath: MAIN_FILES.legacy, unitOpIndex: 0 }, noName);
    const heading = chain.workflows.find(w => w.path === MAIN_FILES.legacy)!.unitOps[0].heading;
    expect(applyPrefill(emptied, { unitOpIndex: 0, heading }, r)).toBe(original);
  });
});
