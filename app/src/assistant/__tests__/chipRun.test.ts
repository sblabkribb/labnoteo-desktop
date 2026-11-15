import { buildChipRun } from '../chipRun';

const folder = 'labnote/001_A';

describe('buildChipRun (the run both the panel and the desktop pet send)', () => {
  it('section: an existing section under a parent', () => {
    expect(buildChipRun('section', { text: ' more ', section: { heading: 'Plan', parentHeading: 'UO1', existing: true }, notePath: `${folder}/001_wf.md`, folder })).toEqual({
      chip: 'section',
      params: { documentPath: `${folder}/001_wf.md`, heading: 'Plan', parentHeading: 'UO1', existing: 'yes' },
      line: 'Plan — more',
      text: 'more',
    });
  });
  it('section: a new section after another, with no extra text, falls back to the open note', () => {
    expect(buildChipRun('section', { text: '', section: { heading: 'Notes', existing: false, after: 'Methods' }, activePath: `${folder}/README.md`, folder })).toEqual({
      chip: 'section',
      params: { documentPath: `${folder}/README.md`, heading: 'Notes', after: 'Methods', existing: 'no' },
      line: 'Notes',
      text: '',
    });
  });
  it('section: nothing picked is nothing to run', () => {
    expect(buildChipRun('section', { text: 'x', section: null, folder })).toBeNull();
  });
  it('unit operation needs a target and text', () => {
    expect(buildChipRun('unitOp', { text: 'add PCR cleanup', unitOpTarget: `${folder}/001_wf.md`, folder })).toEqual({
      chip: 'unitOp', params: { documentPath: `${folder}/001_wf.md` }, line: 'add PCR cleanup', text: 'add PCR cleanup',
    });
    expect(buildChipRun('unitOp', { text: 'x', folder })).toBeNull();
    expect(buildChipRun('unitOp', { text: ' ', unitOpTarget: 'a.md', folder })).toBeNull();
  });
  it('workflow needs text and points at the open note, else the experiment folder', () => {
    expect(buildChipRun('workflow', { text: 'cloning', activePath: `${folder}/README.md`, folder })?.params).toEqual({ documentPath: `${folder}/README.md` });
    expect(buildChipRun('workflow', { text: 'cloning', folder })?.params).toEqual({ documentPath: folder });
    expect(buildChipRun('workflow', { text: '', folder })).toBeNull();
  });
  it('how-to and chat are not creating chips', () => {
    expect(buildChipRun('howTo', { text: 'x', folder })).toBeNull();
    expect(buildChipRun('chat', { text: 'x', folder })).toBeNull();
  });
});
