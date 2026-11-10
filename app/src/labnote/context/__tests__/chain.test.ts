import { describe, expect, it } from 'vitest';
import { MemFileSystem, type LabnoteFs } from '@labnoteo/core';
import { SAMPLE_TYPES } from '@labnoteo/core/lib/sampleUtils';
import {
  buildChain,
  canonicalSection,
  isPlaceholderBody,
  MAX_FILE_BYTES,
  MAX_WORKFLOW_FILES,
  PLANNING_SECTIONS_HW,
  PLANNING_SECTIONS_SW,
  previousUnitOp,
  RESEARCHER_ONLY_SECTIONS,
  sampleIdsIn,
  unitOpAtLine,
  type ChainIssue,
  type ExperimentChain,
} from '../chain';
import { buildFixtureVault, EXP_LEGACY, EXP_MAIN, EXP_OTHER, EXP_STRESS, LEAK_TEXT, MAIN_FILES } from './fixtures';

const TYPES = [...SAMPLE_TYPES];

async function mainChain(): Promise<ExperimentChain> {
  return buildChain(await buildFixtureVault(), EXP_MAIN);
}

const codes = (issues: readonly ChainIssue[]): string[] => issues.map(i => i.code);

/** `mem` with its `read` replaced. */
function withRead(mem: MemFileSystem, read: (p: string) => Promise<string>): LabnoteFs {
  return {
    read,
    write: (p, c) => mem.write(p, c),
    modify: (p, u) => mem.modify(p, u),
    exists: p => mem.exists(p),
    mkdir: p => mem.mkdir(p),
    list: d => mem.list(d),
    remove: p => mem.remove(p),
    rmdir: p => mem.rmdir(p),
  };
}

describe('buildChain: workflow order', () => {
  it('follows the checklist for ./, %20, .md.md, no-marker and wikilink entries, then legacy by label, then unlisted', async () => {
    const chain = await mainChain();
    expect(chain.folder).toBe(EXP_MAIN);
    expect(chain.readmePath).toBe(`${EXP_MAIN}/README.labnote.md`);
    expect(chain.workflows.map(w => w.path)).toEqual([
      MAIN_FILES.cloning,
      MAIN_FILES.expression,
      MAIN_FILES.check,
      MAIN_FILES.purify,
      MAIN_FILES.analysis,
      MAIN_FILES.legacy,
      MAIN_FILES.unlisted,
    ]);
    const byPath = new Map(chain.workflows.map(w => [w.path, w]));
    expect(byPath.get(MAIN_FILES.cloning)).toMatchObject({ listed: true, done: true, legacy: false, label: 'WB010 Cloning' });
    expect(byPath.get(MAIN_FILES.expression)).toMatchObject({ listed: true, done: false, label: 'WB020 Protein Expression' });
    expect(byPath.get(MAIN_FILES.analysis)).toMatchObject({ listed: true, label: 'WB050 Analysis' });
    expect(byPath.get(MAIN_FILES.legacy)).toMatchObject({ listed: true, legacy: true, label: '007_Old Step', fileName: '007_Old Step.md' });
    expect(byPath.get(MAIN_FILES.unlisted)).toMatchObject({ listed: false, legacy: false });
  });

  it('reports each chain issue of the main fixture', async () => {
    const chain = await mainChain();
    expect(chain.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'brokenLink', path: MAIN_FILES.broken }),
        expect.objectContaining({ code: 'duplicateEntry', path: MAIN_FILES.cloning }),
        expect.objectContaining({ code: 'unlistedWorkflow', path: MAIN_FILES.unlisted }),
        expect.objectContaining({ code: 'noUnitOps', path: MAIN_FILES.analysis }),
        expect.objectContaining({ code: 'noOutput', path: MAIN_FILES.check }),
      ])
    );
    expect(codes(chain.issues)).not.toContain('missingReadme');
    expect(codes(chain.issues)).not.toContain('emptyChecklist');
    expect(codes(chain.issues)).not.toContain('unreadable');
    // The legacy entry is resolved by its label, so it is not a broken link.
    expect(chain.issues.filter(i => i.code === 'brokenLink')).toHaveLength(1);
  });

  it('keeps the goal and drops front matter and the checklist section', async () => {
    const chain = await mainChain();
    expect(chain.goal).toContain('GFP 발현 균주를 만들고 단백질을 정제한다.');
    expect(chain.goal).not.toContain('author:');
    expect(chain.goal).not.toContain('Related Workflows');
    expect(chain.goal).not.toContain('WB010');
  });

  it('falls back to a legacy README.md and places a legacy NNN_X.md by its label', async () => {
    const chain = await buildChain(await buildFixtureVault(), EXP_LEGACY);
    expect(chain.readmePath).toBe(`${EXP_LEGACY}/README.md`);
    expect(chain.workflows.map(w => [w.fileName, w.listed, w.legacy])).toEqual([['001_Prep.md', true, true]]);
    expect(chain.goal).toContain('# Legacy');
    expect(chain.issues).toEqual([]);
  });

  it('places an unmatched legacy file by number among the unlisted ones', async () => {
    const fs = new MemFileSystem({
      'labnote/010_X/README.labnote.md': '## Related Workflows\n\n- [ ] [WB010 A](./002_WB010_A.labnote.md)\n',
      'labnote/010_X/002_WB010_A.labnote.md': '### [UHW010 A]\n',
      'labnote/010_X/003_Zeta.md': '### [UHW020 Z]\n',
      'labnote/010_X/001_Old.md': '### [UHW030 O]\n',
      'labnote/010_X/notes.md': 'not a workflow',
    });
    const chain = await buildChain(fs, 'labnote/010_X');
    expect(chain.workflows.map(w => [w.fileName, w.listed, w.legacy])).toEqual([
      ['002_WB010_A.labnote.md', true, false],
      ['001_Old.md', false, true],
      ['003_Zeta.md', false, true],
    ]);
  });

  it('reports a missing README and an empty checklist', async () => {
    const noReadme = await buildChain(new MemFileSystem({ 'labnote/011_N/001_WB010_A.labnote.md': '### [UHW010 A]\n' }), 'labnote/011_N');
    expect(noReadme.readmePath).toBeUndefined();
    expect(noReadme.goal).toBe('');
    expect(codes(noReadme.issues)).toContain('missingReadme');
    expect(noReadme.workflows.map(w => w.listed)).toEqual([false]);

    const empty = await buildChain(
      new MemFileSystem({ 'labnote/012_E/README.labnote.md': '# E\n\n## Related Workflows\n\nnothing yet\n' }),
      'labnote/012_E'
    );
    expect(codes(empty.issues)).toEqual(['emptyChecklist']);
    expect(empty.workflows).toEqual([]);
  });

  it('never follows a checklist link into another experiment folder', async () => {
    const fs = await buildFixtureVault();
    await fs.write(`${EXP_MAIN}/README.labnote.md`, '## Related Workflows\n\n- [ ] [Other](../003_정제/001_WB010_Cloning.labnote.md)\n');
    const chain = await buildChain(fs, EXP_MAIN);
    expect(chain.workflows.every(w => w.path.startsWith(`${EXP_MAIN}/`))).toBe(true);
    expect(JSON.stringify(chain)).not.toContain(EXP_OTHER);
    expect(codes(chain.issues)).toContain('brokenLink');
  });

  it('turns a rejecting read into an unreadable issue', async () => {
    const mem = new MemFileSystem({
      'labnote/013_U/README.labnote.md': '## Related Workflows\n\n- [ ] [WB010 A](./001_WB010_A.labnote.md)\n',
      'labnote/013_U/001_WB010_A.labnote.md': '### [UHW010 A]\n',
    });
    const fs = withRead(mem, async p => {
      if (p.endsWith('001_WB010_A.labnote.md')) throw new Error('disk on fire');
      return mem.read(p);
    });
    const chain = await buildChain(fs, 'labnote/013_U');
    expect(chain.issues).toContainEqual({ code: 'unreadable', path: 'labnote/013_U/001_WB010_A.labnote.md', detail: 'disk on fire' });
    expect(chain.workflows.map(w => w.unitOps.length)).toEqual([0]);
    expect(codes(chain.issues)).not.toContain('noUnitOps');
  });

  it('reads at most MAX_WORKFLOW_FILES workflow files and MAX_FILE_BYTES per file', async () => {
    const files: Record<string, string> = {};
    for (let i = 1; i <= MAX_WORKFLOW_FILES + 5; i++) files[`labnote/014_L/${String(i).padStart(3, '0')}_WB010_A.labnote.md`] = '### [UHW010 A]\n';
    files['labnote/014_L/001_WB010_A.labnote.md'] = '### [UHW010 A]\n' + 'x'.repeat(MAX_FILE_BYTES);
    const reads: string[] = [];
    const mem = new MemFileSystem(files);
    const fs = withRead(mem, async p => {
      reads.push(p);
      return mem.read(p);
    });
    const chain = await buildChain(fs, 'labnote/014_L');
    expect(chain.workflows).toHaveLength(MAX_WORKFLOW_FILES);
    expect(reads.length).toBeLessThanOrEqual(MAX_WORKFLOW_FILES + 2);
    expect(chain.issues).toContainEqual({ code: 'unreadable', path: 'labnote/014_L', detail: 'limit' });
    expect(chain.issues).toContainEqual({ code: 'unreadable', path: 'labnote/014_L/001_WB010_A.labnote.md', detail: 'limit' });
    expect(chain.workflows[0].unitOps).toEqual([]);
  });
});

describe('buildChain: unit ops and sections', () => {
  it('builds 0-based unit ops with kind, canonical sections and sample IDs', async () => {
    const chain = await mainChain();
    const cloning = chain.workflows[0];
    expect(cloning.unitOps.map(u => [u.index, u.opId, u.title, u.alias, u.kind])).toEqual([
      [0, 'UHW010', 'PCR', '증폭', 'hw'],
      [1, 'UHW020', 'Gel Purification', '', 'hw'],
    ]);
    const [pcr, gel] = cloning.unitOps;
    expect(pcr.heading).toBe('### [UHW010 PCR] 증폭');
    expect(pcr.workflowPath).toBe(MAIN_FILES.cloning);
    expect(Object.keys(pcr.sections)).toEqual([
      'Meta',
      'Input',
      'Reagent',
      'Labware and Consumables',
      'Equipment',
      'Method',
      'Output',
      'Results & Discussions',
      'QC Metrics',
    ]);
    expect(pcr.inputIds).toEqual(['DNA-1']);
    expect(pcr.outputIds).toEqual(['DNA-2']);
    expect(pcr.sections['Results & Discussions']).toBe(`- ${LEAK_TEXT}`);

    // Korean headings and the Consumables alias; Korean text kept verbatim.
    expect(Object.keys(gel.sections)).toEqual(['Input', 'Labware and Consumables', 'Method', 'Output', 'Results & Discussions', 'Discussion']);
    expect(gel.sections['Results & Discussions']).toBe('- 깨끗한 밴드');
    expect(gel.inputIds).toEqual(['DNA-2']);
    // `(new: …)` lines contribute nothing.
    expect(gel.outputIds).toEqual(['DNA-3']);
    // The fenced fake heading stays in the Method body and is not a UO or a section.
    expect(gel.sections.Method).toContain('### [UHW999 Fake]');
    expect(chain.workflows.flatMap(w => w.unitOps).some(u => u.opId === 'UHW999')).toBe(false);

    const expression = chain.workflows[1];
    expect(expression.unitOps.map(u => u.kind)).toEqual(['sw', 'hw']);
    expect(expression.unitOps[0].sections.Environment).toBe('- Windows 11');
    expect(chain.workflows[6].unitOps[0].kind).toBe('unknown');
  });

  it('builds the 40-UO stress folder', async () => {
    const chain = await buildChain(await buildFixtureVault(), EXP_STRESS);
    expect(chain.workflows).toHaveLength(4);
    expect(chain.workflows.flatMap(w => w.unitOps)).toHaveLength(40);
    expect(chain.workflows[3].unitOps[9]).toMatchObject({ index: 9, inputIds: ['DNA-40'], outputIds: ['DNA-41'] });
    expect(chain.issues).toEqual([]);
  });
});

describe('section helpers', () => {
  it('lists planning and researcher-only sections', () => {
    expect(PLANNING_SECTIONS_HW).toEqual(['Input', 'Reagent', 'Labware and Consumables', 'Equipment', 'Parameters', 'Method', 'Output']);
    expect(PLANNING_SECTIONS_SW).toEqual(['Input', 'Output', 'Parameters', 'Method', 'Environment']);
    expect(RESEARCHER_ONLY_SECTIONS).toEqual(['Results & Discussions', 'QC Metrics', 'Discussion', 'Meta']);
  });

  it('canonicalises English, Korean, alias and decorated headings', () => {
    expect(canonicalSection('Consumables')).toBe('Labware and Consumables');
    expect(canonicalSection('#### 방법')).toBe('Method');
    expect(canonicalSection('  method ')).toBe('Method');
    expect(canonicalSection('📥 Input')).toBe('Input');
    expect(canonicalSection('[Output]')).toBe('Output');
    expect(canonicalSection('QC 지표')).toBe('QC Metrics');
    expect(canonicalSection('결과')).toBe('Results & Discussions');
    expect(canonicalSection('Results and Discussions')).toBe('Results & Discussions');
    expect(canonicalSection('메타')).toBe('Meta');
    expect(canonicalSection('파라미터')).toBe('Parameters');
    expect(canonicalSection('방법'.normalize('NFD'))).toBe('Method');
    expect(canonicalSection('Notes from Bob')).toBeUndefined();
  });

  it('recognises empty and placeholder bodies', () => {
    expect(isPlaceholderBody('Input', '')).toBe(true);
    expect(isPlaceholderBody('Input', '  \n\n')).toBe(true);
    expect(isPlaceholderBody('Input', '- (samples from the previous step)')).toBe(true);
    expect(isPlaceholderBody('Input', '- (artifacts/data/models from the previous step)\n')).toBe(true);
    expect(isPlaceholderBody('Labware and Consumables', '- (e.g. plate, filter, tip, tube, etc.)')).toBe(true);
    expect(isPlaceholderBody('Consumables', '- (e.g. plate, filter, tip, tube, etc.)')).toBe(true);
    expect(isPlaceholderBody('Input', '- DNA-1')).toBe(false);
    expect(isPlaceholderBody('Method', '- (samples from the previous step)')).toBe(false);
  });

  it('finds sample IDs outside code, de-duplicated in first-seen order, with custom types', () => {
    const text = [
      '- Protein-2 and DNA-1, then DNA-1 again',
      '- `DNA-7` inline',
      '```',
      'DNA-8',
      '```',
      '- (new: DNA-9 mix)',
      '- 배지-3 and Media-4',
      '- cDNA-5 is not an ID',
    ].join('\n');
    expect(sampleIdsIn(text, TYPES)).toEqual(['Protein-2', 'DNA-1']);
    expect(sampleIdsIn(text, [...TYPES, '배지', 'Media'])).toEqual(['Protein-2', 'DNA-1', '배지-3', 'Media-4']);
  });

  it('uses custom types from buildChain options', async () => {
    const fs = new MemFileSystem({ 'labnote/015_C/001_WB010_A.labnote.md': '### [UHW010 A]\n\n#### Output\n- 배지-1\n' });
    expect((await buildChain(fs, 'labnote/015_C')).workflows[0].unitOps[0].outputIds).toEqual([]);
    expect((await buildChain(fs, 'labnote/015_C', { customTypes: ['배지'] })).workflows[0].unitOps[0].outputIds).toEqual(['배지-1']);
  });
});

describe('previousUnitOp and unitOpAtLine', () => {
  it('steps back within a workflow and across workflow boundaries, skipping zero-UO workflows', async () => {
    const chain = await mainChain();
    expect(previousUnitOp(chain, { workflowPath: MAIN_FILES.cloning, unitOpIndex: 0 })).toBeUndefined();
    expect(previousUnitOp(chain, { workflowPath: MAIN_FILES.cloning, unitOpIndex: 1 })?.opId).toBe('UHW010');
    expect(previousUnitOp(chain, { workflowPath: MAIN_FILES.expression, unitOpIndex: 0 })?.opId).toBe('UHW020');
    expect(previousUnitOp(chain, { workflowPath: MAIN_FILES.purify, unitOpIndex: 0 })?.opId).toBe('UHW040');
    // 005 Analysis has no UOs: the legacy step's predecessor is 004 Purify's last UO.
    expect(previousUnitOp(chain, { workflowPath: MAIN_FILES.legacy, unitOpIndex: 0 })?.opId).toBe('UHW050');
    expect(previousUnitOp(chain, { workflowPath: `${EXP_OTHER}/001_WB010_Cloning.labnote.md`, unitOpIndex: 0 })).toBeUndefined();
  });

  it('finds the 0-based UO containing a line, also without a Method heading', async () => {
    const fs = await buildFixtureVault();
    const check = await fs.read(MAIN_FILES.check);
    const lines = check.split('\n');
    expect(unitOpAtLine(check, 0)).toBeUndefined();
    expect(unitOpAtLine(check, lines.indexOf('- Protein-1'))).toBe(0);
    const expression = await fs.read(MAIN_FILES.expression);
    const el = expression.split('\n');
    expect(unitOpAtLine(expression, el.indexOf('- Windows 11'))).toBe(0);
    expect(unitOpAtLine(expression, el.indexOf('- IPTG 0.5 mM (Reagent-1)'))).toBe(1);
    expect(unitOpAtLine(expression, el.length + 5)).toBeUndefined();
  });
});
