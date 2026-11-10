/**
 * Task 8: 샘플 강조 범위(플러그인 sampleHighlight.ts 의 샘플 검사 포트).
 * 위 describe 는 계획의 경우들, 아래 describe 들은 app/vendor/labnoteo/tests/plugin/sampleHighlight.test.ts 의
 * 샘플(@issue 가 아닌) 경우를 옮긴 것이다. 색은 인라인 스타일 대신 종류 클래스로, 클래스 이름은 lno-* 로 바뀌었다.
 */
import { describe, it, expect } from 'vitest';
import { findDefinedSampleIds } from '@labnoteo/core/lib/sampleStorage';
import {
  collectTokenRanges,
  discardedSampleCheck,
  missingSampleCheck,
  sampleTokenRanges,
  staleAliasCheck,
  type SampleHighlightInput,
} from '../../labnote/port/sampleHighlightRanges';
import { sampleTypesFor } from '../types';
import { definitionSyntax } from '../highlight';
import { KNOWN } from './fixtures';

const types = sampleTypesFor({ customSampleTypes: ['배지'] });
const titles = { missing: 'MISSING', stale: (a: string) => `STALE ${a}`, discarded: (d: string) => `GONE ${d}` };
const input = (over: Partial<SampleHighlightInput> = {}): SampleHighlightInput => ({
  types,
  known: KNOWN,
  defined: new Set(),
  titles,
  ...over,
});

describe('sampleTokenRanges', () => {
  it('colours, missing, stale and discarded', () => {
    const r = sampleTokenRanges('DNA-1;pUC DNA-9 DNA-1;old Reagent-7 배지-3', input());
    expect(r.map((x) => [x.cls, x.title])).toEqual([
      ['lno-sample-id lno-sample-t-dna', undefined],
      ['lno-sample-id lno-sample-t-dna lno-sample-id-missing', 'MISSING'],
      ['lno-sample-id lno-sample-t-dna lno-sample-alias-stale', 'STALE pUC'],
      ['lno-sample-id lno-sample-t-reagent lno-sample-discarded', 'GONE 2026-10-01'],
      ['lno-sample-id lno-sample-t-custom lno-sample-id-missing', 'MISSING'],
    ]);
  });

  it('unknown registry marks nothing missing', () => {
    expect(sampleTokenRanges('DNA-9', input({ known: undefined }))).toEqual([
      { from: 0, to: 5, cls: 'lno-sample-id lno-sample-t-dna' },
    ]);
  });

  it('unknown registry marks nothing stale or discarded either', () => {
    expect(sampleTokenRanges('DNA-1;old Reagent-7', input({ known: undefined })).map((x) => x.cls)).toEqual([
      'lno-sample-id lno-sample-t-dna',
      'lno-sample-id lno-sample-t-reagent',
    ]);
  });

  it('IDs defined anywhere in the note are known, even off screen', () => {
    // only the visible slice 'DNA-5' is scanned; the definition lives elsewhere in the doc
    expect(sampleTokenRanges('DNA-5', input({ defined: new Set(['dna-5']) }))[0].cls).toBe(
      'lno-sample-id lno-sample-t-dna',
    );
  });

  it('sample IDs in code are marked, as in the plugin', () => {
    const r = sampleTokenRanges('`DNA-1`\n```\nDNA-9\n```\n', input());
    expect(r.map((x) => x.cls)).toEqual([
      'lno-sample-id lno-sample-t-dna',
      'lno-sample-id lno-sample-t-dna lno-sample-id-missing',
    ]);
  });

  it('offset shifts positions', () => {
    expect(sampleTokenRanges('DNA-1', input(), 10)[0].from).toBe(10);
    expect(sampleTokenRanges('DNA-1', input(), 10)[0].to).toBe(15);
  });

  it('the stale mark covers the written alias and never overlaps the next mark', () => {
    const text = 'DNA-1;DNA-9 x';
    const r = sampleTokenRanges(text, input());
    expect(r.map((x) => text.slice(x.from, x.to))).toEqual(['DNA-1;DNA-9']);
    expect(r[0].cls).toBe('lno-sample-id lno-sample-t-dna lno-sample-alias-stale');
  });

  it('no range carries a colour or style', () => {
    for (const r of sampleTokenRanges('DNA-1 DNA-9 Reagent-7 배지-3', input())) {
      expect(Object.keys(r).sort()).toEqual(r.title === undefined ? ['cls', 'from', 'to'] : ['cls', 'from', 'title', 'to']);
    }
  });
});

// vendor tests/plugin/sampleHighlight.test.ts — #210: a sample ID the note cannot resolve is underlined with a tooltip.
describe('sample IDs missing from the registry', () => {
  const types = ['DNA', 'RNA'];
  const TITLE = 'Not in the sample registry';
  const marked = (text: string, knownIds?: string[]) => {
    const state = { types, knownIds: knownIds && new Set(knownIds), missingTitle: TITLE };
    const missing = missingSampleCheck(state, findDefinedSampleIds(text, types));
    return collectTokenRanges(text, types, { missing })
      .filter((r) => r.cls.includes('lno-sample-id-missing'))
      .map((r) => ({ id: text.slice(r.start, r.end), title: r.title }));
  };

  it('marks nothing before the registries are read', () => {
    expect(marked('DNA-1 RNA-2')).toEqual([]);
  });

  it('marks only the IDs the registries do not have, ignoring case', () => {
    expect(marked('DNA-1 DNA-55 RNA-2', ['dna-1', 'dna-55'])).toEqual([{ id: 'RNA-2', title: TITLE }]);
  });

  it('counts the IDs the note itself defines, with @type; or @type:', () => {
    expect(marked('@dna;DNA-7;new\nDNA-7 again\n@rna:RNA-8\nDNA-9', [])).toEqual([{ id: 'DNA-9', title: TITLE }]);
  });
});

// #239: a reference whose alias was edited in the note no longer matches the registry.
describe('sample references with another alias than the registry', () => {
  const types = ['Strain', 'DNA'];
  const ID = 'Strain-1792600000001';
  const aliases = new Map([
    [ID.toLowerCase(), 'COL-001'],
    ['dna-2', ''],
  ]);
  const ranges = (text: string) => {
    const state = {
      types,
      knownIds: new Set(aliases.keys()),
      knownAliases: aliases,
      staleAliasTitle: (a: string) => `registry: ${a}`,
    };
    const staleAlias = staleAliasCheck(state, findDefinedSampleIds(text, types));
    return collectTokenRanges(text, types, { staleAlias }).map((r) => ({
      text: text.slice(r.start, r.end),
      stale: r.cls.includes('lno-sample-alias-stale'),
      title: r.title,
    }));
  };

  it('marks the ID and the alias written in the note, naming the registry alias', () => {
    expect(ranges(`PI 검토: 사용한 집락 ${ID};COL-001b 확인`)).toEqual([
      { text: `${ID};COL-001b`, stale: true, title: 'registry: COL-001' },
    ]);
    expect(ranges(`재확인한 집락: ${ID};집락B`)[0]).toMatchObject({ text: `${ID};집락B`, stale: true });
  });

  it('leaves a matching alias, a bare ID and a sample without an alias alone', () => {
    expect(ranges(`${ID};COL-001 was picked, ${ID}. | ${ID};COL-001 |`).every((r) => !r.stale)).toBe(true);
    expect(ranges('DNA-2;pUC19').every((r) => !r.stale)).toBe(true);
  });

  it('leaves a sample the note defines, whose alias the sync writes to the registry', () => {
    expect(ranges(`@strain;${ID};COL-002\n${ID};COL-002`).every((r) => !r.stale)).toBe(true);
  });

  it('keeps the marks apart when the alias runs into another ID', () => {
    expect(ranges(`${ID};DNA-2`)).toEqual([{ text: `${ID};DNA-2`, stale: true, title: 'registry: COL-001' }]);
  });
});

// #329: reading view ends the text before the link an older alias holds.
describe('a registry alias the reading view cut short', () => {
  const types = ['Reagent'];
  const ID = 'Reagent-1792868825877';
  const state = {
    types,
    knownIds: new Set([ID.toLowerCase()]),
    knownAliases: new Map([[ID.toLowerCase(), '표준 [트롤록스](1mM)']]),
    staleAliasTitle: (a: string) => `registry: ${a}`,
  };
  const staleAlias = staleAliasCheck(state, new Set());

  it('takes the start of the registry alias for the alias when the text was cut', () => {
    const text = `- ${ID};표준 `;
    expect(collectTokenRanges(text, types, { staleAlias, cut: true })[0].cls).toBe('lno-sample-id lno-sample-t-reagent');
    expect(collectTokenRanges(text, types, { staleAlias })[0].cls).toContain('lno-sample-alias-stale');
  });
});

// #330: a reference to a discarded sample looked like any other.
describe('references to a discarded sample', () => {
  const types = ['Other'];
  const state = {
    types,
    knownIds: new Set(['other-1', 'other-2']),
    knownAliases: new Map([
      ['other-1', 'SUP-08'],
      ['other-2', ''],
    ]),
    staleAliasTitle: (a: string) => `registry: ${a}`,
    discardedIds: new Map([['other-1', '2026-10-25']]),
    discardedTitle: (d: string) => `discarded: ${d}`,
  };
  const ranges = (text: string) =>
    collectTokenRanges(text, types, {
      staleAlias: staleAliasCheck(state, new Set()),
      discarded: discardedSampleCheck(state),
    }).map((r) => ({ text: text.slice(r.start, r.end), cls: r.cls, title: r.title }));

  it('fades the discarded one with its date, also next to a stale alias', () => {
    expect(ranges('Other-1;SUP-08 Other-2')).toEqual([
      {
        text: 'Other-1',
        cls: 'lno-sample-id lno-sample-t-other lno-sample-discarded',
        title: 'discarded: 2026-10-25',
      },
      { text: 'Other-2', cls: 'lno-sample-id lno-sample-t-other', title: undefined },
    ]);
    expect(ranges('Other-1;SUP-09')[0]).toEqual({
      text: 'Other-1;SUP-09',
      cls: 'lno-sample-id lno-sample-t-other lno-sample-alias-stale lno-sample-discarded',
      title: 'discarded: 2026-10-25\nregistry: SUP-08',
    });
  });
});

// #266 (sample part): sample IDs in a comment are still styled.
describe('sample IDs in comments', () => {
  it('still styles sample IDs in a comment', () => {
    const text = '<!-- DNA-1 -->';
    expect(collectTokenRanges(text, ['DNA']).map((r) => text.slice(r.start, r.end))).toEqual(['DNA-1']);
  });
});

describe('definitionSyntax (the dimmed @type; and ; around a defined ID)', () => {
  it('marks @type; before the ID, the ; after it and the ; that ends the alias', () => {
    const text = '- @dna;DNA-2;GFP-amplicon;PCR product';
    const id = text.indexOf('DNA-2');
    const ranges = definitionSyntax(text, id, id + 'DNA-2'.length).map(([a, b]) => text.slice(a, b));
    expect(ranges).toEqual(['@dna;', ';', ';']);
  });

  it('a plain reference (no @type; before it) has no syntax to dim', () => {
    const text = 'used DNA-2 here';
    const id = text.indexOf('DNA-2');
    expect(definitionSyntax(text, id, id + 5)).toEqual([]);
  });

  it('stays on the ID line', () => {
    const text = '@primer;P-1\nnext;line';
    const id = text.indexOf('P-1');
    expect(definitionSyntax(text, id, id + 3).map(([a, b]) => text.slice(a, b))).toEqual(['@primer;']);
  });
});
