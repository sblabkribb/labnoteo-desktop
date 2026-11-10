import { describe, expect, it } from 'vitest';
import { assertInScope, findExperiment, resolveScope, scopeGate, ScopeError, type Scope, type ScopeErrorCode } from '../scope';
import {
  buildFixtureVault,
  EXP_A,
  EXP_AB,
  EXP_LEGACY,
  EXP_MAIN,
  EXP_OTHER,
  EXP_STRESS,
  FIXTURE_EXPERIMENTS,
  MAIN_FILES,
  STRESS_UO_CHARS,
  stressUnitOp,
  TITLE_MAIN,
  TITLE_OTHER,
} from './fixtures';

function codeOf(fn: () => unknown): { code: ScopeErrorCode; params: string[] } {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ScopeError);
    const err = e as ScopeError;
    return { code: err.code, params: err.params };
  }
  throw new Error('expected a ScopeError');
}

const scopeA: Scope = { folder: EXP_A, explicit: false, named: [] };

describe('fixture vault', () => {
  it('has every fixture experiment, the main files and 40 stress unit ops of about 150 tokens', async () => {
    const fs = await buildFixtureVault();
    for (const e of FIXTURE_EXPERIMENTS) expect(await fs.exists(e.folder)).toBe(true);
    for (const [key, p] of Object.entries(MAIN_FILES)) expect(await fs.exists(p)).toBe(key !== 'broken');
    expect(await fs.exists(`${EXP_LEGACY}/README.md`)).toBe(true);
    expect(await fs.exists(`${EXP_LEGACY}/README.labnote.md`)).toBe(false);
    const stress = (await fs.list(EXP_STRESS)).filter(n => n.endsWith('.labnote.md') && !n.startsWith('README'));
    let uos = 0;
    for (const n of stress) uos += ((await fs.read(`${EXP_STRESS}/${n}`)).match(/^### \[UHW/gm) ?? []).length;
    expect(uos).toBe(40);
    const one = stressUnitOp(7);
    expect(one.length).toBe(STRESS_UO_CHARS);
    expect(/^[\x00-\x7f]*$/.test(one)).toBe(true);
  });
});

describe('resolveScope', () => {
  it('resolves the active note, a nested images/ path and the README to the experiment folder', () => {
    for (const activePath of [MAIN_FILES.cloning, `${EXP_MAIN}/images/gel.png`, `${EXP_MAIN}/README.labnote.md`]) {
      expect(resolveScope({ activePath }, FIXTURE_EXPERIMENTS)).toEqual({ folder: EXP_MAIN, explicit: false, named: [] });
    }
  });

  it('resolves backslash and NFD active paths to the listed folder spelling', () => {
    const nfd = MAIN_FILES.cloning.normalize('NFD').replace(/\//g, '\\');
    expect(resolveScope({ activePath: nfd }, FIXTURE_EXPERIMENTS).folder).toBe(EXP_MAIN);
  });

  it('gives noExperiment without an active path or outside labnote/NNN_*', () => {
    expect(codeOf(() => resolveScope({}, FIXTURE_EXPERIMENTS)).code).toBe('noExperiment');
    for (const activePath of ['notes/loose.md', 'labnote/README.md', 'labnote/group/001_X/a.md', 'labnote/Draft/a.md', '../labnote/001_A/x.md']) {
      expect(codeOf(() => resolveScope({ activePath }, FIXTURE_EXPERIMENTS)).code).toBe('noExperiment');
    }
  });

  it('takes an explicit experiment name or folder and marks the scope explicit', () => {
    expect(resolveScope({ activePath: MAIN_FILES.cloning, experiment: '003' }, FIXTURE_EXPERIMENTS)).toEqual({
      folder: EXP_OTHER,
      explicit: true,
      named: [],
    });
    expect(resolveScope({ folder: `${EXP_AB}/` }, FIXTURE_EXPERIMENTS)).toEqual({ folder: EXP_AB, explicit: true, named: [] });
    expect(codeOf(() => resolveScope({ folder: 'labnote/009_None' }, FIXTURE_EXPERIMENTS))).toEqual({
      code: 'unknownExperiment',
      params: ['labnote/009_None'],
    });
    expect(codeOf(() => resolveScope({ folder: EXP_A, experiment: '003' }, FIXTURE_EXPERIMENTS)).code).toBe('ambiguousExperiment');
  });
});

describe('findExperiment', () => {
  it('treats 001 as ambiguous between 001_A and 001_AB', () => {
    const err = codeOf(() => findExperiment('001', FIXTURE_EXPERIMENTS));
    expect(err.code).toBe('ambiguousExperiment');
    expect(err.params).toEqual(['001', EXP_A, EXP_AB]);
  });

  it('resolves a number, a full folder name, a folder path and a Korean title given NFC or NFD', () => {
    expect(findExperiment('002', FIXTURE_EXPERIMENTS).folder).toBe(EXP_MAIN);
    expect(findExperiment('001_ab', FIXTURE_EXPERIMENTS).folder).toBe(EXP_AB);
    expect(findExperiment('001_A', FIXTURE_EXPERIMENTS).folder).toBe(EXP_A);
    expect(findExperiment(EXP_OTHER, FIXTURE_EXPERIMENTS).folder).toBe(EXP_OTHER);
    expect(findExperiment(TITLE_OTHER, FIXTURE_EXPERIMENTS).folder).toBe(EXP_OTHER);
    expect(findExperiment(` ${TITLE_MAIN.normalize('NFD')} `, FIXTURE_EXPERIMENTS).folder).toBe(EXP_MAIN);
    expect(findExperiment('003_정제'.normalize('NFD'), FIXTURE_EXPERIMENTS).folder).toBe(EXP_OTHER);
    expect(findExperiment('alpha beta', FIXTURE_EXPERIMENTS).folder).toBe(EXP_AB);
  });

  it('gives unknownExperiment for a name nothing matches', () => {
    for (const name of ['009', 'Gamma', '', '001_', 'labnote/001_A/../003_정제']) {
      expect(codeOf(() => findExperiment(name, FIXTURE_EXPERIMENTS)).code).toBe('unknownExperiment');
    }
  });
});

describe('assertInScope', () => {
  it('returns the normalised path of a note inside the scope folder', () => {
    expect(assertInScope(scopeA, `${EXP_A}/001_WD010_Design.labnote.md`)).toBe(`${EXP_A}/001_WD010_Design.labnote.md`);
    expect(assertInScope(scopeA, 'labnote\\001_A\\sub\\x.md')).toBe(`${EXP_A}/sub/x.md`);
    expect(assertInScope(scopeA, `./${EXP_A}//x.MD`)).toBe(`${EXP_A}/x.MD`);
    expect(assertInScope(scopeA, 'LABNOTE/001_a/x.md')).toBe('LABNOTE/001_a/x.md');
  });

  it('matches Korean folders regardless of NFC or NFD', () => {
    const main: Scope = { folder: EXP_MAIN, explicit: false, named: [] };
    const nfd = MAIN_FILES.cloning.normalize('NFD');
    expect(assertInScope(main, nfd)).toBe(nfd);
    const mainNfd: Scope = { folder: EXP_MAIN.normalize('NFD'), explicit: false, named: [] };
    expect(assertInScope(mainNfd, MAIN_FILES.cloning)).toBe(MAIN_FILES.cloning);
  });

  it.each([
    ['labnote/001_A/../001_AB/x.md'],
    ['labnote/001_A/..\\001_AB\\x.md'],
    ['/labnote/001_A/x.md'],
    ['\\labnote\\001_A\\x.md'],
    ['//server/labnote/001_A/x.md'],
    ['C:/labnote/001_A/x.md'],
    ['C:labnote/001_A/x.md'],
    ['c:\\vault\\labnote\\001_A\\x.md'],
    ['labnote/001_AB/x.md'],
    ['labnote\\001_AB\\x.md'],
    ['labnote/001_A'],
    ['labnote/001_A/'],
    ['labnote/001_A/.obsidian/x.md'],
    ['labnote/001_A/.trash/x.md'],
    ['labnote/001_A/resources/labsamples/DNA.json'],
    ['labnote/001_A/images/gel.png'],
    ['labnote/001_A/x.md:stream'],
    ['labnote/001_A/x:y.md'],
    ['labnote/003_정제/001_WB010_Cloning.labnote.md'],
    ['notes/loose.md'],
    [''],
  ])('rejects %s with outOfScope', path => {
    expect(codeOf(() => assertInScope(scopeA, path))).toEqual({ code: 'outOfScope', params: [path, EXP_A] });
  });

  it('accepts a path in a folder the user named, and nothing else', () => {
    const scope: Scope = { folder: EXP_A, explicit: false, named: [EXP_OTHER] };
    expect(assertInScope(scope, `${EXP_OTHER}/001_WB010_Cloning.labnote.md`)).toBe(`${EXP_OTHER}/001_WB010_Cloning.labnote.md`);
    expect(codeOf(() => assertInScope(scope, `${EXP_AB}/x.md`)).code).toBe('outOfScope');
    expect(codeOf(() => assertInScope(scope, `${EXP_MAIN}/x.md`)).code).toBe('outOfScope');
  });
});

describe('scopeGate', () => {
  it('ignores short common-word ASCII titles', () => {
    const exps = [{ folder: 'labnote/001_new', title: 'new' }, { folder: 'labnote/002_X', title: 'test' }];
    expect([...scopeGate('write a new test method', exps as never)]).toEqual([]);
    const ok = [{ folder: 'labnote/003_Y', title: 'Plasmid prep' }];
    expect([...scopeGate('compare with plasmid prep', ok as never)]).toEqual(['labnote/003_Y']);
  });

  it('finds a number and a Korean title in a sentence', () => {
    const gate = scopeGate(`002번 실험의 결과를 ${TITLE_OTHER} 실험과 비교해 줘`, FIXTURE_EXPERIMENTS);
    expect([...gate].sort()).toEqual([EXP_MAIN, EXP_OTHER].sort());
  });

  it('matches NFD text against NFC titles', () => {
    expect([...scopeGate(`see ${TITLE_OTHER.normalize('NFD')} please`, FIXTURE_EXPERIMENTS)]).toEqual([EXP_OTHER]);
  });

  it('ignores numbers that are not experiments or are part of other tokens', () => {
    const text = 'Spin at 1500 rpm for 010 min, use 999 uL, DNA-002, step 2.003 and v1.004';
    expect(scopeGate(text, FIXTURE_EXPERIMENTS).size).toBe(0);
  });

  it('keeps the 001_A / 001_AB folder names apart and prefers the longer title', () => {
    expect([...scopeGate('compare with 001_AB', FIXTURE_EXPERIMENTS)]).toEqual([EXP_AB]);
    expect([...scopeGate('compare with 001_A.', FIXTURE_EXPERIMENTS)]).toEqual([EXP_A]);
    expect([...scopeGate('what did Alpha Beta do?', FIXTURE_EXPERIMENTS)]).toEqual([EXP_AB]);
    expect([...scopeGate('what did alpha do?', FIXTURE_EXPERIMENTS)]).toEqual([]);
    expect([...scopeGate('the alphabet', FIXTURE_EXPERIMENTS)]).toEqual([]);
  });

  it('names nothing for an ambiguous number', () => {
    expect(scopeGate('look at 001', FIXTURE_EXPERIMENTS).size).toBe(0);
  });

  it('ignores very short titles that would match ordinary words', () => {
    const experiments = [{ folder: 'labnote/007_A', title: 'A' }];
    expect(scopeGate('a plan for a test', experiments).size).toBe(0);
  });
});
