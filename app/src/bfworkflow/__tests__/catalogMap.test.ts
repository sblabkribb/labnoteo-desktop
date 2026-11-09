import { describe, expect, it } from 'vitest';
import {
  categoryFor,
  isCatalogId,
  mapUoCatalog,
  mapWorkflowCatalog,
  mergeById,
  serverCatalogHash,
} from '../catalogMap';

const WF_ROWS = [
  { workflow_id: 'WB030', name: 'PCR', domain: 'build', description: 'Amplify', paper_count: 3, variant_count: 1, updated_at: '2026-10-01', image_url: '/x.svg' },
  { workflow_id: 'WT010', name: 'Assay', domain: '', description: '' },
  { workflow_id: 'X1', name: 'Odd', domain: 'other' },
  { workflow_id: '../../evil', name: 'Bad', domain: 'build' },
  { name: 'No id', domain: 'build' },
];

describe('bfworkflow catalog mapping', () => {
  it('workflow rows use workflow_id and drop the extra fields', () => {
    expect(mapWorkflowCatalog(WF_ROWS)).toEqual({
      workflows: [
        { id: 'WB030', name: 'PCR', description: 'Amplify', category: 'Build' },
        { id: 'WT010', name: 'Assay', description: '', category: 'Test' },
      ],
      skipped: ['X1', '../../evil', '?'],
    });
  });

  it('a non-array workflow response maps to nothing', () => {
    expect(mapWorkflowCatalog({ workflows: WF_ROWS })).toEqual({ workflows: [], skipped: [] });
    expect(mapWorkflowCatalog(null)).toEqual({ workflows: [], skipped: [] });
  });

  it('a row without a string name is skipped by its id', () => {
    expect(mapWorkflowCatalog([{ workflow_id: 'WD001', name: 5, domain: 'design' }, 'junk'])).toEqual({
      workflows: [],
      skipped: ['WD001', '?'],
    });
  });

  it('domain maps to the bundled category, else the id prefix', () => {
    expect(categoryFor('WB030', 'build')).toBe('Build');
    expect(categoryFor('WD001', 'DESIGN')).toBe('Design');
    expect(categoryFor('WB030', 'learn')).toBe('Learn');
    expect(categoryFor('WT010', 'Unknown')).toBe('Test');
    expect(categoryFor('WL002', undefined)).toBe('Learn');
    expect(categoryFor('X1', '')).toBeUndefined();
  });

  it('uo json is an object keyed by code and splits hardware and software', () => {
    const r = mapUoCatalog({
      unit_operations: {
        UHW010: { id: 'UHW010', name: 'Thermocycler run', type: 'hardware', description: '', equipment: 'Thermocycler', config_fields: [], image_url: '' },
        USW005: { id: 'USW005', name: 'Primer design', type: 'software', description: 'd', software: ['Benchling', 'Primer3'] },
        UHW020: { name: 'Pipetting', equipment: null }, // file fallback: no id, no type
        USW007: { name: 'Analysis', software: 'R' }, // no type, software key
        'a/b': { id: 'a/b', name: 'Bad' },
      },
    });
    expect(r.hw).toEqual([
      { id: 'UHW010', name: 'Thermocycler run', description: '', equipment: 'Thermocycler' },
      { id: 'UHW020', name: 'Pipetting', description: '', equipment: '' },
    ]);
    expect(r.sw).toEqual([
      { id: 'USW005', name: 'Primer design', description: 'd', software: 'Benchling, Primer3' },
      { id: 'USW007', name: 'Analysis', description: '', software: 'R' },
    ]);
    expect(r.skipped).toEqual(['a/b']);
  });

  it('a uo entry with a USW prefix and no type or software key is software', () => {
    const r = mapUoCatalog({ unit_operations: { USW009: { name: 'Script' }, UHW030: { name: 'Spin', type: 'other' } } });
    expect(r.sw).toEqual([{ id: 'USW009', name: 'Script', description: '', software: '' }]);
    expect(r.hw).toEqual([{ id: 'UHW030', name: 'Spin', description: '', equipment: '' }]);
  });

  it('a missing or odd uo json maps to nothing', () => {
    for (const v of [null, undefined, 3, {}, { unit_operations: [] }, { unit_operations: 'x' }]) {
      expect(mapUoCatalog(v)).toEqual({ hw: [], sw: [], skipped: [] });
    }
  });

  it('isCatalogId refuses paths and odd ids', () => {
    for (const v of ['WB030', 'WD1001']) expect(isCatalogId(v, 'workflow')).toBe(true);
    for (const v of ['x/../WB030', 'WB03', 'WB030\n', '', 3]) expect(isCatalogId(v, 'workflow')).toBe(false);
    for (const v of ['UHW010', 'USW1234']) expect(isCatalogId(v, 'uo')).toBe(true);
    for (const v of ['UXW010', 'UHW01', 'WB030', '../UHW010', null]) expect(isCatalogId(v, 'uo')).toBe(false);
    expect(isCatalogId('UHW010', 'workflow')).toBe(false);
  });

  it('name and description lose control characters and are cut to 200 and 2000 chars', () => {
    const { workflows } = mapWorkflowCatalog([
      { workflow_id: 'WB001', name: 'a\u0000b\u0007' + 'n'.repeat(300), domain: 'build', description: 'x\u001by'.padEnd(3000, 'd') },
    ]);
    const wf = workflows[0]!;
    expect(wf.name.startsWith('ab')).toBe(true);
    expect(wf.name).toHaveLength(200);
    expect(wf.description.startsWith('xy')).toBe(true);
    expect(wf.description).toHaveLength(2000);
    expect(/[\u0000-\u001f\u007f]/.test(wf.name + wf.description)).toBe(false);
  });

  it('merge: server wins, vault-only kept, sorted', () => {
    const r = mergeById([{ id: 'A', name: 'old' }, { id: 'Z', name: 'lab' }], [{ id: 'A', name: 'new' }, { id: 'B', name: 'b' }]);
    expect(r).toEqual({
      merged: [{ id: 'A', name: 'new' }, { id: 'B', name: 'b' }, { id: 'Z', name: 'lab' }],
      added: 1,
      changed: 1,
      kept: 1,
    });
  });

  it('merge: an identical same-id entry is neither added nor changed', () => {
    const r = mergeById([{ id: 'A', name: 'x' }], [{ name: 'x', id: 'A' }]);
    expect(r).toEqual({ merged: [{ name: 'x', id: 'A' }], added: 0, changed: 0, kept: 0 });
  });

  it('the hash ignores row order', () => {
    const a = { id: 'WB030', name: 'PCR', description: '', category: 'Build' as const };
    const b = { id: 'WT010', name: 'Assay', description: '', category: 'Test' as const };
    const h1 = { id: 'UHW010', name: 'Run', description: '', equipment: 'T' };
    const h2 = { id: 'UHW020', name: 'Pip', description: '', equipment: '' };
    const s1 = { id: 'USW005', name: 'Primer', description: '', software: 'R' };
    const one = serverCatalogHash({ workflows: [a, b], hw: [h1, h2], sw: [s1] });
    const two = serverCatalogHash({ workflows: [b, a], hw: [h2, h1], sw: [s1] });
    expect(one).toBe(two);
    expect(typeof one).toBe('string');
    expect(serverCatalogHash({ workflows: [a, { ...b, name: 'Assay 2' }], hw: [h1, h2], sw: [s1] })).not.toBe(one);
  });
});
