/** 실험 탭 테스트의 보관함: 실험 003 에 워크플로 셋(체크 하나, UO 일부 완료 하나, 시작 전 하나), 그림 2, 첨부 1. */
export const EXP = 'labnote/003_E_coli_host';
export const WF1 = `${EXP}/001_WB030_DNA_Assembly_Gibson_run.labnote.md`;
export const WF2 = `${EXP}/002_WT020_Protein_Expression_Measurement_GFP.labnote.md`;
export const WF3 = `${EXP}/003_WD010_Design.labnote.md`;
export const PLAN = 'labnote/004_Plan';
export const DONE = 'labnote/005_Done';

export function uo(id: string, name: string, alias: string, end: string): string[] {
  return ['---', '', `### [${id} ${name}]${alias ? ` ${alias}` : ''}`, '', '#### Meta', '- Experimenter: A', "- Start_date: ''", `- End_date: '${end}'`, '', '#### Method', '- x', ''];
}

export function workflowNote(id: string, name: string, alias: string, uos: string[][]): string {
  return [
    '---',
    `title: ${id} ${name}${alias ? ` ${alias}` : ''}`,
    '---',
    `## [${id} ${name}]${alias ? ` ${alias}` : ''}`,
    '',
    '## Related Unit Operations',
    '',
    ...uos.flat(),
    '## Conclusions and Discussion',
    '',
  ].join('\n');
}

export function expReadme(title: string, status: string, checklist: string[], extra = ''): string {
  return [
    '---',
    `title: ${title}`,
    'author: [한서연]',
    'project: 단백질 발현',
    `status: ${status}`,
    'last_updated_date: 2026-02-03',
    `${extra}---`,
    '',
    '## 🗂️ Related Workflows',
    '',
    ...checklist,
    '',
    '## Summary and Discussion',
    '',
  ].join('\n');
}

export function experimentVault(): Record<string, string> {
  return {
    [`${EXP}/README.labnote.md`]: expReadme('대장균 숙주 비교', 'in-progress', [
      '- [x] [WB030 DNA Assembly Gibson run](./001_WB030_DNA_Assembly_Gibson_run.labnote.md)',
      '- [ ] [WT020 Protein Expression Measurement GFP](./002_WT020_Protein_Expression_Measurement_GFP.labnote.md)',
      '- [ ] [WD010 Design](./003_WD010_Design.labnote.md)',
    ]),
    // 차례가 섞여 들어와도 파일 번호 차례로 선다
    [WF3]: workflowNote('WD010', 'Design', '', []),
    [WF1]: workflowNote('WB030', 'DNA Assembly', 'Gibson run', [uo('UHW250', 'DNA Assembly', 'Gibson', '2026-01-02 10:00')]),
    [WF2]: workflowNote('WT020', 'Protein Expression Measurement', 'GFP', [
      uo('UHW180', 'Incubation', '', '2026-01-03 08:00'),
      uo('UHW380', 'Microplate Reading', 'plate 1', ''),
    ]),
    [`${EXP}/images/gel.png`]: 'png',
    [`${EXP}/images/blot.png`]: 'png',
    [`${EXP}/resources/plate.csv`]: 'a,b',
    [`${EXP}/resources/labsamples/x.md`]: '# x',
    [`${PLAN}/README.labnote.md`]: expReadme('계획만', 'planned', []),
    [`${DONE}/README.labnote.md`]: expReadme('끝난 실험', 'completed', []),
  };
}
