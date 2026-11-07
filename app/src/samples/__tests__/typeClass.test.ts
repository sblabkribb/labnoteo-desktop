import { describe, expect, it } from 'vitest';
import { editorThemeSpec } from '../../editor/theme';
import { BUILTIN_SAMPLE_CLASS, CUSTOM_SAMPLE_CLASS, sampleTypeClass } from '../typeClass';

describe('sample type classes', () => {
  it('maps built-ins case-sensitively and everything else to custom', () => {
    expect(sampleTypeClass('DNA')).toBe('lno-sample-t-dna');
    expect(sampleTypeClass('Labware')).toBe('lno-sample-t-labware');
    expect(sampleTypeClass('dna')).toBe('lno-sample-t-custom');
    expect(sampleTypeClass('배지')).toBe('lno-sample-t-custom');
    expect(Object.keys(BUILTIN_SAMPLE_CLASS)).toEqual(['DNA', 'RNA', 'Plasmid', 'Reagent', 'Primer', 'Protein', 'Equip', 'Labware', 'Other']);
  });
  it('every class has a theme rule that reads a sample token', () => {
    const spec = JSON.stringify(editorThemeSpec);
    for (const cls of [...Object.values(BUILTIN_SAMPLE_CLASS), CUSTOM_SAMPLE_CLASS]) {
      expect(spec).toContain(`.${cls}`);
      expect(spec).toContain(`var(--sample-${cls.slice('lno-sample-t-'.length)}-bg)`);
    }
    expect(spec).toContain('.lno-sample-id-missing');
    expect(spec).toContain('.lno-sample-alias-stale');
    expect(spec).toContain('.lno-sample-discarded');
    expect(spec).toContain('.lno-sample-option .cm-completionDetail');
    expect(spec).toContain('var(--text-muted)');
    expect(spec).not.toContain('var(--muted)');
  });
});
