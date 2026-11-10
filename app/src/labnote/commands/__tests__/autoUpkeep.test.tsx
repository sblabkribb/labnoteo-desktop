// @vitest-environment jsdom
import { act } from '@testing-library/react';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { rebuildUnitOpToc } from '@labnoteo/core';
import { getSeoulDateString } from '@labnoteo/core/lib/dateUtils';
import { createFakeVault } from '../../../__tests__/fakeVault';
import type { EditorHandle } from '../../../editor/Editor';
import { TauriLabnoteFs } from '../../../fs/tauriLabnoteFs';
import { setLang } from '../../../i18n/lang';
import { mountEditor } from '../../__tests__/editorHarness';
import { registerOpenNote } from '../../openNotes';
import { ExperimentEntryCache } from '../../panel/experimentEntries';
import { buildExperimentTree, groupExperiments } from '../../panel/experimentTree';
import { syncTocOnSave } from '../../port/lastUpdatedStamp';
import type { AppSettings } from '../../settings';
import { createUpkeep, setAppUpkeep, type Upkeep } from '../autoUpkeep';
import { readmeStamp } from '../stamp';

const TODAY = '2026-11-10';
const EXP = 'labnote/003_E_coli_host';
const README = `${EXP}/README.labnote.md`;
const WF = `${EXP}/002_WT020_Protein_Expression_Measurement_GFP.labnote.md`;

function readme(date = '2026-02-03'): string {
  return ['---', 'title: 대장균 숙주 비교', 'status: in-progress', `last_updated_date: ${date}`, '---', '', '## Summary and Discussion', ''].join('\n');
}

function uo(id: string, name: string, alias: string): string[] {
  return ['---', '', `### [${id} ${name}]${alias ? ` ${alias}` : ''}`, '', '#### Method', '- x', ''];
}

/** 목록이 제목들과 맞는 워크플로 노트(코어 rebuildUnitOpToc 로 만든다). */
function workflow(date = '2026-02-03'): string {
  const uos = [uo('UHW180', 'Incubation', ''), uo('UHW380', 'Microplate Reading', 'plate 1')];
  const raw = [
    '---',
    'title: WT020 GFP',
    `last_updated_date: ${date}`,
    '---',
    '## [WT020 Protein Expression Measurement] GFP',
    '',
    '## Related Unit Operations',
    '',
    ...uos.flat(),
    '## Conclusions and Discussion',
    '',
  ].join('\n');
  return rebuildUnitOpToc(raw);
}

const tocLines = (text: string) => text.split('\n').filter((l) => /^- \[UHW/.test(l));

function setup(files: Record<string, string>, opts: { stamp?: boolean; toc?: boolean } = {}) {
  const vault = createFakeVault(files);
  const fs = new TauriLabnoteFs(vault.invoke);
  const settings = { autoUpdateLastUpdated: opts.stamp ?? true, autoSyncUnitOpToc: opts.toc ?? true };
  const notices: string[] = [];
  const upkeep = createUpkeep({ fs, settings: () => settings, notify: (m) => notices.push(m), today: () => TODAY });
  return { vault, fs, settings, notices, upkeep };
}

/** 편집기 없이 열린 노트 하나: 열린 노트 목록에 등록하고 바뀐 트랜잭션을 upkeep 에 알린다. */
function openView(upkeep: Upkeep, path: string, doc: string) {
  const view = new EditorView({
    state: EditorState.create({ doc, extensions: [EditorView.updateListener.of((u) => u.docChanged && upkeep.observe(path, u))] }),
  });
  const off = registerOpenNote(path, { view: () => view, busy: () => false } as unknown as EditorHandle);
  const type = (text: string, at = view.state.doc.length) => view.dispatch({ changes: { from: at, insert: text }, userEvent: 'input.type' });
  const text = () => view.state.doc.toString();
  const close = () => {
    off();
    view.destroy();
  };
  return { view, type, text, close };
}

async function idle(ms = 2000) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  setLang('en');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => {
  vi.useRealTimers();
  setAppUpkeep(undefined);
  setLang('ko');
});

describe('last_updated_date auto-stamp', () => {
  it('typing in a lab note, then 2 s idle, stamps today; the timer restarts on every change', async () => {
    const { upkeep } = setup({ [README]: readme() });
    const note = openView(upkeep, README, readme());
    note.type('more\n');
    await idle(1900);
    expect(note.text()).toContain('last_updated_date: 2026-02-03');
    note.type('x');
    await idle(1900);
    expect(note.text()).toContain('last_updated_date: 2026-02-03');
    await idle(100);
    expect(note.text()).toContain(`last_updated_date: ${TODAY}`);
    note.close();
  });

  it('a workflow note change also stamps its closed experiment README on disk', async () => {
    const { upkeep, vault } = setup({ [README]: readme(), [WF]: workflow() });
    const note = openView(upkeep, WF, workflow());
    note.type('note\n');
    await idle();
    expect(note.text()).toContain(`last_updated_date: ${TODAY}`);
    expect(vault.files()[README]).toContain(`last_updated_date: ${TODAY}`);
    note.close();
  });

  it('a date set by hand stands, with one notice, against later typing, the workflow stamp and README commands', async () => {
    const { upkeep, vault, notices } = setup({ [README]: readme(), [WF]: workflow() });
    setAppUpkeep(upkeep);
    const rd = openView(upkeep, README, readme());
    const at = rd.text().indexOf('2026-02-03');
    rd.view.dispatch({ changes: { from: at, to: at + 10, insert: '2026-01-15' }, userEvent: 'input.type' });
    await idle();
    expect(rd.text()).toContain('last_updated_date: 2026-01-15');
    expect(notices).toEqual([expect.stringContaining('Kept the last_updated_date you set by hand in README.labnote.md')]);
    rd.type('more\n');
    await idle();
    expect(rd.text()).toContain('last_updated_date: 2026-01-15');
    expect(notices).toHaveLength(1);
    // a command stamping that README by path leaves it too; without a path it stamps
    const stamp = readmeStamp({ autoUpdateLastUpdated: true } as AppSettings);
    expect(stamp(readme('2026-01-15'), README)).toContain('2026-01-15');
    expect(stamp(readme('2026-01-15'))).toContain(getSeoulDateString());
    rd.close();
    // the workflow note's own stamp does not reach that README
    const wf = openView(upkeep, WF, workflow());
    wf.type('x');
    await idle();
    expect(wf.text()).toContain(`last_updated_date: ${TODAY}`);
    expect(vault.files()[README]).toContain('last_updated_date: 2026-02-03');
    wf.close();
  });

  it('switch off: nothing is written', async () => {
    const { upkeep, vault } = setup({ [README]: readme(), [WF]: workflow() }, { stamp: false });
    const note = openView(upkeep, WF, workflow());
    note.type('x');
    await idle(5000);
    expect(note.text()).toContain('last_updated_date: 2026-02-03');
    expect(vault.log.filter((c) => c.cmd === 'vault_modify' || c.cmd === 'vault_write')).toEqual([]);
    note.close();
  });

  it('a reload (no user event) or an undo does not stamp', async () => {
    const { upkeep } = setup({ [README]: readme() });
    const note = openView(upkeep, README, readme());
    note.view.dispatch({ changes: { from: note.view.state.doc.length, insert: 'reloaded\n' } });
    await idle();
    expect(note.text()).toContain('last_updated_date: 2026-02-03');
    note.type('typed');
    note.view.dispatch({ changes: { from: note.view.state.doc.length - 5, to: note.view.state.doc.length }, userEvent: 'undo' });
    await idle();
    expect(note.text()).toContain('last_updated_date: 2026-02-03');
    note.close();
  });

  it('the Experiments "updated" grouping reflects the stamp', async () => {
    const today = getSeoulDateString();
    const vault = createFakeVault({ [README]: readme('2020-01-01'), [WF]: workflow() });
    const fs = new TauriLabnoteFs(vault.invoke);
    const upkeep = createUpkeep({ fs, settings: () => ({ autoUpdateLastUpdated: true, autoSyncUnitOpToc: true }), notify: () => undefined });
    const group = async () => {
      const nodes = await buildExperimentTree(await new ExperimentEntryCache(fs).all(), (p) => fs.read(p));
      return groupExperiments(nodes, 'updated').find((g) => g.items.some((n) => n.dir === EXP))!.key;
    };
    const before = await group();
    const note = openView(upkeep, WF, workflow());
    note.type('x');
    await idle();
    expect(vault.files()[README]).toContain(`last_updated_date: ${today}`);
    const after = await group();
    expect(after).not.toBe(before);
    expect(after).toContain('thisWeek');
    note.close();
  });
});

describe('syncTocOnSave', () => {
  const on = { autoSyncUnitOpToc: true };
  const off = { autoSyncUnitOpToc: false };
  const withoutPlate = (text: string) => text.slice(0, text.indexOf('---\n\n### [UHW380')) + text.slice(text.indexOf('## Conclusions'));

  it('deleting a UO block rebuilds the list without its entry (sorting on or off)', () => {
    const cut = withoutPlate(workflow());
    expect(tocLines(syncTocOnSave(WF, cut, on)!)).toEqual([expect.stringMatching(/^- \[UHW180 Incubation\]/)]);
    expect(tocLines(syncTocOnSave(WF, cut, off)!)).toEqual([expect.stringMatching(/^- \[UHW180 Incubation\]/)]);
  });

  it('renaming an alias updates its entry', () => {
    const text = workflow().replace('### [UHW380 Microplate Reading] plate 1', '### [UHW380 Microplate Reading] plate 2');
    expect(tocLines(syncTocOnSave(WF, text, on)!)[1]).toBe('- [UHW380 Microplate Reading | plate 2](#uhw380-microplate-reading-plate-2)');
    expect(tocLines(syncTocOnSave(WF, text, off)!)[1]).toContain('plate 2');
  });

  it('with autoSyncUnitOpToc off the order the researcher chose is left unchanged', () => {
    const text = workflow();
    const [a, b] = tocLines(text);
    const swapped = text.replace(`${a}\n${b}`, `${b}\n${a}`);
    expect(syncTocOnSave(WF, swapped, off)).toBeNull();
    expect(tocLines(syncTocOnSave(WF, swapped, on)!)).toEqual([a, b]);
  });

  it('an unchanged list, a README, right after an undo, or a caret inside the rewrite: null', () => {
    const text = workflow();
    expect(syncTocOnSave(WF, text, on)).toBeNull();
    const stale = text.replace('### [UHW380 Microplate Reading] plate 1', '### [UHW380 Microplate Reading] plate 9');
    expect(syncTocOnSave(README, stale, on)).toBeNull();
    expect(syncTocOnSave(WF, stale, on, { fromHistory: true })).toBeNull();
    expect(syncTocOnSave(WF, stale, on, { caret: stale.indexOf('plate-1') + 3 })).toBeNull();
    expect(syncTocOnSave(WF, stale, on, { caret: 0 })).not.toBeNull();
  });
});

describe('the editor syncs the list on save', () => {
  it('a deleted UO block leaves no entry once saved; a second save writes nothing', async () => {
    vi.useRealTimers();
    const { vault, upkeep } = setup({ [WF]: workflow() }, { stamp: false });
    const m = mountEditor(vault, WF, { upkeep });
    await m.loaded();
    const text = m.view().state.doc.toString();
    const from = text.indexOf('---\n\n### [UHW380');
    const to = text.indexOf('## Conclusions');
    await act(async () => {
      m.view().dispatch({ changes: { from, to }, selection: { anchor: 0 }, userEvent: 'delete.cut' });
    });
    await act(async () => {
      await m.ref.current!.flush();
    });
    expect(tocLines(vault.files()[WF])).toEqual([expect.stringMatching(/^- \[UHW180 Incubation\]/)]);
    expect(m.view().state.doc.toString()).toBe(vault.files()[WF]);
    expect(m.writes()).toBe(1);
    await act(async () => {
      await m.ref.current!.flush();
    });
    expect(m.writes()).toBe(1);
    m.unmount();
  });

  it('autoSyncUnitOpToc off and a stale order: the save writes the buffer as it is', async () => {
    vi.useRealTimers();
    const text = workflow();
    const [a, b] = tocLines(text);
    const swapped = text.replace(`${a}\n${b}`, `${b}\n${a}`);
    const { vault, upkeep } = setup({ [WF]: swapped }, { stamp: false, toc: false });
    const m = mountEditor(vault, WF, { upkeep });
    await m.loaded();
    await m.type('more\n');
    await act(async () => {
      await m.ref.current!.flush();
    });
    expect(tocLines(vault.files()[WF])).toEqual([b, a]);
    m.unmount();
  });
});
