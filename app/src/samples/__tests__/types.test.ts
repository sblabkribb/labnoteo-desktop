/**
 * Task 2: 사용자 시료 종류 검사(플러그인 settings.ts 의 포트)와 종류 목록.
 * 위 두 describe 는 app/vendor/labnoteo/tests/plugin/settings.test.ts 에서 그대로 옮겼다(import 만 포트로).
 */
import { describe, it, expect } from 'vitest';
import {
  countSampleRecords,
  partitionCustomSampleTypes,
  removedCustomSampleTypes,
} from '../../labnote/port/customSampleTypes';
import { sampleTypesFor } from '../types';

// #81: the field must not accept a type that `@` autocompletion cannot read.
describe('partitionCustomSampleTypes', () => {
  it('saves letters, digits and _ (Korean included) and rejects spaces and -', () => {
    expect(partitionCustomSampleTypes('Cell Line, Strain-A, 배지, Cell_2', [])).toEqual({
      save: ['배지', 'Cell_2'],
      rejected: [
        { name: 'Cell Line', suggestion: 'Cell_Line' },
        { name: 'Strain-A', suggestion: 'Strain_A' },
      ],
      legacyInvalid: [],
      italic: [],
      legacyItalic: [],
      caseDuplicates: [],
      legacyCaseDuplicates: [],
      caseRenamed: [],
      reserved: [],
      legacyReserved: [],
    });
  });

  // #560: CON.json cannot exist on Windows, and git stops at it.
  it('refuses a name Windows keeps for devices, and keeps one stored before with a warning', () => {
    const out = partitionCustomSampleTypes('CON, aux, COM¹, Console, LPT1x', []);
    expect(out.reserved).toEqual(['CON', 'aux', 'COM¹']);
    expect(out.save).toEqual(['Console', 'LPT1x']);
    const kept = partitionCustomSampleTypes('CON, Strain', ['CON']);
    expect(kept.save).toEqual(['CON', 'Strain']);
    expect(kept.legacyReserved).toEqual(['CON']);
    expect(kept.reserved).toEqual([]);
  });

  // #252: `무세포_용해물` reads as italics in the reading view, so the type no longer matches.
  it('rejects a _ next to a letter that is not A–Z or a digit, and suggests the name joined up', () => {
    const out = partitionCustomSampleTypes('무세포_용해물, Cell_Line, 배지_2', []);
    expect(out.save).toEqual(['Cell_Line']);
    expect(out.italic).toEqual([
      { name: '무세포_용해물', suggestion: '무세포용해물' },
      { name: '배지_2', suggestion: '배지2' },
    ]);
    expect(out.rejected).toEqual([]);
  });

  it('keeps such a name stored by an older release and only warns about it', () => {
    const out = partitionCustomSampleTypes('무세포_용해물', ['무세포_용해물']);
    expect(out.save).toEqual(['무세포_용해물']);
    expect(out.legacyItalic).toEqual(['무세포_용해물']);
    expect(out.italic).toEqual([]);
  });

  it('rejects the autocomplete keywords sample and item', () => {
    expect(partitionCustomSampleTypes('Sample, item', []).save).toEqual([]);
  });

  it('keeps an invalid name stored by an older release, so its samples stay linked', () => {
    const out = partitionCustomSampleTypes('Cell Line, Strain-A', ['Cell Line']);
    expect(out.save).toEqual(['Cell Line']);
    expect(out.legacyInvalid).toEqual(['Cell Line']);
    expect(out.rejected.map(r => r.name)).toEqual(['Strain-A']);
  });

  // #222: Windows opens dna.json and DNA.json as one file.
  it('rejects a name that differs from a built-in or an earlier type only in case', () => {
    const out = partitionCustomSampleTypes('Strain, dna, strain, 배지', []);
    expect(out.save).toEqual(['Strain', '배지']);
    expect(out.caseDuplicates).toEqual([
      { name: 'dna', clashesWith: 'DNA' },
      { name: 'strain', clashesWith: 'Strain' },
    ]);
  });

  it('keeps a case duplicate stored before, so its samples stay linked, and reports it', () => {
    const out = partitionCustomSampleTypes('Strain, dna, strain', ['Strain', 'dna', 'strain']);
    expect(out.save).toEqual(['Strain', 'dna', 'strain']);
    expect(out.caseDuplicates).toEqual([]);
    expect(out.legacyCaseDuplicates).toEqual([
      { name: 'dna', clashesWith: 'DNA' },
      { name: 'strain', clashesWith: 'Strain' },
    ]);
  });

  // #497: CellLine → cellline left the ids already written as CellLine-… unmarked.
  it('keeps the stored spelling of a type typed again in another case', () => {
    const out = partitionCustomSampleTypes('cellline, Strain, CELLLINE', ['CellLine']);
    expect(out.save).toEqual(['CellLine', 'Strain']);
    expect(out.caseRenamed).toEqual([
      { name: 'cellline', stored: 'CellLine' },
      { name: 'CELLLINE', stored: 'CellLine' },
    ]);
    expect(out.caseDuplicates).toEqual([]);
    expect(partitionCustomSampleTypes('CellLine', ['CellLine']).caseRenamed).toEqual([]);
  });
});

// #137: samples of a type taken out of the list stop showing.
describe('removedCustomSampleTypes / countSampleRecords', () => {
  it('lists the types the new list dropped', () => {
    expect(removedCustomSampleTypes(['CellLine', 'Strain', '배지'], ['Strain'])).toEqual(['CellLine', '배지']);
    expect(removedCustomSampleTypes(['CellLine'], ['CellLine', 'Media'])).toEqual([]);
  });

  it('ignores a change of case and built-in names, which still show', () => {
    expect(removedCustomSampleTypes(['CellLine', 'dna'], ['cellline'])).toEqual([]);
  });

  it('counts the samples in the type files, skipping empty and broken ones', () => {
    const json = JSON.stringify({ 'CellLine-1': { alias: 'HeLa' }, 'CellLine-2': { alias: null } });
    expect(countSampleRecords([json, JSON.stringify({ 'CellLine-3': {} }), '', '{broken', '[]'])).toBe(3);
    expect(countSampleRecords([])).toBe(0);
  });
});

describe('sampleTypesFor', () => {
  it('partitions like the plugin settings tab (vendor settings.test.ts:20-33)', () => {
    expect(partitionCustomSampleTypes('Cell Line, Strain-A, 배지, Cell_2', [])).toEqual({
      save: ['배지', 'Cell_2'],
      rejected: [{ name: 'Cell Line', suggestion: 'Cell_Line' }, { name: 'Strain-A', suggestion: 'Strain_A' }],
      legacyInvalid: [], italic: [], legacyItalic: [], caseDuplicates: [], legacyCaseDuplicates: [], caseRenamed: [], reserved: [], legacyReserved: [],
    });
  });
  it('a case duplicate of a built-in is reported', () => {
    expect(partitionCustomSampleTypes('Dna', []).caseDuplicates).toEqual([{ name: 'Dna', clashesWith: 'DNA' }]);
  });
  it('type list = built-ins then every stored custom name, legacy-invalid ones included', () => {
    expect(sampleTypesFor({ customSampleTypes: ['배지'] })).toEqual(['DNA', 'RNA', 'Plasmid', 'Reagent', 'Primer', 'Protein', 'Equip', 'Labware', 'Other', '배지']);
    expect(sampleTypesFor({ customSampleTypes: ['Cell-Line'] }).at(-1)).toBe('Cell-Line');
    expect(sampleTypesFor({ customSampleTypes: [] })).toHaveLength(9);
  });
  it('is memoised on array identity', () => {
    const custom = ['배지'];
    expect(sampleTypesFor({ customSampleTypes: custom })).toBe(sampleTypesFor({ customSampleTypes: custom }));
    expect(sampleTypesFor({ customSampleTypes: ['배지'] })).not.toBe(sampleTypesFor({ customSampleTypes: custom }));
  });
});
