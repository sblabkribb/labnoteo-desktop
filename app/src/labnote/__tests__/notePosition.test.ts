import { notePosition } from '../notePosition';

const EXP = 'labnote/003_E_coli_host_comparison';
const WF = `${EXP}/002_WT020_Protein_Expression_Measurement_GFP_fluorescence.labnote.md`;

function uo(id: string, name: string, start: string, end: string): string[] {
  return ['---', '', `### [${id} ${name}]`, '', '#### Meta', '- Experimenter: A', `- Start_date: '${start}'`, `- End_date: '${end}'`, '', '#### Method', '- x', ''];
}

const WF_TEXT = [
  '---',
  'title: WT020 Protein Expression Measurement GFP fluorescence',
  "end_date: ''",
  '---',
  '## [WT020 Protein Expression Measurement] GFP fluorescence',
  '',
  '## Related Unit Operations',
  '',
  ...uo('UHW180', 'Incubation', '2026-11-08 16:30', '2026-11-09 08:00'),
  ...uo('UHW380', 'Microplate Reading', '2026-11-09 09:40', ''),
  '## Conclusions and Discussion',
  '',
].join('\n');

const README_TEXT = [
  '---',
  'title: E. coli host comparison',
  'status: in-progress',
  '---',
  '## 🗂️ Related Workflows',
  '',
  '- [x] [WB150 PCR](./001_WB150_PCR.labnote.md)',
  '- [ ] [WT020 Measure](./002_WT020_Measure.labnote.md)',
  '- [ ] [WT030 More](./003_WT030_More.labnote.md)',
  '',
].join('\n');

describe('notePosition', () => {
  it('a workflow note with two UOs, one with End_date', () => {
    const p = notePosition(WF, WF_TEXT, { now: '2026-11-10 12:00' });
    expect(p.kind).toBe('workflow');
    if (p.kind !== 'workflow') return;
    expect(p.experiment).toEqual({ folder: EXP, readme: `${EXP}/README.labnote.md`, code: '003', title: 'E coli host comparison' });
    expect(p.workflow).toEqual({ path: WF, id: 'WT020', title: 'GFP fluorescence' });
    expect(p.uoTotal).toBe(2);
    expect(p.uoDone).toBe(1);
    expect(p.uos.map((u) => [u.id, u.name, u.done])).toEqual([
      ['UHW180', 'Incubation', true],
      ['UHW380', 'Microplate Reading', false],
    ]);
    expect(WF_TEXT.split('\n')[p.uos[1].line]).toBe('### [UHW380 Microplate Reading]');
    expect(p.status).toBe('in-progress');
  });

  it('the UO under the cursor line', () => {
    const lines = WF_TEXT.split('\n');
    const second = lines.indexOf('### [UHW380 Microplate Reading]') + 1;
    const p = notePosition(WF, WF_TEXT, { line: second + 2, now: '2026-11-10 12:00' });
    expect(p.kind === 'workflow' && p.uoIndex).toBe(1);
    const top = notePosition(WF, WF_TEXT, { line: 1, now: '2026-11-10 12:00' });
    expect(top.kind === 'workflow' && top.uoIndex).toBeUndefined();
  });

  it('each UO ends before the next heading of level 1 to 3, so trailing sections belong to none', () => {
    const text = `${WF_TEXT}\n## Conclusions and Discussion\n\nok\n`;
    const p = notePosition(WF, text, { now: '2026-11-10 12:00' });
    if (p.kind !== 'workflow') throw new Error('workflow');
    const lines = text.split('\n');
    expect(p.uos[0].end).toBe(p.uos[1].line);
    expect(lines[p.uos[1].end]).toBe('## Conclusions and Discussion');
    const below = notePosition(WF, text, { line: lines.length, now: '2026-11-10 12:00' });
    expect(below.kind === 'workflow' && below.uoIndex).toBeUndefined();
  });

  it('a workflow whose UOs all ended is done; one with no UOs is planned', () => {
    const ended = WF_TEXT.replace("- End_date: ''", "- End_date: '2026-11-09 12:00'");
    const p = notePosition(WF, ended, { now: '2026-11-10 12:00' });
    expect(p.kind === 'workflow' && [p.uoDone, p.status]).toEqual([2, 'done']);
    const empty = notePosition(WF, '## [WT020 Protein Expression Measurement] GFP fluorescence\n');
    expect(empty.kind === 'workflow' && [empty.uoTotal, empty.status]).toEqual([0, 'planned']);
  });

  it('a README with 1 of 3 workflows ticked', () => {
    const p = notePosition(`${EXP}/README.labnote.md`, README_TEXT);
    expect(p).toEqual({
      kind: 'readme',
      experiment: { folder: EXP, readme: `${EXP}/README.labnote.md`, code: '003', title: 'E. coli host comparison' },
      wfDone: 1,
      wfTotal: 3,
      status: 'in-progress',
    });
  });

  it('a plain note gives its folder and title', () => {
    expect(notePosition('Protocols/Making LB medium.labnote.md', '# x')).toEqual({ kind: 'note', folder: 'Protocols', title: 'Making LB medium' });
    expect(notePosition('Lab meeting.md', '')).toEqual({ kind: 'note', folder: '', title: 'Lab meeting' });
  });
});
