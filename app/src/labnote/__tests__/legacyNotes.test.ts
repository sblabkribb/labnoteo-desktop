import { planLegacyLabnoteRenames } from '../legacyNotes';

describe('planLegacyLabnoteRenames', () => {
  it('renames README.md and ###_*.md directly inside labnote/###_*/ to .labnote.md', () => {
    const plan = planLegacyLabnoteRenames([
      'labnote/001_GFP/README.md',
      'labnote/001_GFP/001_WB010_Transform.md',
      'labnote/002_PCR/README.md',
      'labnote/002_PCR/002_WB010_x.md',
    ]);
    expect(plan.renames).toEqual([
      { from: 'labnote/001_GFP/001_WB010_Transform.md', to: 'labnote/001_GFP/001_WB010_Transform.labnote.md' },
      { from: 'labnote/001_GFP/README.md', to: 'labnote/001_GFP/README.labnote.md' },
      { from: 'labnote/002_PCR/002_WB010_x.md', to: 'labnote/002_PCR/002_WB010_x.labnote.md' },
      { from: 'labnote/002_PCR/README.md', to: 'labnote/002_PCR/README.labnote.md' },
    ]);
    expect(plan.conflicts).toEqual([]);
  });

  it('keeps Korean names, and an uppercase README.MD or .MD extension becomes README.labnote.md / stem.labnote.md', () => {
    const plan = planLegacyLabnoteRenames([
      'labnote/003_형광단백질/README.MD',
      'labnote/003_형광단백질/001_WB010_형질전환.md',
      'labnote/003_형광단백질/002_WD020_정제.MD',
      'labnote/003_형광단백질/Readme.md',
    ]);
    expect(plan.renames).toEqual([
      { from: 'labnote/003_형광단백질/001_WB010_형질전환.md', to: 'labnote/003_형광단백질/001_WB010_형질전환.labnote.md' },
      { from: 'labnote/003_형광단백질/002_WD020_정제.MD', to: 'labnote/003_형광단백질/002_WD020_정제.labnote.md' },
      { from: 'labnote/003_형광단백질/README.MD', to: 'labnote/003_형광단백질/README.labnote.md' },
    ]);
    // the second spelling of the same README is the same target: a conflict, not a second rename
    expect(plan.conflicts).toEqual([{ from: 'labnote/003_형광단백질/Readme.md', to: 'labnote/003_형광단백질/README.labnote.md' }]);
  });

  it('leaves already-converted notes alone', () => {
    const plan = planLegacyLabnoteRenames([
      'labnote/001_A/README.labnote.md',
      'labnote/001_A/001_WB010_x.labnote.md',
      'labnote/001_A/002_WB010_y.LABNOTE.MD',
    ]);
    expect(plan).toEqual({ renames: [], conflicts: [] });
  });

  it('a target that already exists (case-insensitive) is a conflict, not a rename', () => {
    const plan = planLegacyLabnoteRenames([
      'labnote/001_A/README.md',
      'labnote/001_A/readme.LABNOTE.md',
      'labnote/001_A/002_WB010_x.md',
      'labnote/001_A/002_wb010_X.labnote.md',
      'labnote/001_A/003_WB010_z.md',
    ]);
    expect(plan.renames).toEqual([{ from: 'labnote/001_A/003_WB010_z.md', to: 'labnote/001_A/003_WB010_z.labnote.md' }]);
    expect(plan.conflicts).toEqual([
      { from: 'labnote/001_A/002_WB010_x.md', to: 'labnote/001_A/002_WB010_x.labnote.md' },
      { from: 'labnote/001_A/README.md', to: 'labnote/001_A/README.labnote.md' },
    ]);
  });

  it('never touches files outside labnote/###_*/, in resources/, images/ or nested folders', () => {
    const plan = planLegacyLabnoteRenames([
      'README.md',
      'notes/001_x.md',
      'labnote/README.md',
      'labnote/001_x.md',
      'labnote/Experiment/README.md',
      'labnote/Experiment/001_x.md',
      'labnote/01_short/README.md',
      'labnote/001_A/resources/README.md',
      'labnote/001_A/resources/001_x.md',
      'labnote/001_A/images/001_x.md',
      'labnote/001_A/sub/002_y.md',
      'labnote/001_A/002_B/README.md',
      'labnote/001_A/notes.md',
      'labnote/001_A/001_.md',
      'labnote/001_A/1_x.md',
      'labnote/001_A/001_x.txt',
      'other/labnotes/001_A/README.md',
    ]);
    expect(plan).toEqual({ renames: [], conflicts: [] });
  });

  it('the labnote folder may sit at any depth and its name is matched case-insensitively', () => {
    const plan = planLegacyLabnoteRenames(['projects/Lab A/LabNote/010_X/README.md', 'deep/a/b/labnote/011_Y/011_WB010_q.md']);
    expect(plan.renames).toEqual([
      { from: 'deep/a/b/labnote/011_Y/011_WB010_q.md', to: 'deep/a/b/labnote/011_Y/011_WB010_q.labnote.md' },
      { from: 'projects/Lab A/LabNote/010_X/README.md', to: 'projects/Lab A/LabNote/010_X/README.labnote.md' },
    ]);
  });

  it('accepts backslash paths and returns them with forward slashes', () => {
    const plan = planLegacyLabnoteRenames(['labnote\\001_A\\README.md']);
    expect(plan.renames).toEqual([{ from: 'labnote/001_A/README.md', to: 'labnote/001_A/README.labnote.md' }]);
  });
});
