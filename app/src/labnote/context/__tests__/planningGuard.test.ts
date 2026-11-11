import { describe, expect, it } from 'vitest';
import { listUnitOpBlocks } from '@labnoteo/core';
import { HW_PLACEHOLDERS, SW_PLACEHOLDERS } from '@labnoteo/core/lib/unitOpTemplate';
import { applyPlanningDraft, parsePlanningReply } from '../planningGuard';

const HW = ['Input', 'Reagent', 'Labware and Consumables', 'Equipment', 'Parameters', 'Method', 'Output'];
const SW = ['Input', 'Output', 'Parameters', 'Method'];
const BANNED = ['Results & Discussions', 'QC Metrics', 'Discussion', 'Meta'];

describe('parsePlanningReply', () => {
  it('splits on #### headings and keeps requested planning sections', () => {
    const r = parsePlanningReply('#### Input\n- DNA-1\n\n#### Method\n1. Mix\n2. Spin\n', HW);
    expect([...r.sections.keys()]).toEqual(['Input', 'Method']);
    expect(r.sections.get('Input')).toBe('- DNA-1');
    expect(r.sections.get('Method')).toBe('1. Mix\n2. Spin');
    expect(r.dropped).toEqual([]);
  });

  const forbidden = (heading: (name: string) => string) => BANNED.map(n => `${heading(n)}\nINVENTED ${n}`).join('\n\n');

  it.each([
    ['####', (n: string) => `#### ${n}`],
    ['###', (n: string) => `### ${n}`],
    ['**Bold**', (n: string) => `**${n}**`],
    ['**Bold:**', (n: string) => `**${n}:**`],
    ['Name:', (n: string) => `${n}:`],
  ])('drops Results/QC/Discussion/Meta under %s headings', (_label, heading) => {
    const reply = `${heading('Method')}\n- Step one\n\n${forbidden(heading)}\n\n${heading('Output')}\n- PRT-1`;
    const r = parsePlanningReply(reply, SW.concat(HW));
    expect(r.sections.get('Method')).toBe('- Step one');
    expect(r.sections.get('Output')).toBe('- PRT-1');
    expect([...r.sections.values()].join('\n')).not.toContain('INVENTED');
    expect(r.dropped).toEqual(expect.arrayContaining(BANNED));
  });

  it('drops Korean-labelled researcher-only sections and keeps Korean planning labels', () => {
    const reply = [
      '#### 방법',
      '- 섞는다',
      '',
      '#### 결과 및 논의',
      '- 밴드 확인',
      '',
      '**QC 지표**',
      '- 99%',
      '',
      '메타:',
      '- x',
      '',
      '#### 출력',
      '- PRT-1',
    ].join('\n');
    const r = parsePlanningReply(reply, HW);
    expect(r.sections.get('Method')).toBe('- 섞는다');
    expect(r.sections.get('Output')).toBe('- PRT-1');
    expect([...r.sections.values()].join('\n')).not.toMatch(/밴드|99%/);
    expect(r.dropped).toEqual(expect.arrayContaining(['Results & Discussions', 'QC Metrics', 'Meta']));
  });

  it('drops loose result-like headings that are not canonical names', () => {
    const r = parsePlanningReply(
      ['#### Method', '- a', '', 'Results:', '- yield 5 mg', '', '**Conclusion**', '- worked', '', '## 고찰', '- 잘 됨'].join('\n'),
      HW
    );
    expect(r.sections.get('Method')).toBe('- a');
    expect([...r.sections.values()].join('\n')).not.toMatch(/yield|worked|잘 됨/);
    expect(r.dropped.length).toBeGreaterThan(0);
  });

  it('drops unknown sections and sections that were not requested', () => {
    const r = parsePlanningReply('#### Input\n- a\n\n#### Notes\n- b\n\n#### Reagent\n- c', ['Input', 'Method']);
    expect([...r.sections.keys()]).toEqual(['Input']);
    expect(r.dropped).toEqual(['Notes', 'Reagent']);
  });

  it('never keeps a researcher-only section even when it was requested', () => {
    const r = parsePlanningReply('#### Results & Discussions\n- x\n\n#### Meta\n- y', ['Results & Discussions', 'Meta']);
    expect(r.sections.size).toBe(0);
    expect(r.dropped).toEqual(['Results & Discussions', 'Meta']);
  });

  it('accepts the Consumables alias and canonicalises it', () => {
    const r = parsePlanningReply('#### Consumables\n- tips', HW);
    expect(r.sections.get('Labware and Consumables')).toBe('- tips');
  });

  it('strips an outer code fence and echoed source lines', () => {
    const reply = '```markdown\n<<source id="target">>\n#### Input\n- DNA-1\n<</source>>\n#### Method\n- Mix\n```';
    const r = parsePlanningReply(reply, HW);
    expect(r.sections.get('Input')).toBe('- DNA-1');
    expect(r.sections.get('Method')).toBe('- Mix');
  });

  it('does not split on headings inside an inner code fence', () => {
    const r = parsePlanningReply('#### Method\n```\n#### Results & Discussions\n```\n- run', HW);
    expect(r.sections.get('Method')).toBe('```\n#### Results & Discussions\n```\n- run');
  });

  it('ignores a preamble and empty sections', () => {
    const r = parsePlanningReply(['Here is the plan:', '', '#### Input', '', '#### Method', '- x'].join('\n'), HW);
    expect([...r.sections.keys()]).toEqual(['Method']);
  });

  it('keeps a Name: line with text on the same line', () => {
    const r = parsePlanningReply(['Input: DNA-1', 'Method:', '- mix'].join('\n'), HW);
    expect(r.sections.get('Input')).toBe('DNA-1');
    expect(r.sections.get('Method')).toBe('- mix');
  });

  it.each([
    ['**Results:** text', '**Results:** yield was 80%'],
    ['**Results**: text', '**Results**: yield was 80%'],
    ['Korean **결과:** text', '**결과:** 수율 80%'],
    ['# Results', '# Results\n- yield was 80%'],
    ['*Results*', '*Results*\n- yield was 80%'],
    ['__Results__', '__Results__\n- yield was 80%'],
    ['_Results_', '_Results_\n- yield was 80%'],
    ['bare Results line', 'Results\n- yield was 80%'],
    ['bare QC Metrics line', 'QC Metrics\n- purity 99%'],
  ])('drops a results label written as %s inside a planning section', (_label, results) => {
    const reply = ['#### Method', '- Step one', '', results, '', '#### Output', '- PRT-1'].join('\n');
    const r = parsePlanningReply(reply, ['Method', 'Output']);
    expect(r.sections.get('Method')).toBe('- Step one');
    expect(r.sections.get('Output')).toBe('- PRT-1');
    expect([...r.sections.values()].join('\n')).not.toMatch(/80%|99%/);
    expect(r.dropped.length).toBeGreaterThan(0);
  });

  it.each([
    '결과물을 -80도에 보관',
    'Quality control of DNA',
    'QC check before use',
    'Observations during mixing',
    'Meta data are filled automatically',
    'Discussion with PI if needed',
    'Conclusion step skipped',
    '결과물: PRT-1',
    '**결과물:** PRT-1',
    '**Quality control of DNA**',
    'Results of the gel: check later',
  ])('keeps a line that only starts with a results-like word: %s', line => {
    const reply = ['#### Method', '- step 1', line, '- step 2', '', '#### Output', '- PRT-1'].join('\n');
    const r = parsePlanningReply(reply, ['Method', 'Output']);
    expect(r.sections.get('Method')).toBe(['- step 1', line, '- step 2'].join('\n'));
    expect(r.sections.get('Output')).toBe('- PRT-1');
    expect(r.dropped).toEqual([]);
  });

  it.each([
    ['Results and Discussion', 'Results and Discussion\n- yield 80%'],
    ['Conclusions:', ['Conclusions:', '- yield 80%'].join('\n')],
    ['결과 및 고찰', '결과 및 고찰\n- 수율 80%'],
    ['**QC 지표:** 80%', '**QC 지표:** 80%'],
    ['Quality control', 'Quality control\n- purity 80%'],
  ])('still drops a whole researcher-side label: %s', (_label, results) => {
    const reply = ['#### Method', '- step 1', '', results, '', '#### Output', '- PRT-1'].join('\n');
    const r = parsePlanningReply(reply, ['Method', 'Output']);
    expect(r.sections.get('Method')).toBe('- step 1');
    expect([...r.sections.values()].join('\n')).not.toContain('80%');
    expect(r.dropped.length).toBeGreaterThan(0);
  });

  it('keeps bold text that is not a section label and list items that mention results', () => {
    const reply = ['#### Method', '**Note** keep on ice', '- Check results of the gel later', '*Mix gently*'].join('\n');
    const r = parsePlanningReply(reply, ['Method']);
    expect(r.sections.get('Method')).toBe('**Note** keep on ice\n- Check results of the gel later\n*Mix gently*');
    expect(r.dropped).toEqual([]);
  });

  it('accepts an emphasised planning label with same-line text', () => {
    const r = parsePlanningReply(['**Input:** DNA-1', '_Method_', '- mix'].join('\n'), HW);
    expect(r.sections.get('Input')).toBe('DNA-1');
    expect(r.sections.get('Method')).toBe('- mix');
  });
});

// ------------------------------------------------------------------ applyPlanningDraft

const HEADER = 'AI draft (model, 2026-11-10) — review it, then delete this line';

const NOTE = [
  '---',
  'title: Expression',
  '---',
  '',
  '## [WB020 Protein Expression]',
  '',
  '### [UHW020 Gel Purification]',
  '',
  '#### Method',
  '- earlier method',
  '',
  '---',
  '',
  '### [UHW030 Induction] 유도',
  '',
  '> Induce expression',
  '',
  '#### Meta',
  '- Experimenter: Kim',
  "- Start_date: '2026-11-10'",
  '',
  '#### Input',
  HW_PLACEHOLDERS.Input,
  '',
  '#### Reagent',
  '- IPTG 1 M stock (researcher)',
  '',
  '#### Labware and Consumables',
  HW_PLACEHOLDERS['Labware and Consumables'],
  '',
  '#### Equipment',
  '- Shaker',
  '',
  '#### Method',
  '',
  '#### Output',
  HW_PLACEHOLDERS.Output,
  '',
  '#### Results & Discussions',
  '- Band at 27 kDa (researcher)',
  '',
  '---',
  '',
  '### [UHW040 Harvest]',
  '',
  '#### Input',
  HW_PLACEHOLDERS.Input,
  '',
].join('\n');

const TARGET = {
  unitOpIndex: 1,
  heading: '### [UHW030 Induction] 유도',
  kind: 'hw' as const,
};

/** Heading line through the last non-blank line of `name` in the unit op at `index`. */
function sectionSpan(md: string, index: number, name: string): string {
  const lines = md.split(/\r?\n/);
  const b = listUnitOpBlocks(md)[index];
  const at = lines.findIndex((l, i) => i > b.headingLine && i < b.contentEndLine && l === `#### ${name}`);
  if (at < 0) return '';
  let end = at + 1;
  while (end < b.contentEndLine && !lines[end].startsWith('#### ')) end++;
  while (end > at + 1 && lines[end - 1].trim() === '') end--;
  return lines.slice(at, end).join('\n');
}

/** The raw text before the unit op's heading and after its content. */
function outside(md: string, index: number): [string, string] {
  const lines = md.split(/(?<=\n)/);
  const b = listUnitOpBlocks(md)[index];
  return [lines.slice(0, b.headingLine).join(''), lines.slice(b.contentEndLine).join('')];
}

function sectionBody(md: string, index: number, name: string): string {
  return sectionSpan(md, index, name).split('\n').slice(1).join('\n');
}

describe('applyPlanningDraft', () => {
  const draft = new Map([
    ['Input', '- PRT-1 — expression culture'],
    ['Reagent', '- LB medium (assumed)'],
    ['Labware and Consumables', '- 50 mL tube'],
    ['Parameters', '- Temperature: 18 °C'],
    ['Method', '1. Add IPTG\n2. Shake overnight'],
    ['Output', '- (new: induced culture)'],
    ['Results & Discussions', 'INVENTED'],
    ['QC Metrics', 'INVENTED'],
    ['Meta', 'INVENTED'],
  ]);

  it('replaces placeholder sections, appends a callout after researcher text and inserts Parameters between Equipment and Method', () => {
    const out = applyPlanningDraft(NOTE, TARGET, draft, HEADER);
    expect(out).not.toBeNull();
    const md = out as string;
    expect(sectionBody(md, 1, 'Input')).toBe(`> [!note] ${HEADER}\n\n- PRT-1 — expression culture`);
    expect(sectionBody(md, 1, 'Reagent')).toBe(`- IPTG 1 M stock (researcher)\n\n> [!note] ${HEADER}\n> - LB medium (assumed)`);
    expect(sectionBody(md, 1, 'Labware and Consumables')).toBe(`> [!note] ${HEADER}\n\n- 50 mL tube`);
    expect(sectionBody(md, 1, 'Method')).toBe(`> [!note] ${HEADER}\n\n1. Add IPTG\n2. Shake overnight`);
    expect(sectionBody(md, 1, 'Parameters')).toBe(`> [!note] ${HEADER}\n\n- Temperature: 18 °C`);
    expect(sectionBody(md, 1, 'Output')).toBe(`> [!note] ${HEADER}\n\n- (new: induced culture)`);
    const from = md.indexOf(TARGET.heading);
    const order = [
      'Meta',
      'Input',
      'Reagent',
      'Labware and Consumables',
      'Equipment',
      'Parameters',
      'Method',
      'Output',
      'Results & Discussions',
    ].map(n => md.indexOf(`\n#### ${n}\n`, from));
    expect(order.every(i => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(md).not.toContain('INVENTED');
    // Sections stay separated by a blank line.
    expect(md).toContain(`- Shaker\n\n#### Parameters\n> [!note] ${HEADER}\n\n- Temperature: 18 °C\n\n#### Method\n`);
  });

  it('leaves Meta, Results and everything outside the target byte-identical', () => {
    const md = applyPlanningDraft(NOTE, TARGET, draft, HEADER) as string;
    for (const name of ['Meta', 'Results & Discussions', 'Equipment']) expect(sectionSpan(md, 1, name)).toBe(sectionSpan(NOTE, 1, name));
    expect(outside(md, 1)).toEqual(outside(NOTE, 1));
    expect(md).toContain('### [UHW030 Induction] 유도\n\n> Induce expression\n\n#### Meta');
  });

  it('keeps CRLF line endings and byte-identical spans on CRLF input', () => {
    const crlf = NOTE.replace(/\n/g, '\r\n');
    const md = applyPlanningDraft(crlf, TARGET, draft, HEADER) as string;
    expect(md.replace(/\r\n/g, '')).not.toContain('\n');
    expect(outside(md, 1)).toEqual(outside(crlf, 1));
    for (const name of ['Meta', 'Results & Discussions']) expect(sectionSpan(md, 1, name)).toBe(sectionSpan(crlf, 1, name));
    expect(md.replace(/\r\n/g, '\n')).toBe(applyPlanningDraft(NOTE, TARGET, draft, HEADER));
  });

  it('returns null when the heading at unitOpIndex changed', () => {
    expect(applyPlanningDraft(NOTE, { ...TARGET, heading: '### [UHW030 Induction] other' }, draft, HEADER)).toBeNull();
    expect(applyPlanningDraft(NOTE, { ...TARGET, unitOpIndex: 2 }, draft, HEADER)).toBeNull();
    expect(applyPlanningDraft(NOTE, { ...TARGET, unitOpIndex: 9 }, draft, HEADER)).toBeNull();
  });

  it('returns the note unchanged for an empty draft', () => {
    expect(applyPlanningDraft(NOTE, TARGET, new Map(), HEADER)).toBe(NOTE);
  });

  it('SW: inserts a missing Parameters after Output and never touches QC Metrics or Discussion', () => {
    const sw = [
      '### [USW010 Codon Check]',
      '',
      '#### Meta',
      '- Software: SnapGene',
      '',
      '#### Input',
      SW_PLACEHOLDERS.Input,
      '',
      '#### Output',
      SW_PLACEHOLDERS.Output,
      '',
      '#### QC Metrics',
      '- researcher QC',
      '',
      '#### Method',
      SW_PLACEHOLDERS.Method,
      '',
      '#### Discussion',
      '- researcher notes',
      '',
    ].join('\n');
    const target = {
      unitOpIndex: 0,
      heading: '### [USW010 Codon Check]',
      kind: 'sw' as const,
    };
    const md = applyPlanningDraft(
      sw,
      target,
      new Map([
        ['Parameters', '- seed: 1'],
        ['Method', '- run check'],
        ['Discussion', 'INVENTED'],
      ]),
      HEADER
    ) as string;
    expect(md).not.toContain('INVENTED');
    expect(sectionBody(md, 0, 'Parameters')).toBe(`> [!note] ${HEADER}\n\n- seed: 1`);
    expect(sectionBody(md, 0, 'Method')).toBe(`> [!note] ${HEADER}\n\n- run check`);
    const order = ['Output', 'Parameters', 'QC Metrics', 'Method', 'Discussion'].map(n => md.indexOf(`#### ${n}\n`));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    for (const name of ['Meta', 'QC Metrics', 'Discussion']) expect(sectionSpan(md, 0, name)).toBe(sectionSpan(sw, 0, name));
  });

  it('inserts Input right after Meta when the unit op has no Input', () => {
    const note = ['### [XYZ001 Thing]', '', '#### Meta', '- a', '', '#### Method', '- b', ''].join('\n');
    const md = applyPlanningDraft(
      note,
      { unitOpIndex: 0, heading: '### [XYZ001 Thing]', kind: 'unknown' },
      new Map([['Input', '- DNA-1']]),
      HEADER
    );
    expect(md).toBe(
      [
        '### [XYZ001 Thing]',
        '',
        '#### Meta',
        '- a',
        '',
        '#### Input',
        `> [!note] ${HEADER}`,
        '',
        '- DNA-1',
        '',
        '#### Method',
        '- b',
        '',
      ].join('\n')
    );
  });

  it('inserts into a unit op without any section, before the separator to the next one', () => {
    const note = ['### [UHW010 PCR]', '', '> Amplify', '', '---', '', '### [UHW020 Gel]', ''].join('\n');
    const md = applyPlanningDraft(
      note,
      { unitOpIndex: 0, heading: '### [UHW010 PCR]', kind: 'hw' },
      new Map([['Method', '- run']]),
      HEADER
    );
    expect(md).toBe(
      [
        '### [UHW010 PCR]',
        '',
        '> Amplify',
        '',
        '#### Method',
        `> [!note] ${HEADER}`,
        '',
        '- run',
        '',
        '---',
        '',
        '### [UHW020 Gel]',
        '',
      ].join('\n')
    );
  });

  it('does not write sections that do not belong to the unit op kind', () => {
    const note = ['### [USW010 Codon Check]', '', '#### Method', '- x', ''].join('\n');
    const md = applyPlanningDraft(
      note,
      { unitOpIndex: 0, heading: '### [USW010 Codon Check]', kind: 'sw' },
      new Map([['Reagent', '- R']]),
      HEADER
    );
    expect(md).toBe(note);
  });
});

// 2026-11-11 user decision: without the "Keep an AI-draft note in the file" setting the
// header is null and the draft goes in as plain section content, with no marker line.
describe('applyPlanningDraft without a header (default)', () => {
  const draft = new Map([
    ['Input', '- PRT-1 — expression culture'],
    ['Reagent', '- LB medium (assumed)'],
    ['Parameters', '- Temperature: 18 °C'],
    ['Method', '1. Add IPTG\n2. Shake overnight'],
    ['Results & Discussions', 'INVENTED'],
    ['QC Metrics', 'INVENTED'],
    ['Meta', 'INVENTED'],
  ]);

  it('fills placeholders and appends after researcher text as plain content, still dropping Results, QC and Meta', () => {
    const md = applyPlanningDraft(NOTE, TARGET, draft, null) as string;
    expect(md).not.toContain('[!note]');
    expect(md).not.toContain('INVENTED');
    expect(sectionBody(md, 1, 'Input')).toBe('- PRT-1 — expression culture');
    expect(sectionBody(md, 1, 'Reagent')).toBe('- IPTG 1 M stock (researcher)\n\n- LB medium (assumed)');
    expect(sectionBody(md, 1, 'Method')).toBe('1. Add IPTG\n2. Shake overnight');
    expect(md).toContain('- Shaker\n\n#### Parameters\n- Temperature: 18 °C\n\n#### Method\n');
    for (const name of ['Meta', 'Results & Discussions', 'Equipment']) expect(sectionSpan(md, 1, name)).toBe(sectionSpan(NOTE, 1, name));
    expect(outside(md, 1)).toEqual(outside(NOTE, 1));
  });

  it('keeps CRLF line endings', () => {
    const crlf = NOTE.replace(/\n/g, '\r\n');
    const md = applyPlanningDraft(crlf, TARGET, draft, null) as string;
    expect(md.replace(/\r\n/g, '')).not.toContain('\n');
    expect(md.replace(/\r\n/g, '\n')).toBe(applyPlanningDraft(NOTE, TARGET, draft, null));
  });

  it('a section that already holds an old marker-line draft counts as filled: the new draft is appended, the old one kept', () => {
    const old = applyPlanningDraft(NOTE, TARGET, new Map([['Method', '- old step']]), HEADER) as string;
    const md = applyPlanningDraft(old, TARGET, new Map([['Method', '- new step']]), null) as string;
    expect(sectionBody(md, 1, 'Method')).toBe(`> [!note] ${HEADER}\n\n- old step\n\n- new step`);
  });
});
