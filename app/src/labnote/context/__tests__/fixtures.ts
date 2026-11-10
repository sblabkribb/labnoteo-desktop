// Fixture vault for the AI context builder (spec §14). One file: later tasks extend it.
import { MemFileSystem } from '@labnoteo/core';
import type { ExperimentRef } from '../scope';

/** Main experiment: Korean title and folder name, every legacy and broken checklist case. */
export const EXP_MAIN = 'labnote/002_발현실험';
/** Second Korean experiment: holds a same-ID sample and a same-text note, to detect leakage. */
export const EXP_OTHER = 'labnote/003_정제';
/** Prefix trap: `labnote/001_A` must never match `labnote/001_AB/...`. */
export const EXP_A = 'labnote/001_A';
export const EXP_AB = 'labnote/001_AB';
/** Only a legacy `README.md` and a legacy `NNN_X.md` workflow. */
export const EXP_LEGACY = 'labnote/004_Legacy';
/** 40 unit ops of about 150 estimated tokens each (4 workflows x 10). */
export const EXP_STRESS = 'labnote/005_Stress';

export const TITLE_MAIN = '단백질 발현';
export const TITLE_OTHER = '단백질 정제';

/** Text that appears in notes of other experiments too; a hit from there is a leak. */
export const LEAK_TEXT = 'Band at 1.2 kb';
/** Sample ID registered locally in both {@link EXP_MAIN} and {@link EXP_OTHER}. */
export const LEAK_SAMPLE_ID = 'DNA-2';

export const GLOBAL_SAMPLE_FOLDER = 'resources/labsamples';

export const FIXTURE_EXPERIMENTS: ExperimentRef[] = [
  { folder: EXP_A, title: 'Alpha' },
  { folder: EXP_AB, title: 'Alpha Beta' },
  { folder: EXP_MAIN, title: TITLE_MAIN },
  { folder: EXP_OTHER, title: TITLE_OTHER },
  { folder: EXP_LEGACY, title: 'Legacy' },
  { folder: EXP_STRESS, title: 'Stress' },
];

const readme = (title: string, goal: string, checklist: string[]): string =>
  ['---', `title: ${title}`, 'author: Dr. Kim', '---', '', '## Goal', '', goal, '', '## Related Workflows', '', ...checklist, ''].join(
    '\n'
  );

const record = (type: string, alias: string, description: string, source: string) => ({
  type,
  alias,
  descriptions: [description],
  sources: [source],
});

/** Files of {@link EXP_MAIN}, in the order the README checklist means. */
export const MAIN_FILES = {
  cloning: `${EXP_MAIN}/001_WB010_Cloning.labnote.md`,
  /** Linked with `%20`. */
  expression: `${EXP_MAIN}/002_WB020_Protein Expression.labnote.md`,
  /** Linked with a `.md.md` link. */
  check: `${EXP_MAIN}/003_WB030_Check.labnote.md`,
  /** Listed by a checklist line without a list marker. */
  purify: `${EXP_MAIN}/004_WB040_Purify.labnote.md`,
  /** Listed by a wikilink entry; has no unit ops. */
  analysis: `${EXP_MAIN}/005_WB050_Analysis.labnote.md`,
  /** Linked from the checklist but missing (broken link). */
  broken: `${EXP_MAIN}/006_WB060_Missing.labnote.md`,
  /** Legacy name, placed by its checklist label. */
  legacy: `${EXP_MAIN}/007_Old Step.md`,
  /** Not in the checklist. */
  unlisted: `${EXP_MAIN}/008_WB080_Unlisted.labnote.md`,
} as const;

const MAIN_README = readme(TITLE_MAIN, 'GFP 발현 균주를 만들고 단백질을 정제한다.', [
  '- [x] [WB010 Cloning](./001_WB010_Cloning.labnote.md)',
  '- [ ] [WB020 Protein Expression](./002_WB020_Protein%20Expression.labnote.md)',
  '- [ ] [WB030 Check](./003_WB030_Check.labnote.md.md)',
  '[ ] [WB040 Purify](004_WB040_Purify.labnote.md)',
  '- [ ] [[005_WB050_Analysis.labnote|WB050 Analysis]]',
  '- [ ] [WB060 Missing](./006_WB060_Missing.labnote.md)',
  '- [ ] [007_Old Step](./007_Old%20Step.labnote.md)',
  '- [ ] [WB010 Cloning again](./001_WB010_Cloning.labnote.md)',
]);

const CLONING = [
  '## [WB010 Cloning]',
  '',
  '### [UHW010 PCR] 증폭',
  '',
  '#### Meta',
  '- Experimenter: Kim',
  '',
  '#### Input',
  '- DNA-1 ; template plasmid',
  '',
  '#### Reagent',
  '- Q5 polymerase',
  '',
  '#### Labware and Consumables',
  '- PCR tube',
  '',
  '#### Equipment',
  '- Thermocycler',
  '',
  '#### Method',
  '- 98C 30s, 30 cycles',
  '',
  '#### Output',
  '- DNA-2 ; PCR product',
  '',
  '#### Results & Discussions',
  `- ${LEAK_TEXT}`,
  '',
  '#### QC Metrics',
  '- yield 50 ng/uL',
  '',
  '### [UHW020 Gel Purification]',
  '',
  '#### 입력',
  '- DNA-2',
  '',
  '#### Consumables',
  '- spin column',
  '',
  '#### 방법',
  '```text',
  '### [UHW999 Fake]',
  '#### Output',
  '- DNA-999',
  '```',
  '- run the gel, cut the band (`DNA-998` is only an example)',
  '',
  '#### 출력',
  '- DNA-3 ; purified insert',
  '- (new: ligation mix)',
  '',
  '#### 결과',
  '- 깨끗한 밴드',
  '',
  '#### Discussion',
  '- fine',
  '',
].join('\n');

const EXPRESSION = [
  '## [WB020 Protein Expression]',
  '',
  '### [USW010 Codon Check] 코돈 확인',
  '',
  '#### Meta',
  '- Software: SnapGene',
  '',
  '#### Input',
  '- DNA-3',
  '',
  '#### Parameters',
  '- host: E. coli',
  '',
  '#### Method',
  '- (method used in this step)',
  '',
  '#### Output',
  '- DNA-4',
  '',
  '#### Environment',
  '- Windows 11',
  '',
  '### [UHW030 Induction]',
  '',
  '#### Input',
  '- DNA-4',
  '',
  '#### Method',
  '- IPTG 0.5 mM (Reagent-1)',
  '',
  '#### Output',
  '- Protein-1',
  '',
].join('\n');

const CHECK = ['## [WB030 Check]', '', '### [UHW040 SDS-PAGE]', '', '#### Input', '- Protein-1', '', '#### Output', '- (none)', ''].join(
  '\n'
);

const PURIFY = ['## [WB040 Purify]', '', '### [UHW050 Ni-NTA]', '', '#### Input', '', '#### Output', '- Protein-2', ''].join('\n');

const ANALYSIS = ['## [WB050 Analysis]', '', 'No unit operations yet.', ''].join('\n');

const LEGACY_STEP = ['## Old step', '', '### [UHW060 Dialysis]', '', '#### Input', '- Protein-2', '', '#### Output', '- Protein-3', ''].join(
  '\n'
);

const UNLISTED = ['## [WB080 Unlisted]', '', '### [UXX010 Something]', '', '#### Input', '- Protein-3', ''].join('\n');

const OTHER_NOTE = [
  '## [WB010 Cloning]',
  '',
  '### [UHW010 PCR]',
  '',
  '#### Input',
  `- ${LEAK_SAMPLE_ID}`,
  '',
  '#### Results & Discussions',
  `- ${LEAK_TEXT}`,
  '',
].join('\n');

/** Characters in one stress unit op: all ASCII, so about 150 estimated tokens. */
export const STRESS_UO_CHARS = 600;

/** One stress unit op of {@link STRESS_UO_CHARS} ASCII characters, ending in a newline. */
export function stressUnitOp(n: number): string {
  const id = String(n).padStart(3, '0');
  const head = [`### [UHW${id} Step ${id}]`, '', '#### Input', `- DNA-${n}`, '', '#### Method'];
  const tail = ['', '#### Output', `- DNA-${n + 1}`, ''];
  const fixed = [...head, ...tail].join('\n').length + 1;
  const filler = `- step ${id}: mix, incubate and spin down. `.repeat(30).slice(0, STRESS_UO_CHARS - fixed);
  return [...head, filler, ...tail].join('\n');
}

function stressFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  const checklist: string[] = [];
  for (let w = 1; w <= 4; w++) {
    const name = `00${w}_WB0${w}0_Stage ${w}.labnote.md`;
    checklist.push(`- [ ] [WB0${w}0 Stage ${w}](./${name.replace(/ /g, '%20')})`);
    const uos: string[] = [];
    for (let u = 1; u <= 10; u++) uos.push(stressUnitOp((w - 1) * 10 + u));
    files[`${EXP_STRESS}/${name}`] = [`## [WB0${w}0 Stage ${w}]`, '', ...uos].join('\n');
  }
  files[`${EXP_STRESS}/README.labnote.md`] = readme('Stress', 'Many steps.', checklist);
  return files;
}

/** The fixture vault (spec §14) as a fresh core `MemFileSystem`. */
export async function buildFixtureVault(): Promise<MemFileSystem> {
  const files: Record<string, string> = {
    [`${EXP_MAIN}/README.labnote.md`]: MAIN_README,
    [MAIN_FILES.cloning]: CLONING,
    [MAIN_FILES.expression]: EXPRESSION,
    [MAIN_FILES.check]: CHECK,
    [MAIN_FILES.purify]: PURIFY,
    [MAIN_FILES.analysis]: ANALYSIS,
    [MAIN_FILES.legacy]: LEGACY_STEP,
    [MAIN_FILES.unlisted]: UNLISTED,
    [`${EXP_MAIN}/images/gel.png`]: 'PNG',
    [`${EXP_MAIN}/resources/labsamples/DNA.json`]: JSON.stringify({
      'DNA-1': record('DNA', 'template', 'pET28a-GFP', MAIN_FILES.cloning),
      [LEAK_SAMPLE_ID]: record('DNA', 'PCR product', 'GFP insert', MAIN_FILES.cloning),
      'DNA-3': record('DNA', 'insert', 'purified insert', MAIN_FILES.cloning),
    }),

    [`${EXP_OTHER}/README.labnote.md`]: readme(TITLE_OTHER, '다른 실험.', ['- [ ] [WB010 Cloning](./001_WB010_Cloning.labnote.md)']),
    [`${EXP_OTHER}/001_WB010_Cloning.labnote.md`]: OTHER_NOTE,
    [`${EXP_OTHER}/resources/labsamples/DNA.json`]: JSON.stringify({
      [LEAK_SAMPLE_ID]: record('DNA', 'LEAKED', 'from the other experiment', `${EXP_OTHER}/001_WB010_Cloning.labnote.md`),
    }),

    [`${EXP_A}/README.labnote.md`]: readme('Alpha', 'A.', ['- [ ] [WD010 Design](./001_WD010_Design.labnote.md)']),
    [`${EXP_A}/001_WD010_Design.labnote.md`]: '## [WD010 Design]\n\n### [USW010 Plan]\n\n#### Output\n- DNA-10\n',
    [`${EXP_AB}/README.labnote.md`]: readme('Alpha Beta', 'AB.', ['- [ ] [WD010 Design](./001_WD010_Design.labnote.md)']),
    [`${EXP_AB}/001_WD010_Design.labnote.md`]: `## [WD010 Design]\n\n### [USW010 Plan]\n\n#### Output\n- DNA-10\n- ${LEAK_TEXT}\n`,

    [`${EXP_LEGACY}/README.md`]: '# Legacy\n\n## Related Workflows\n\n- [ ] [001_Prep](./001_Prep.labnote.md)\n',
    [`${EXP_LEGACY}/001_Prep.md`]: '## Prep\n\n### [UHW010 Prep]\n\n#### Output\n- DNA-20\n',

    [`${GLOBAL_SAMPLE_FOLDER}/Reagent.json`]: JSON.stringify({
      'Reagent-1': record('Reagent', 'IPTG', '1 M stock', GLOBAL_SAMPLE_FOLDER),
    }),
    'notes/loose.md': `Outside every experiment. ${LEAK_TEXT}\n`,
    ...stressFiles(),
  };
  return new MemFileSystem(files);
}
