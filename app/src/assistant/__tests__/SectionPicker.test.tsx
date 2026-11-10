// @vitest-environment jsdom
/**
 * 섹션 고르기(assistant spec §4.4 섹션 만들기, plan Task 11B): 열린 노트의 제목들, 단위 공정 안이면 그 공정의 계획 섹션
 * (`draftableSections`) 이 먼저, 연구자만 쓰는 섹션은 없고, 끝에 "새 제목…".
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { setLang } from '../../i18n/lang';
import { PLANNING_SECTIONS_HW } from '../../labnote/context/chain';
import { SectionPicker, sectionOptions, type SectionChoice } from '../SectionPicker';

const MD = [
  '---',
  'title: A',
  '---',
  '# A',
  '',
  '## [WD010 A]',
  '',
  '### [UHW010 Liquid handling]',
  '',
  '#### Input',
  '',
  '- S1',
  '',
  '#### Method',
  '',
  '- pipette',
  '',
  '#### Results & Discussions',
  '',
  '#### QC Metrics',
  '',
  '### [USW020 Analysis]',
  '',
  '#### Method',
  '',
  '## 메모',
  '',
  'memo',
  '',
  '## 결과 및 논의',
  '',
  '## Meta',
  '',
].join('\n');
const LINE_IN_UHW = MD.split('\n').indexOf('- pipette');

beforeEach(() => setLang('ko'));
afterEach(() => cleanup());

describe('sectionOptions', () => {
  it('outside a unit operation: the note headings (no title, no unit op blocks), no researcher-only sections', () => {
    const opts = sectionOptions(MD);
    const headings = opts.map((o) => o.heading);
    expect(headings).toContain('[WD010 A]');
    expect(headings).toContain('메모');
    expect(headings).not.toContain('A');
    expect(headings).not.toContain('[UHW010 Liquid handling]');
    for (const bad of ['Results & Discussions', 'QC Metrics', '결과 및 논의', 'Meta']) expect(headings).not.toContain(bad);
    expect(opts.every((o) => o.existing)).toBe(true);
    expect(opts.some((o) => o.planning)).toBe(false);
  });

  it('inside a unit operation: its planning sections first (existing ones with their parent), then the other headings', () => {
    const opts = sectionOptions(MD, LINE_IN_UHW);
    const planning = opts.filter((o) => o.planning);
    expect(planning.map((o) => o.heading)).toEqual([...PLANNING_SECTIONS_HW]);
    expect(opts.slice(0, planning.length)).toEqual(planning);
    for (const o of planning) expect(o.parentHeading).toBe('[UHW010 Liquid handling]');
    expect(planning.find((o) => o.heading === 'Method')?.existing).toBe(true);
    expect(planning.find((o) => o.heading === 'Input')?.existing).toBe(true);
    expect(planning.find((o) => o.heading === 'Reagent')?.existing).toBe(false);
    const rest = opts.slice(planning.length).map((o) => o.heading);
    expect(rest).toContain('메모');
    expect(rest).not.toContain('Results & Discussions');
    expect(rest).not.toContain('QC Metrics');
  });
});

function Host(props: { md: string; line?: number; onPick?: (c: SectionChoice | null) => void }) {
  const [value, setValue] = useState<SectionChoice | null>(null);
  return (
    <SectionPicker
      options={sectionOptions(props.md, props.line)}
      value={value}
      onChange={(c) => {
        setValue(c);
        props.onPick?.(c);
      }}
    />
  );
}

describe('SectionPicker', () => {
  it('asks "어떤 섹션?" with the headings and "새 제목…" last', () => {
    render(<Host md={MD} line={LINE_IN_UHW} />);
    const select = screen.getByRole('combobox', { name: '어떤 섹션?' }) as HTMLSelectElement;
    const labels = [...select.options].map((o) => o.textContent);
    expect(labels.at(-1)).toBe('새 제목…');
    expect(labels.some((l) => l?.startsWith('Input'))).toBe(true);
    expect(labels.some((l) => l?.includes('QC Metrics'))).toBe(false);
  });

  it('picking a heading reports it with its parent; "새 제목…" shows a title field and reports a new heading', () => {
    const picks: Array<SectionChoice | null> = [];
    render(<Host md={MD} line={LINE_IN_UHW} onPick={(c) => picks.push(c)} />);
    const select = screen.getByRole('combobox', { name: '어떤 섹션?' }) as HTMLSelectElement;
    const method = [...select.options].find((o) => o.textContent?.startsWith('Method'))!;
    fireEvent.change(select, { target: { value: method.value } });
    expect(picks.at(-1)).toEqual({ heading: 'Method', parentHeading: '[UHW010 Liquid handling]', existing: true });
    expect(screen.queryByRole('textbox', { name: '새 섹션 제목' })).toBeNull();

    fireEvent.change(select, { target: { value: 'new' } });
    const title = screen.getByRole('textbox', { name: '새 섹션 제목' });
    fireEvent.change(title, { target: { value: '배양 조건' } });
    expect(picks.at(-1)).toEqual({ heading: '배양 조건', existing: false });
  });

  it('en labels', () => {
    setLang('en');
    render(<Host md={MD} />);
    const select = screen.getByRole('combobox', { name: 'Which section?' }) as HTMLSelectElement;
    expect([...select.options].at(-1)?.textContent).toBe('New heading…');
  });
});
