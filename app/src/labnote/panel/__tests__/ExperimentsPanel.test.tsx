// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setLang } from '../../../i18n/lang';
import { coreT } from '../../i18n';
import { createTestHost, type TestHost } from '../../__tests__/testHost';
import { vaultRefresh } from '../../commands/context';
import { insertUnitOp } from '../../commands/unitOp';
import { createWorkflow } from '../../commands/workflow';
import { ContextMenu } from '../../ui/ContextMenu';
import { closeMenu } from '../../ui/menuStore';
import { ExperimentsPanel } from '../ExperimentsPanel';
import { resetGithubStatusesForTest, setGithubStatuses } from '../../../github/statusStore';
import type { FolderStatus } from '../../../integrations/githubIpc';
import { WorkflowsPanel } from '../WorkflowsPanel';
import { DONE, EXP, experimentVault, expReadme, PLAN, WF1, WF2 } from './experimentFixtures';
import workflowsJson from '../../../../vendor/labnoteo/packages/labnoteo-core/src/catalog/workflows_en.json';
import hwJson from '../../../../vendor/labnoteo/packages/labnoteo-core/src/catalog/unitoperations_hw_en.json';
import swJson from '../../../../vendor/labnoteo/packages/labnoteo-core/src/catalog/unitoperations_sw_en.json';

const WORKFLOWS = workflowsJson.workflows.length;
const UNIT_OPS = hwJson.unitOperations.length + swJson.unitOperations.length;

vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
vi.mock('../../commands/unitOp', () => ({ insertUnitOp: vi.fn(async () => undefined), unitOpCommands: [] }));
vi.mock('../../commands/workflow', async (orig) => ({
  ...(await orig<typeof import('../../commands/workflow')>()),
  createWorkflow: vi.fn(async () => undefined),
}));

let h: TestHost;
const scrolled = vi.fn();

beforeEach(() => {
  setLang('ko');
  vi.mocked(insertUnitOp).mockClear();
  vi.mocked(createWorkflow).mockClear();
  scrolled.mockClear();
  Element.prototype.scrollIntoView = scrolled;
});

afterEach(() => {
  act(() => closeMenu());
  cleanup();
  resetGithubStatusesForTest();
  h?.cleanup();
  setLang('ko');
});

function mount(opts: { files?: Record<string, string>; settings?: object; active?: string } = {}) {
  h = createTestHost(opts.files ?? experimentVault(), opts.settings ?? {});
  if (opts.active) h.setActive(opts.active);
  const view = render(
    <>
      <ExperimentsPanel ctx={h.ctx} activePath={opts.active} />
      <ContextMenu />
    </>,
  );
  return { h, ...view };
}

const tree = () => screen.getByRole('tree', { name: '실험 목록' });
const items = () => within(tree()).getAllByRole('treeitem');
const findRow = async (name: RegExp | string) => within(await screen.findByRole('tree', { name: '실험 목록' })).findByRole('treeitem', { name });
const row = (name: RegExp | string) => within(tree()).getByRole('treeitem', { name });

async function expandExperiment() {
  const exp = await findRow(/003 · 대장균 숙주 비교/);
  fireEvent.keyDown(exp, { key: 'ArrowRight' });
  await waitFor(() => expect(exp.getAttribute('aria-expanded')).toBe('true'));
  // UO 는 Workflow 본문을 뒤에서 읽은 뒤에 생긴다
  await waitFor(() => expect(row(/^.*Gibson run/).getAttribute('aria-expanded')).toBe('false'));
  return exp;
}

describe('ExperimentsPanel', () => {
  it('WorkflowsPanel is the same panel', () => {
    expect(WorkflowsPanel).toBe(ExperimentsPanel);
  });

  it('groups by status in the order In progress, Planned, Done, with a muted count', async () => {
    mount();
    await findRow(/003 · 대장균 숙주 비교/);
    const groups = items().filter((li) => li.getAttribute('aria-level') === '1');
    expect(groups.map((g) => g.querySelector('.wf-tree-label')?.textContent)).toEqual(['진행 중', '계획', '완료']);
    expect(groups.map((g) => g.querySelector('.tree-meta')?.textContent)).toEqual(['1', '1', '1']);
  });

  it('experiment rows carry a status shape icon with a text label', async () => {
    mount();
    const states = [await findRow(/003 · /), row(/004 · /), row(/005 · /)].map((li) => li.querySelector('.tree-state')!);
    expect(states.map((s) => s.getAttribute('data-icon'))).toEqual(['circle-half', 'circle-dashed', 'circle-check']);
    expect(states.map((s) => s.getAttribute('aria-label'))).toEqual(['진행 중', '계획', '완료']);
  });

  it('an expanded experiment lists workflows by prefix, README, images and resources with counts, and an add row', async () => {
    mount();
    await expandExperiment();
    const level3 = items()
      .filter((li) => li.getAttribute('aria-level') === '3')
      .map((li) => li.querySelector('.wf-tree-label')?.textContent);
    expect(level3).toEqual(['Gibson run', 'GFP', 'Design', 'README', 'images', 'resources', 'Workflow 추가']);
    expect(row(/^images/).querySelector('.tree-meta')?.textContent).toBe('2');
    expect(row(/^resources/).querySelector('.tree-meta')?.textContent).toBe('1');
    expect(row(/003 · /).querySelector('.tree-meta')?.textContent).toBe('1/3');
  });

  it('a workflow row shows the alias first and the code as a right-aligned .meta.code, with a UO meta', async () => {
    mount();
    await expandExperiment();
    const wf = row(/GFP/);
    const parts = [...wf.children].map((c) => c.className);
    expect(parts.indexOf('wf-tree-label')).toBeLessThan(parts.indexOf('meta code'));
    expect(wf.querySelector('.meta.code')?.textContent).toBe('WT020');
    expect(wf.querySelector('.tree-meta')?.textContent).toBe('1/2');
    expect([row(/Gibson run/), wf, row(/^.*Design/)].map((li) => li.querySelector('.tree-state')?.getAttribute('data-icon'))).toEqual([
      'circle-check',
      'circle-half',
      'circle-dashed',
    ]);
  });

  it('the add-workflow row targets its own experiment while another note is open', async () => {
    const user = userEvent.setup();
    mount({ active: `${PLAN}/README.labnote.md` });
    await expandExperiment();
    await user.click(within(tree()).getAllByRole('treeitem', { name: 'Workflow 추가' })[0]);
    await waitFor(() => expect(createWorkflow).toHaveBeenCalledTimes(1));
    expect(vi.mocked(createWorkflow).mock.calls[0]).toEqual([h.ctx, undefined, { experimentDir: EXP }]);
    // 줄에 올리면 보이는 + 도 같다
    await user.click(within(row(/003 · /)).getByRole('button', { name: 'Workflow 추가' }));
    await waitFor(() => expect(createWorkflow).toHaveBeenCalledTimes(2));
    expect(vi.mocked(createWorkflow).mock.calls[1]).toEqual([h.ctx, undefined, { experimentDir: EXP }]);
  });

  it('the add-UO row and the + of a workflow target that workflow note', async () => {
    const user = userEvent.setup();
    mount({ active: `${PLAN}/README.labnote.md` });
    await expandExperiment();
    const wf = row(/GFP/);
    await user.click(within(wf).getByRole('button', { name: 'Unit Operation 추가' }));
    await waitFor(() => expect(insertUnitOp).toHaveBeenCalledTimes(1));
    expect(vi.mocked(insertUnitOp).mock.calls[0]).toEqual([h.ctx, undefined, { workflowPath: WF2 }]);
    fireEvent.keyDown(wf, { key: 'ArrowRight' });
    await waitFor(() => expect(wf.getAttribute('aria-expanded')).toBe('true'));
    await user.click(row('Unit Operation 추가'));
    await waitFor(() => expect(insertUnitOp).toHaveBeenCalledTimes(2));
    expect(vi.mocked(insertUnitOp).mock.calls[1]).toEqual([h.ctx, undefined, { workflowPath: WF2 }]);
  });

  it("the current note's branch is expanded and scrolled into view", async () => {
    mount({ active: WF2 });
    const wf = await findRow(/GFP/);
    expect(wf.getAttribute('aria-current')).toBe('true');
    await waitFor(() => expect(wf.getAttribute('aria-expanded')).toBe('true'));
    expect(row(/003 · /).getAttribute('aria-expanded')).toBe('true');
    expect(row(/plate 1/)).toBeTruthy();
    expect(scrolled).toHaveBeenCalled();
  });

  it('clicking a UO row opens the workflow note at its heading', async () => {
    const user = userEvent.setup();
    mount({ active: WF2 });
    const openFile = vi.spyOn(h.ctx, 'openFile');
    const uo = await findRow(/plate 1/);
    expect(uo.querySelector('.meta.code')?.textContent).toBe('UHW380');
    await user.click(uo);
    const line = experimentVault()[WF2].split('\n').indexOf('### [UHW380 Microplate Reading] plate 1');
    await waitFor(() => expect(openFile).toHaveBeenCalledWith(WF2, { line }));
  });

  it('clicking the state icon of a workflow ticks it in the README checklist', async () => {
    const user = userEvent.setup();
    mount();
    await expandExperiment();
    await user.click(within(row(/GFP/)).getByRole('button', { name: /README/ }));
    await waitFor(async () => expect(await h.vault.mem.read(`${EXP}/README.labnote.md`)).toMatch(/- \[x\] \[WT020 Protein Expression Measurement GFP\]/));
    await waitFor(() => expect(row(/GFP/).querySelector('.tree-state')?.getAttribute('aria-label')).toMatch(/^README 에서 완료로 체크했지만 UO/));
    // 다시 누르면 푼다
    await user.click(within(row(/Gibson run/)).getByRole('button', { name: /README/ }));
    await waitFor(async () => expect(await h.vault.mem.read(`${EXP}/README.labnote.md`)).toMatch(/- \[ \] \[WB030 DNA Assembly Gibson run\]/));
    expect(h.opened).toEqual([]);
  });

  it('the workflow context menu ticks and unticks it in the README (keyboard reach)', async () => {
    const user = userEvent.setup();
    mount();
    await expandExperiment();
    fireEvent.keyDown(row(/GFP/), { key: 'F10', shiftKey: true });
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Unit Operation 추가', 'README 에서 완료로 체크']);
    await user.click(screen.getByRole('menuitem', { name: 'README 에서 완료로 체크' }));
    await waitFor(async () => expect(await h.vault.mem.read(`${EXP}/README.labnote.md`)).toMatch(/- \[x\] \[WT020 Protein Expression Measurement GFP\]/));
    await waitFor(() => expect(row(/GFP/).querySelector('.tree-state')?.getAttribute('aria-label')).toMatch(/^README 에서 완료로 체크했지만 UO/));
    fireEvent.contextMenu(row(/GFP/));
    expect(screen.getByRole('menuitem', { name: 'README 에서 체크 해제' })).toBeTruthy();
  });

  it('clicking images/ reveals that folder in the Files tab', async () => {
    const user = userEvent.setup();
    mount();
    const reveal = vi.fn();
    h.ctx.revealInFiles = reveal;
    await expandExperiment();
    await user.click(row(/^images/));
    expect(reveal).toHaveBeenCalledWith(`${EXP}/images`);
  });

  it('the filter keeps the plugin search terms: a date written with -', async () => {
    const user = userEvent.setup();
    mount();
    await findRow(/003 · /);
    await user.type(screen.getByRole('searchbox', { name: '실험 찾기' }), '2026-02');
    expect(await findRow(/005 · /)).toBeTruthy();
    expect(row(/003 · /)).toBeTruthy();
    expect(screen.queryByText('일치하는 실험·Workflow·UO 없음')).toBeNull();
  });

  it('the filter reaches UOs, marks the match and hides the rest; no match shows the empty state', async () => {
    const user = userEvent.setup();
    mount();
    await expandExperiment();
    const box = screen.getByRole('searchbox', { name: '실험 찾기' });
    await user.type(box, 'plate');
    const uo = await findRow(/plate 1/);
    expect(uo.querySelector('mark')?.textContent).toBe('plate');
    // 남은 UO 가 하나여도 Workflow의 진행은 전체로 센다
    expect(row(/GFP/).querySelector('.tree-meta')?.textContent).toBe('1/2');
    expect(screen.queryByRole('treeitem', { name: /004 · / })).toBeNull();
    expect(screen.queryByRole('treeitem', { name: /Gibson run/ })).toBeNull();
    expect(screen.queryByRole('treeitem', { name: 'README' })).toBeNull();

    await user.clear(box);
    await user.type(box, '없는말');
    expect(await screen.findByText('일치하는 실험·Workflow·UO 없음')).toBeTruthy();
  });

  it('the filter matches a localised status name', async () => {
    const user = userEvent.setup();
    mount();
    await findRow(/003 · /);
    await user.type(screen.getByRole('searchbox', { name: '실험 찾기' }), '계획');
    await waitFor(() => expect(screen.queryByRole('treeitem', { name: /003 · / })).toBeNull());
    expect(row(/004 · /)).toBeTruthy();
  });

  it('the experiment context menu keeps status, discussion and retry', async () => {
    const files = { ...experimentVault(), [`${DONE}/README.labnote.md`]: expReadme('끝난 실험', 'failed', []) };
    mount({ files });
    fireEvent.contextMenu(await findRow(/005 · /));
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual([
      'Workflow 추가',
      coreT('Change experiment status'),
      coreT('Toggle discussion flag'),
      coreT('Retry this experiment'),
      'GitHub에 올리기…',
    ]);
  });

  it('the experiment context menu offers the GitHub items for the link state', async () => {
    setGithubStatuses({ [EXP]: { linked: true, state: 'pushed', changedCount: 0, folderMissing: false, htmlUrl: 'https://github.com/me/x' } });
    mount();
    fireEvent.contextMenu(await findRow(/003 · /));
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent).slice(-3)).toEqual(['바뀐 내용 올리기', 'GitHub에서 보기', 'GitHub 연결 끊기…']);
    expect([...document.querySelectorAll('.context-menu-section')].map((e) => e.textContent)).toContain('GitHub');
  });

  it('draws a GitHub status mark with aria-label and title for each state, none when not linked', async () => {
    const st = (over: Partial<FolderStatus>): FolderStatus => ({ linked: true, state: 'pushed', changedCount: 0, folderMissing: false, ...over });
    setGithubStatuses({ [EXP]: st({}), [PLAN]: st({ changedCount: 4 }) });
    mount();
    const badge = async (name: RegExp) => (await findRow(name)).querySelector('.tree-badge');
    expect((await badge(/003 · /))?.getAttribute('aria-label')).toBe('GitHub에 올라가 있음');
    expect((await badge(/003 · /))?.getAttribute('title')).toBe('GitHub에 올라가 있음');
    expect((await badge(/004 · /))?.getAttribute('aria-label')).toBe('올리지 않은 변경 4개');
    expect(await badge(/005 · /)).toBeNull();
    act(() => setGithubStatuses({ [EXP]: st({ state: 'committed' }) }));
    expect(row(/003 · /).querySelector('.tree-badge')?.getAttribute('aria-label')).toBe('올리기가 끝나지 않았습니다');
    expect(row(/003 · /).querySelector('.tree-badge')?.getAttribute('title')).toBe('올리기가 끝나지 않았습니다');
    expect(row(/004 · /).querySelector('.tree-badge')).toBeNull();
  });

  it('group-by is kept in settings with the plugin value; New experiment runs create-experiment', async () => {
    const user = userEvent.setup();
    mount();
    await findRow(/003 · /);
    await user.click(screen.getByRole('button', { name: '묶는 기준: 상태별' }));
    await user.click(screen.getByRole('option', { name: '실험자별' }));
    expect(h.ctx.settings.workflowViewGroupBy).toBe('author');
    expect(await findRow(/^한서연/)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '새 실험' }));
    await waitFor(() => expect(h.asked.prompt).toHaveLength(1));
  });

  it('collapse all folds every experiment', async () => {
    const user = userEvent.setup();
    mount();
    const exp = await expandExperiment();
    await user.click(screen.getByRole('button', { name: '모두 접기' }));
    expect(exp.getAttribute('aria-expanded')).toBe('false');
  });

  it('language switch relabels without re-reading, and nothing carries a style attribute', async () => {
    mount();
    await expandExperiment();
    const calls = h.vault.log.length;
    act(() => setLang('en'));
    expect(await screen.findByRole('tree', { name: 'Experiments' })).toBeTruthy();
    expect(screen.getAllByRole('treeitem', { name: 'Add workflow' }).length).toBeGreaterThan(0);
    expect(document.querySelector('.tree-group .wf-tree-label')?.textContent).toBe('In progress');
    expect(h.vault.log.length).toBe(calls);
    expect(document.querySelectorAll('[style]')).toHaveLength(0);
  });

  it('a vault refresh re-reads in the background and keeps the rows meanwhile', async () => {
    mount();
    await findRow(/005 · /);
    await h.vault.mem.write(`${DONE}/README.labnote.md`, expReadme('끝난 실험 고침', 'completed', []));
    act(() => vaultRefresh.emit());
    expect(row(/005 · /)).toBeTruthy();
    expect(await findRow(/끝난 실험 고침/)).toBeTruthy();
  });

  it('the catalog sits collapsed at the bottom with its counts; expanded it splits into Workflows / HW UO / SW UO', async () => {
    const user = userEvent.setup();
    mount();
    const head = await screen.findByRole('button', { name: /^카탈로그/ });
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(head.textContent).toContain(`Workflow ${WORKFLOWS} · UO ${UNIT_OPS}`);
    expect(screen.queryByRole('tree', { name: '카탈로그' })).toBeNull();
    await user.click(head);
    const catalog = await screen.findByRole('tree', { name: '카탈로그' });
    const roots = within(catalog)
      .getAllByRole('treeitem')
      .filter((li) => li.getAttribute('aria-level') === '1')
      .map((li) => li.querySelector('.wf-tree-label')?.textContent);
    expect(roots).toEqual(['Workflow', 'HW UO', 'SW UO']);
  });

  it('the catalog tree still offers Insert unit operation from its menu', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByRole('button', { name: /^카탈로그/ }));
    const catalog = await screen.findByRole('tree', { name: '카탈로그' });
    await user.click(within(catalog).getByRole('treeitem', { name: /^HW UO/ }));
    const op = within(catalog)
      .getAllByRole('treeitem')
      .find((li) => li.getAttribute('aria-level') === '2')!;
    const code = op.querySelector('.meta.code')?.textContent;
    expect(code).toMatch(/^UHW\d+$/);
    fireEvent.contextMenu(op);
    await user.click(screen.getByRole('menuitem', { name: coreT('Insert unit operation') }));
    await waitFor(() => expect(insertUnitOp).toHaveBeenCalledTimes(1));
    expect(vi.mocked(insertUnitOp).mock.calls[0][1]).toEqual({ op: expect.objectContaining({ id: code }), kind: 'hw' });
  });

  async function openCatalogEntry(user: ReturnType<typeof userEvent.setup>, root: RegExp, path: RegExp[], code: string) {
    await user.click(await screen.findByRole('button', { name: /^카탈로그/ }));
    const catalog = await screen.findByRole('tree', { name: '카탈로그' });
    await user.click(within(catalog).getByRole('treeitem', { name: root }));
    for (const step of path) await user.click(within(catalog).getByRole('treeitem', { name: step }));
    const entry = within(catalog)
      .getAllByRole('treeitem')
      .find((li) => li.querySelector('.meta.code')?.textContent === code)!;
    await user.click(entry);
    return screen.findByRole('dialog', { name: new RegExp(`^${code} `) });
  }

  it('a catalog workflow with an experiment open: the popover adds it to that experiment', async () => {
    const user = userEvent.setup();
    mount({ active: `${EXP}/README.labnote.md` });
    const pop = await openCatalogEntry(user, /^Workflow/, [/^Build/], 'WB030');
    expect(pop.textContent).toContain('DNA Assembly');
    const add = within(pop).getByRole('button', { name: '현재 실험에 추가 (003 · 대장균 숙주 비교)' });
    await user.click(add);
    await waitFor(() => expect(createWorkflow).toHaveBeenCalledTimes(1));
    expect(vi.mocked(createWorkflow).mock.calls[0][1]).toEqual(expect.objectContaining({ id: 'WB030' }));
    expect(vi.mocked(createWorkflow).mock.calls[0][2]).toEqual({ experimentDir: EXP });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('with no experiment open, the add button is disabled and says why', async () => {
    const user = userEvent.setup();
    mount();
    const pop = await openCatalogEntry(user, /^Workflow/, [/^Build/], 'WB030');
    const add = within(pop).getByRole('button', { name: '현재 실험에 추가' }) as HTMLButtonElement;
    // aria-disabled, not disabled: the button keeps focus so Esc works and a screen reader reads the reason
    expect(add.disabled).toBe(false);
    expect(add.getAttribute('aria-disabled')).toBe('true');
    expect(pop.textContent).toContain('먼저 실험 노트를 여세요.');
    expect(document.getElementById(add.getAttribute('aria-describedby')!)?.textContent).toBe('먼저 실험 노트를 여세요.');
    expect(add.title).toBe('먼저 실험 노트를 여세요.');
    await user.click(add);
    expect(createWorkflow).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: /^WB030 / })).toBeTruthy();
  });

  it('with no experiment open, Enter on a catalog row opens the popover with focus inside; Esc closes it and returns focus to the row', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByRole('button', { name: /^카탈로그/ }));
    const catalog = await screen.findByRole('tree', { name: '카탈로그' });
    await user.click(within(catalog).getByRole('treeitem', { name: /^Workflow/ }));
    await user.click(within(catalog).getByRole('treeitem', { name: /^Build/ }));
    const row = within(catalog)
      .getAllByRole('treeitem')
      .find((li) => li.querySelector('.meta.code')?.textContent === 'WB030')!;
    act(() => row.focus());
    await user.keyboard('{Enter}');
    const pop = await screen.findByRole('dialog', { name: /^WB030 / });
    const add = within(pop).getByRole('button', { name: '현재 실험에 추가' });
    expect(document.activeElement).toBe(add);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(row);
  });

  it('a catalog UO with a workflow note open: the popover inserts into that workflow; Esc closes it', async () => {
    const user = userEvent.setup();
    mount({ active: WF1 });
    let pop = await openCatalogEntry(user, /^HW UO/, [], 'UHW380');
    await user.click(within(pop).getByRole('button', { name: '현재 Workflow에 삽입 (WB030 Gibson run)' }));
    await waitFor(() => expect(insertUnitOp).toHaveBeenCalledTimes(1));
    expect(vi.mocked(insertUnitOp).mock.calls[0][1]).toEqual({ op: expect.objectContaining({ id: 'UHW380' }), kind: 'hw' });
    const catalog = screen.getByRole('tree', { name: '카탈로그' });
    await user.click(within(catalog).getAllByRole('treeitem').find((li) => li.querySelector('.meta.code')?.textContent === 'UHW380')!);
    pop = await screen.findByRole('dialog', { name: /^UHW380 / });
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('the Korean catalog description in the tree title and the popover writes Workflow in English (term rule)', async () => {
    const user = userEvent.setup();
    mount();
    const pop = await openCatalogEntry(user, /^Workflow/, [/^Build/], 'WB001');
    const catalog = screen.getByRole('tree', { name: '카탈로그' });
    const row = within(catalog)
      .getAllByRole('treeitem')
      .find((li) => li.querySelector('.meta.code')?.textContent === 'WB001')!;
    const title = row.querySelector('[title]')?.getAttribute('title') ?? row.getAttribute('title') ?? '';
    expect(title).toContain('범용 Workflow입니다');
    expect(title).not.toMatch(/워크플로/);
    const ko = [...pop.querySelectorAll('.catalog-popover-desc')].find((el) => !el.hasAttribute('lang'))!;
    expect(ko.textContent).toContain('범용 Workflow입니다');
    expect(pop.textContent).not.toMatch(/워크플로|유닛\s*오퍼레이션|단위\s*공정/);
  });

  it('a catalog UO with only an experiment README open is disabled with the workflow reason', async () => {
    const user = userEvent.setup();
    mount({ active: `${EXP}/README.labnote.md` });
    const pop = await openCatalogEntry(user, /^HW UO/, [], 'UHW380');
    expect(within(pop).getByRole('button', { name: '현재 Workflow에 삽입' }).getAttribute('aria-disabled')).toBe('true');
    expect(pop.textContent).toContain('먼저 Workflow 노트를 여세요.');
  });
});
