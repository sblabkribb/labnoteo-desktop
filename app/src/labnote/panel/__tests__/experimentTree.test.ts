import { createFakeVault } from '../../../__tests__/fakeVault';
import { TauriLabnoteFs } from '../../../fs/tauriLabnoteFs';
import { setLang } from '../../../i18n/lang';
import { ExperimentEntryCache } from '../experimentEntries';
import { buildExperimentTree, coreEntryMatcher, experimentNodes, filterTree, groupExperiments, workflowState, type ExpNode } from '../experimentTree';
import { DONE, EXP, expReadme, experimentVault, PLAN, WF1, WF2, WF3 } from './experimentFixtures';

async function load(files = experimentVault()): Promise<ExpNode[]> {
  const fs = new TauriLabnoteFs(createFakeVault(files).invoke);
  const entries = await new ExperimentEntryCache(fs).all();
  return buildExperimentTree(entries, (p) => fs.read(p));
}

beforeEach(() => setLang('ko'));
afterEach(() => setLang('ko'));

describe('buildExperimentTree', () => {
  it('three workflows in prefix order, UO rows with code and alias, ticked from the checklist, done from End_date', async () => {
    const nodes = await load();
    const exp = nodes.find((n) => n.dir === EXP)!;
    expect(exp).toMatchObject({ num: '003', title: '대장균 숙주 비교', status: 'in-progress', project: '단백질 발현', experimenter: '한서연', readme: `${EXP}/README.labnote.md` });
    expect(exp.workflows.map((w) => [w.path, w.code, w.alias, w.ticked])).toEqual([
      [WF1, 'WB030', 'Gibson run', true],
      [WF2, 'WT020', 'GFP', false],
      [WF3, 'WD010', 'Design', false],
    ]);
    expect(exp.workflows[1].uos.map((u) => [u.code, u.alias, u.done])).toEqual([
      ['UHW180', 'Incubation', true],
      ['UHW380', 'plate 1', false],
    ]);
    expect(exp.workflows[0].uos[0]).toMatchObject({ code: 'UHW250', alias: 'Gibson', done: true });
    expect(exp.workflows.map(workflowState)).toEqual(['ticked', 'partial', 'none']);
  });

  it('a workflow ticked in the README with unfinished UOs is tickedOpen, not a plain check', () => {
    const uo = (done: boolean, line: number) => ({ kind: 'uo' as const, id: `uo:${line}`, code: 'UHW100', alias: 'a', name: 'a', line, done });
    const wf = { kind: 'workflow' as const, id: 'wf', path: 'p', code: 'WB150', alias: 'x', name: 'x', ticked: true, uos: [uo(false, 3), uo(false, 9)] };
    expect(workflowState(wf)).toBe('tickedOpen');
    expect(workflowState({ ...wf, uos: [uo(true, 3), uo(true, 9)] })).toBe('ticked');
    expect(workflowState({ ...wf, uos: [] })).toBe('ticked');
  });

  it('counts images and resources, leaving out the system folders', async () => {
    const nodes = await load();
    const exp = nodes.find((n) => n.dir === EXP)!;
    expect(exp.images).toBe(2);
    expect(exp.resources).toBe(1);
    const plan = nodes.find((n) => n.dir === PLAN)!;
    expect(plan.images).toBeUndefined();
    expect(plan.resources).toBeUndefined();
  });

  it('without the note text a workflow is named from its file and has no UOs', async () => {
    const fs = new TauriLabnoteFs(createFakeVault(experimentVault()).invoke);
    const entries = await new ExperimentEntryCache(fs).all();
    const exp = experimentNodes(entries).find((n) => n.dir === EXP)!;
    expect(exp.workflows[0]).toMatchObject({ code: 'WB030', alias: 'DNA Assembly Gibson run', uos: [] });
  });
});

describe('groupExperiments', () => {
  it('status groups run In progress, Planned, Done with localised names', async () => {
    const nodes = await load();
    const groups = groupExperiments(nodes, 'status');
    expect(groups.map((g) => [g.label, g.items.map((n) => n.dir)])).toEqual([
      ['진행 중', [EXP]],
      ['계획', [PLAN]],
      ['완료', [DONE]],
    ]);
    setLang('en');
    expect(groupExperiments(nodes, 'status').map((g) => g.label)).toEqual(['In progress', 'Planned', 'Done']);
  });

  it('other groupings come from the core model without the bracket count', async () => {
    const nodes = await load();
    const groups = groupExperiments(nodes, 'experimenter');
    expect(groups.map((g) => [g.label, g.items.length])).toEqual([['한서연', 3]]);
  });
});

describe('filterTree', () => {
  it("'Gibson' reveals the UO row and expands its ancestors, with a mark range", async () => {
    const nodes = await load();
    const r = filterTree(nodes, 'Gibson');
    expect(r.nodes.map((n) => n.dir)).toEqual([EXP]);
    const exp = r.nodes[0];
    // 워크플로 별칭 'Gibson run' 이 맞으므로 그 워크플로만 남고, UO 도 남는다
    expect(exp.workflows.map((w) => w.path)).toEqual([WF1]);
    expect(exp.workflows[0].uos.map((u) => u.alias)).toEqual(['Gibson']);
    expect(r.expanded.has(exp.id)).toBe(true);
    expect(r.expanded.has(exp.workflows[0].id)).toBe(true);
    expect(r.marks.get(exp.workflows[0].uos[0].id)).toEqual([[0, 6]]);
    expect(r.marks.get(exp.workflows[0].id)).toEqual([[0, 6]]);
    expect(r.partial.has(exp.id)).toBe(true);
  });

  it('a UO-only match keeps only that UO under its workflow', async () => {
    const r = filterTree(await load(), 'plate');
    const wf = r.nodes[0].workflows;
    expect(wf.map((w) => w.path)).toEqual([WF2]);
    expect(wf[0].uos.map((u) => u.code)).toEqual(['UHW380']);
    expect(r.partial.has(wf[0].id)).toBe(true);
  });

  it("'WB030' matches a workflow code", async () => {
    const r = filterTree(await load(), 'wb030');
    expect(r.nodes[0].workflows.map((w) => w.code)).toEqual(['WB030']);
    expect(r.marks.get(`${r.nodes[0].workflows[0].id}:code`)).toEqual([[0, 5]]);
  });

  it('matches the localised status, the project and the experimenter', async () => {
    const nodes = await load();
    expect(filterTree(nodes, '완료').nodes.map((n) => n.dir)).toEqual([DONE]);
    expect(filterTree(nodes, '단백질').nodes).toHaveLength(3);
    expect(filterTree(nodes, '한서연').nodes).toHaveLength(3);
    // 실험 자체가 맞으면 그 아래를 다 남긴다
    const self = filterTree(nodes, '대장균');
    expect(self.nodes[0].workflows).toHaveLength(3);
    expect(self.partial.size).toBe(0);
  });

  it('keeps the core search terms: dates written with -, discussion words and the folder name', async () => {
    const files = experimentVault();
    files[`${PLAN}/README.labnote.md`] = expReadme('계획만', 'planned', [], 'discuss: true\n').replace('2026-02-03', '2026-11-05');
    const nodes = await load(files);
    const match = coreEntryMatcher('Flagged for discussion Something to discuss', {});
    expect(filterTree(nodes, '2026-11', undefined, match).nodes.map((n) => n.dir)).toEqual([PLAN]);
    expect(filterTree(nodes, '2026-02', undefined, match).nodes.map((n) => n.dir)).toEqual([EXP, DONE]);
    expect(filterTree(nodes, 'something to', undefined, match).nodes.map((n) => n.dir)).toEqual([PLAN]);
    expect(filterTree(nodes, 'discuss', undefined, match).nodes.map((n) => n.dir)).toEqual([PLAN]);
    // 폴더 이름(밑줄 그대로)도 실험 자체의 맞음이다
    const byFolder = filterTree(nodes, 'e_coli', undefined, match);
    expect(byFolder.nodes.map((n) => n.dir)).toEqual([EXP]);
    expect(byFolder.nodes[0].workflows).toHaveLength(3);
    expect(byFolder.partial.size).toBe(0);
  });

  it('an experiment that matches keeps every UO and the add rows of a workflow matched only by a UO', async () => {
    const nodes = (await load()).map((n) => (n.dir === EXP ? { ...n, project: 'Incubation lab' } : n));
    const r = filterTree(nodes, 'incubation');
    const exp = r.nodes.find((n) => n.dir === EXP)!;
    expect(exp.workflows).toHaveLength(3);
    const wf2 = exp.workflows.find((w) => w.path === WF2)!;
    expect(wf2.uos.map((u) => u.code)).toEqual(['UHW180', 'UHW380']);
    expect(r.partial.has(wf2.id)).toBe(false);
    expect(r.partial.has(exp.id)).toBe(false);
    expect(r.expanded.has(wf2.id)).toBe(true);
    expect(r.expanded.has(exp.id)).toBe(true);
  });

  it('no match gives no nodes; an empty query changes nothing', async () => {
    const nodes = await load();
    expect(filterTree(nodes, '없는말').nodes).toEqual([]);
    const all = filterTree(nodes, '  ');
    expect(all.nodes).toHaveLength(3);
    expect(all.expanded.size).toBe(0);
  });
});
