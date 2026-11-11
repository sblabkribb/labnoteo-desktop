import { describe, expect, it } from 'vitest';
import {
  checklistLines,
  insertChecklistLine,
  insertLegacyChecklistLine,
  nextWorkflowSeq,
  parseWfName,
  physicalSteps,
  planCloseGap,
  planInsert,
  planMove,
  readOrder,
  relabelChecklist,
  removeChecklistLine,
  reorderChecklist,
  TargetTakenError,
  type WfName,
} from '../workflowOrderPlan';

const A = '001_WD090_Design.labnote.md';
const B = '002_WB010_Oligo.labnote.md';
const C = '003_WB020_Clone.labnote.md';
const D = '004_WT010_Test.labnote.md';

const readme = (lines: string[], eol = '\n') =>
  ['---', 'title: x', '---', '', '## Related Workflows', '', ...lines, '', '## Summary', ''].join(eol);
const line = (name: string, done = false, label = name.slice(4).replace(/(\.labnote)?\.md$/, '').replace(/_/g, ' ')) =>
  `- [${done ? 'x' : ' '}] [${label}](./${name})`;
const ws = (...names: string[]) => names.map((n) => parseWfName(n)!) as WfName[];

describe('parseWfName', () => {
  it('reads modern and legacy names and keeps the extension', () => {
    expect(parseWfName(A)).toMatchObject({ seq: 1, id: 'WD090', rest: 'Design', ext: '.labnote.md' });
    expect(parseWfName('007_WD090_DNA Pool.md')).toMatchObject({ seq: 7, rest: 'DNA Pool', ext: '.md' });
    expect(parseWfName('README.md')).toBeUndefined();
    expect(parseWfName('notes.md')).toBeUndefined();
    expect(parseWfName('001_data.csv')).toBeUndefined();
  });
});

describe('readOrder', () => {
  it('accepts a folder that agrees with its checklist (gaps allowed)', () => {
    const s = readOrder([A, C, 'README.labnote.md', 'other.md'], readme([line(A), line(C, true)]));
    expect(s.ok).toBe(true);
    if (s.ok) expect(s.items.map((i) => i.name)).toEqual([A, C]);
  });

  it('reads legacy bare lines with CRLF and NNN labels', () => {
    const a = '001_WD090_Design.md';
    const b = '002_WB010_Oligo.md';
    const text = readme([`[x] [001 WD090 Design](./${a})`, `[ ] [002 WB010 Oligo](./${b})`], '\r\n');
    const s = readOrder([a, b, 'README.md'], text);
    expect(s.ok).toBe(true);
  });

  it.each([
    ['noReadme', [A], undefined],
    ['noSection', [A], '# x\n'],
    ['unlisted', [A, B], readme([line(A)])],
    ['missing', [A], readme([line(A), line(B)])],
    ['duplicate', [A], readme([line(A), line(A)])],
    ['sameNumber', [A, '001_WB010_Other.labnote.md'], readme([line(A), line('001_WB010_Other.labnote.md')])],
    ['staging', [A, '002_WB010_Oligo_staging1.labnote.md'], readme([line(A)])],
    ['order', [A, B], readme([line(B), line(A)])],
    ['outside', [A], readme([line(A), '- [ ] [x](../002_x/001_WD090_Design.labnote.md)'])],
  ])('refuses: %s', (reason, names, text) => {
    const s = readOrder(names as string[], text as string | undefined);
    expect(s.ok).toBe(false);
    if (!s.ok) expect(s.refusal.reason).toBe(reason);
  });

  it('matches wikilink entries', () => {
    const s = readOrder([A, B], readme([`- [ ] [[${A.replace('.md', '')}|Design]]`, line(B)]));
    expect(s.ok).toBe(true);
  });
});

describe('planMove', () => {
  it('a swap is two renames', () => {
    expect(planMove(ws(A, B, C), 1, 2)).toEqual([
      { from: C, to: '002_WB020_Clone.labnote.md' },
      { from: B, to: '003_WB010_Oligo.labnote.md' },
    ]);
  });
  it('dragging the first below the fourth renames four', () => {
    expect(planMove(ws(A, B, C, D), 0, 3).map((m) => m.to)).toEqual([
      '001_WB010_Oligo.labnote.md',
      '002_WB020_Clone.labnote.md',
      '003_WT010_Test.labnote.md',
      '004_WD090_Design.labnote.md',
    ]);
  });
  it('keeps slot numbers so gaps elsewhere stay', () => {
    const e = '005_WB030_Five.labnote.md';
    expect(planMove(ws(A, C, e), 1, 2)).toEqual([
      { from: e, to: '003_WB030_Five.labnote.md' },
      { from: C, to: '005_WB020_Clone.labnote.md' },
    ]);
  });
  it('keeps legacy .md', () => {
    expect(planMove(ws('001_WD090_A.md', '002_WB010_B.md'), 0, 1)).toEqual([
      { from: '002_WB010_B.md', to: '001_WB010_B.md' },
      { from: '001_WD090_A.md', to: '002_WD090_A.md' },
    ]);
  });
});

describe('planInsert / planCloseGap', () => {
  it('shifts the following ones and stops at the first gap', () => {
    const e = '005_WB030_Five.labnote.md';
    expect(planInsert(ws(A, B, C, e), 0)).toEqual({
      seq: 2,
      moves: [
        { from: B, to: '003_WB010_Oligo.labnote.md' },
        { from: C, to: '004_WB020_Clone.labnote.md' },
      ],
    });
    expect(planInsert(ws(A, C), 0)).toEqual({ seq: 2, moves: [] });
    expect(planInsert(ws(A, B), 1)).toEqual({ seq: 3, moves: [] });
  });
  it('closes the gap after a delete', () => {
    expect(planCloseGap(ws(A, C, D), 2)).toEqual([
      { from: C, to: '002_WB020_Clone.labnote.md' },
      { from: D, to: '003_WT010_Test.labnote.md' },
    ]);
  });
});

describe('physicalSteps', () => {
  it('a swap of different names needs no staging', () => {
    const moves = planMove(ws(A, B), 0, 1);
    expect(physicalSteps(moves, [A, B])).toEqual(moves);
  });
  it('a swap of two same-named copies goes through a staging name', () => {
    const x1 = '001_WD090_Design.labnote.md';
    const x2 = '002_WD090_Design.md';
    const y1 = '001_WD090_Same.md';
    const y2 = '002_WD090_Same.md';
    expect(physicalSteps(planMove(ws(y1, y2), 0, 1), [y1, y2])).toEqual([
      { from: y2, to: '002_WD090_Same_staging1.md' },
      { from: y1, to: y2 },
      { from: '002_WD090_Same_staging1.md', to: y1 },
    ]);
    expect(physicalSteps(planMove(ws(x1, x2), 0, 1), [x1, x2])).toHaveLength(2);
  });
  it('a shift renames each note once', () => {
    const { moves } = planInsert(ws(A, B, C), 0);
    expect(physicalSteps(moves, [A, B, C])).toEqual(moves);
  });
  it('a shift of same-named copies runs from the top down', () => {
    const n = (k: number) => `00${k}_WD090_Same.md`;
    const { moves } = planInsert(ws(n(1), n(2), n(3)), 0);
    expect(physicalSteps(moves, [n(1), n(2), n(3)])).toEqual([
      { from: n(3), to: n(4) },
      { from: n(2), to: n(3) },
    ]);
  });
  it('a non-Workflow file on a target name is never overwritten (case-insensitive)', () => {
    const moves = [{ from: A, to: '002_WD090_Design.labnote.md' }];
    expect(() => physicalSteps(moves, [A, '002_wd090_design.LABNOTE.md'])).toThrow(TargetTakenError);
  });
});

describe('checklist line edits', () => {
  const todo = '- [ ] 시약 주문하기';
  const text = readme([line(A, true), '    - 메모', todo, line(B), line(C)], '\r\n').split('\r\n').join('\r\n');

  it('reorder moves blocks with their sub-lines and keeps to-dos and CRLF in place', () => {
    const out = reorderChecklist(text, [B, A, C]);
    const lines = out.split('\n');
    const start = lines.findIndex((l) => l.startsWith('## Related'));
    expect(lines.slice(start + 2, start + 7)).toEqual([`${line(B)}\r`, `${todo}\r`, `${line(A, true)}\r`, '    - 메모\r', `${line(C)}\r`]);
    expect(out.length).toBe(text.length);
  });

  it('relabel replaces only a leading old number', () => {
    const t = readme([`[x] [001 WD090 Design](./001_WD090_Design.md)`, `[ ] [WB010 Oligo](./002_WB010_Oligo.md)`]);
    const out = relabelChecklist(t, [
      { from: '001_WD090_Design.md', to: '002_WD090_Design.md' },
      { from: '002_WB010_Oligo.md', to: '001_WB010_Oligo.md' },
    ]);
    expect(out).toContain('[x] [002 WD090 Design](./001_WD090_Design.md)');
    expect(out).toContain('[ ] [WB010 Oligo](./002_WB010_Oligo.md)');
  });

  it('removes exactly one line', () => {
    const out = removeChecklistLine(text, B);
    expect(out).not.toContain(B);
    expect(out.split('\n').length).toBe(text.split('\n').length - 1);
    expect(checklistLines(out)!.map((e) => e.name)).toEqual([A, C]);
  });

  it('inserts after a block, copying a bare prefix, NNN labels and CRLF', () => {
    const t = readme([`[x] [001 WD090 Design](./001_WD090_Design.md)`, '  note', `[ ] [002 WB010 Oligo](./002_WB010_Oligo.md)`], '\r\n');
    const out = insertChecklistLine(t, '001_WD090_Design.md', { fileName: '002_WB020_New_x.labnote.md', title: 'WB020 New x', seq: 2 });
    const lines = out.split('\n');
    const i = lines.findIndex((l) => l.includes('WB020'));
    expect(lines[i]).toBe('[ ] [002 WB020 New x](./002_WB020_New_x.labnote.md)\r');
    expect(lines[i - 1]).toBe('  note\r');
  });
});

describe('nextWorkflowSeq', () => {
  it('counts legacy names', () => {
    expect(nextWorkflowSeq(['001_WD090_x.md', '002_WB010_y.md', 'README.md'])).toBe(3);
    expect(nextWorkflowSeq([])).toBe(1);
  });
});

describe('insertLegacyChecklistLine', () => {
  const sec = (lines: string[]) => ['## 🗂️ Related Workflows', '', ...lines, '', '## Summary and Discussion', ''].join('\n');
  it('leaves a README with any .labnote.md line to the core', () => {
    expect(insertLegacyChecklistLine(sec(['- [ ] [WD090 x](./001_WD090_x.labnote.md)']), { fileName: '002_WD030_y.labnote.md', title: 'WD030 y' })).toBeUndefined();
    expect(insertLegacyChecklistLine(sec([]), { fileName: '002_WD030_y.labnote.md', title: 'WD030 y' })).toBeUndefined();
  });
  it('puts the line by number among legacy lines, in their shape', () => {
    const text = sec(['[x] [001 WD090 x](./001_WD090_x.md)', '[ ] [003 WB010 z](./003_WB010_z.md)']);
    const out = insertLegacyChecklistLine(text, { fileName: '002_WD030_y.labnote.md', title: 'WD030 y' })!;
    expect(out.split('\n').slice(2, 5)).toEqual([
      '[x] [001 WD090 x](./001_WD090_x.md)',
      '[ ] [002 WD030 y](./002_WD030_y.labnote.md)',
      '[ ] [003 WB010 z](./003_WB010_z.md)',
    ]);
  });
});
