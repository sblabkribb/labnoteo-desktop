// @vitest-environment jsdom
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { history, undo } from '@codemirror/commands';
import { labnoteMarkdown } from '../../markdownSyntax';
import { tableExtension } from '../../table/field';
import { livePreview } from '../index';
import { uoSections } from '../uoCards';
import { formatMetaDate } from '../dateChip';
import { checkDates } from '../../../labnote/port/metaDateChecks';
import { setLang } from '../../../i18n/lang';
import { clearToasts, currentToasts } from '../../../labnote/host/toastStore';

// jsdom 에는 레이아웃이 없다. CodeMirror 가 측정에 쓰는 API 만 빈 값으로 채운다.
const emptyRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
Range.prototype.getClientRects ??= emptyRects;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();
document.execCommand ??= () => false;

const views: EditorView[] = [];

function view(doc: string, pos: number, live = true): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const v = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor: Math.min(pos, doc.length) },
      extensions: [history(), labnoteMarkdown(), ...(live ? [livePreview(), tableExtension({ save: () => {}, root: document })] : [])],
    }),
  });
  views.push(v);
  return v;
}

afterEach(() => {
  while (views.length) views.pop()!.destroy();
  document.body.innerHTML = '';
  clearToasts();
  setLang('ko');
});

const NOTE = [
  '## [WB150 PCR-based Target Amplification] GFP amplification',
  '',
  '## Related Unit Operations',
  '- [UHW010 Liquid Handling](#uhw010-liquid-handling)',
  '',
  '---',
  '',
  '### [UHW010 Liquid Handling] mix',
  '',
  '#### Meta',
  '- Experimenter: Alex',
  "- Start_date: '2026-11-03 10:15'",
  "- End_date: '2026-11-03 12:00'",
  '',
  '#### Reagent',
  '- (e.g. enzyme, buffer, etc.)',
  '',
  '---',
  '',
  '### [UHW100 Thermocycling]',
  '',
  '#### Meta',
  '- Experimenter: Alex',
  "- Start_date: '2026-11-03 11:00'",
  "- End_date: ''",
  '',
  '#### Method',
  '- (method used in this step)',
  '',
  '## Conclusions and Discussion',
  'Done (really).',
].join('\n');

const at = (s: string) => NOTE.indexOf(s);
const lineEls = (v: EditorView, cls: string) => [...v.contentDOM.querySelectorAll<HTMLElement>(`.cm-line.${cls}`)];

describe('uoSections', () => {
  it('finds each UO section with its code, alias and Meta dates', () => {
    const secs = uoSections(EditorState.create({ doc: NOTE }).doc);
    expect(secs.map((s) => [s.code, s.alias, s.start, s.end])).toEqual([
      ['UHW010', 'mix', '2026-11-03 10:15', '2026-11-03 12:00'],
      ['UHW100', '', '2026-11-03 11:00', ''],
    ]);
    // a section stops before the rule and blank lines that lead into the next one
    expect(NOTE.slice(secs[0].from, secs[0].to).endsWith('- (e.g. enzyme, buffer, etc.)')).toBe(true);
    expect(NOTE.slice(secs[1].from, secs[1].to).endsWith('- (method used in this step)')).toBe(true);
  });

  it('ignores headings inside fenced code', () => {
    const doc = ['```', '### [UHW010 Fake]', '```', '### [USW020 Real]', 'x'].join('\n');
    expect(uoSections(EditorState.create({ doc }).doc).map((s) => s.code)).toEqual(['USW020']);
  });
});

describe('UO cards', () => {
  it('draws one card per UO section and marks the one holding the cursor', () => {
    const v = view(NOTE, at('- Experimenter: Alex'));
    expect(lineEls(v, 'cm-uo-card-first')).toHaveLength(2);
    expect(lineEls(v, 'cm-uo-card-last')).toHaveLength(2);
    const active = lineEls(v, 'cm-uo-card-active');
    expect(active.length).toBeGreaterThan(3);
    expect(active[0].classList.contains('cm-uo-card-first')).toBe(true);
    expect(active[0].textContent).toContain('UHW010');
    // the conclusions are not in a card
    expect(lineEls(v, 'cm-uo-card').some((l) => l.textContent?.includes('Conclusions'))).toBe(false);
    v.dispatch({ selection: { anchor: at('#### Method') } });
    expect(lineEls(v, 'cm-uo-card-active')[0].textContent).toContain('UHW100');
  });

  it('shows the code chip and a done / in-progress chip', () => {
    const v = view(NOTE, at('## Conclusions'));
    const chips = [...v.contentDOM.querySelectorAll('.lno-uo-code')].map((c) => c.textContent);
    expect(chips).toContain('UHW100');
    const status = [...v.contentDOM.querySelectorAll<HTMLElement>('.lno-uo-status')];
    expect(status.map((s) => s.textContent)).toEqual(['완료', '진행 중']);
    expect(status[0].classList.contains('lno-status-done')).toBe(true);
    expect(status[1].classList.contains('lno-status-inProgress')).toBe(true);
  });

  it('labels the #### headings of a UO without changing the text', () => {
    const v = view(NOTE, 0);
    const labels = lineEls(v, 'cm-uo-label');
    expect(labels.map((l) => l.textContent)).toEqual(['Meta', 'Reagent', 'Meta', 'Method']);
    expect(v.state.doc.toString()).toBe(NOTE);
  });
});

describe('date chips', () => {
  const chips = (v: EditorView) => [...v.contentDOM.querySelectorAll<HTMLElement>('.lno-date-chip')];

  it('formats a date the plugin way (Seoul time)', () => {
    expect(formatMetaDate(new Date('2026-11-10T05:30:00Z'))).toBe('2026-11-10 14:30');
  });

  it('shows the dates as chips and an empty End_date as "Pick a date"', () => {
    const v = view(NOTE, 0);
    const c = chips(v);
    expect(c.map((x) => x.textContent)).toEqual(['2026-11-03 10:15', '2026-11-03 12:00', '2026-11-03 11:00', '날짜 고르기']);
    expect(c[3].classList.contains('lno-date-empty')).toBe(true);
  });

  function pick(v: EditorView, chip: HTMLElement, value: string) {
    chip.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
    chip.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    const input = v.dom.querySelector<HTMLInputElement>('.lno-date-pop input[type="datetime-local"]')!;
    expect(input).not.toBeNull();
    input.value = value;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  }

  it('writes the picked date in one undoable step, keeping the quotes', () => {
    const v = view(NOTE, 0);
    pick(v, chips(v)[3], '2026-11-10T14:30');
    expect(v.state.doc.toString()).toBe(NOTE.replace("- End_date: ''", "- End_date: '2026-11-10 14:30'"));
    expect(v.dom.querySelector('.lno-date-pop')).toBeNull();
    undo(v);
    expect(v.state.doc.toString()).toBe(NOTE);
  });

  it('quotes an unquoted empty value', () => {
    const doc = NOTE.replace("- End_date: ''", '- End_date:');
    const v = view(doc, 0);
    pick(v, chips(v)[3], '2026-11-10T14:30');
    expect(v.state.doc.toString()).toContain("- End_date: '2026-11-10 14:30'");
  });

  it('the Now button writes the current time', () => {
    const v = view(NOTE, 0);
    chips(v)[3].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    v.dom.querySelector<HTMLButtonElement>('.lno-date-pop .lno-date-now')!.click();
    expect(v.state.doc.toString()).toMatch(/- End_date: '[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}'/);
  });

  it('warns when End is before Start and still writes', () => {
    const v = view(NOTE, 0);
    pick(v, chips(v)[3], '2026-11-01T09:00');
    expect(v.state.doc.toString()).toContain("- End_date: '2026-11-01 09:00'");
    const warn = currentToasts().find((x) => x.kind === 'warn');
    expect(warn?.message).toContain('2026-11-01 09:00');
  });

  it('does not write an implausible year', () => {
    const v = view(NOTE, 0);
    pick(v, chips(v)[3], '0202-11-01T09:00');
    expect(v.state.doc.toString()).toBe(NOTE);
    expect(currentToasts().some((x) => x.kind === 'warn')).toBe(true);
  });

  it('Escape closes without writing', () => {
    const v = view(NOTE, 0);
    chips(v)[3].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    const input = v.dom.querySelector<HTMLInputElement>('.lno-date-pop input')!;
    input.value = '2026-11-10T14:30';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(v.dom.querySelector('.lno-date-pop')).toBeNull();
    expect(v.state.doc.toString()).toBe(NOTE);
  });

  it('checkDates names the problem', () => {
    expect(checkDates('2026-11-03 10:15', '2026-11-03 12:00')).toBe('ok');
    expect(checkDates('2026-11-03 10:15', '')).toBe('ok');
    expect(checkDates('2026-11-03 10:15', '2026-11-02 12:00')).toBe('endBeforeStart');
    expect(checkDates('0202-11-03 10:15', '')).toBe('implausibleYear');
    expect(checkDates('11/7 예정', '')).toBe('unreadable');
  });
});

describe('placeholders', () => {
  it('draws a template placeholder faint and a click selects exactly it', () => {
    const v = view(NOTE, 0);
    const ph = [...v.contentDOM.querySelectorAll<HTMLElement>('.lno-placeholder')];
    expect(ph.map((p) => p.textContent)).toEqual(['(e.g. enzyme, buffer, etc.)', '(method used in this step)']);
    expect(ph[0].closest('.cm-line')!.classList.contains('lno-placeholder-line')).toBe(true);
    ph[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
    const from = at('(e.g. enzyme');
    expect(v.state.selection.main.from).toBe(from);
    expect(v.state.selection.main.to).toBe(from + '(e.g. enzyme, buffer, etc.)'.length);
  });

  it('leaves parentheses outside UO sections alone', () => {
    const v = view(['# Note', '(not a placeholder)', '- (x)'].join('\n'), 0);
    expect(v.contentDOM.querySelectorAll('.lno-placeholder')).toHaveLength(0);
  });
});

describe('source mode and language', () => {
  it('source mode shows none of the cards, chips or placeholders', () => {
    const v = view(NOTE, 0, false);
    for (const sel of ['.cm-uo-card', '.cm-uo-label', '.lno-uo-status', '.lno-date-chip', '.lno-placeholder'])
      expect(v.contentDOM.querySelectorAll(sel)).toHaveLength(0);
  });

  it('English labels', () => {
    setLang('en');
    const v = view(NOTE, 0);
    expect([...v.contentDOM.querySelectorAll('.lno-uo-status')].map((s) => s.textContent)).toEqual(['Done', 'In progress']);
    expect([...v.contentDOM.querySelectorAll('.lno-date-chip')].pop()!.textContent).toBe('Pick a date');
  });
});
