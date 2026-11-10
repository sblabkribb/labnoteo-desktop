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
import { WorkflowsPanel } from '../WorkflowsPanel';
import { DONE, EXP, experimentVault, expReadme, PLAN, WF2 } from './experimentFixtures';

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
  // UO 는 워크플로 본문을 뒤에서 읽은 뒤에 생긴다
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
    expect(level3).toEqual(['Gibson run', 'GFP', 'Design', 'README', 'images', 'resources', '워크플로 추가']);
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
    await user.click(within(tree()).getAllByRole('treeitem', { name: '워크플로 추가' })[0]);
    await waitFor(() => expect(createWorkflow).toHaveBeenCalledTimes(1));
    expect(vi.mocked(createWorkflow).mock.calls[0]).toEqual([h.ctx, undefined, { experimentDir: EXP }]);
    // 줄에 올리면 보이는 + 도 같다
    await user.click(within(row(/003 · /)).getByRole('button', { name: '워크플로 추가' }));
    await waitFor(() => expect(createWorkflow).toHaveBeenCalledTimes(2));
    expect(vi.mocked(createWorkflow).mock.calls[1]).toEqual([h.ctx, undefined, { experimentDir: EXP }]);
  });

  it('the add-UO row and the + of a workflow target that workflow note', async () => {
    const user = userEvent.setup();
    mount({ active: `${PLAN}/README.labnote.md` });
    await expandExperiment();
    const wf = row(/GFP/);
    await user.click(within(wf).getByRole('button', { name: '유닛 오퍼레이션 추가' }));
    await waitFor(() => expect(insertUnitOp).toHaveBeenCalledTimes(1));
    expect(vi.mocked(insertUnitOp).mock.calls[0]).toEqual([h.ctx, undefined, { workflowPath: WF2 }]);
    fireEvent.keyDown(wf, { key: 'ArrowRight' });
    await waitFor(() => expect(wf.getAttribute('aria-expanded')).toBe('true'));
    await user.click(row('유닛 오퍼레이션 추가'));
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
    await waitFor(() => expect(row(/GFP/).querySelector('.tree-state')?.getAttribute('data-icon')).toBe('circle-check'));
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
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['유닛 오퍼레이션 추가', 'README 에서 완료로 체크']);
    await user.click(screen.getByRole('menuitem', { name: 'README 에서 완료로 체크' }));
    await waitFor(async () => expect(await h.vault.mem.read(`${EXP}/README.labnote.md`)).toMatch(/- \[x\] \[WT020 Protein Expression Measurement GFP\]/));
    await waitFor(() => expect(row(/GFP/).querySelector('.tree-state')?.getAttribute('data-icon')).toBe('circle-check'));
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
    expect(screen.queryByText('일치하는 실험·워크플로·UO 없음')).toBeNull();
  });

  it('the filter reaches UOs, marks the match and hides the rest; no match shows the empty state', async () => {
    const user = userEvent.setup();
    mount();
    await expandExperiment();
    const box = screen.getByRole('searchbox', { name: '실험 찾기' });
    await user.type(box, 'plate');
    const uo = await findRow(/plate 1/);
    expect(uo.querySelector('mark')?.textContent).toBe('plate');
    // 남은 UO 가 하나여도 워크플로의 진행은 전체로 센다
    expect(row(/GFP/).querySelector('.tree-meta')?.textContent).toBe('1/2');
    expect(screen.queryByRole('treeitem', { name: /004 · / })).toBeNull();
    expect(screen.queryByRole('treeitem', { name: /Gibson run/ })).toBeNull();
    expect(screen.queryByRole('treeitem', { name: 'README' })).toBeNull();

    await user.clear(box);
    await user.type(box, '없는말');
    expect(await screen.findByText('일치하는 실험·워크플로·UO 없음')).toBeTruthy();
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
      '워크플로 추가',
      coreT('Change experiment status'),
      coreT('Toggle discussion flag'),
      coreT('Retry this experiment'),
    ]);
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

  it('the catalog tree still offers Insert unit operation', async () => {
    const user = userEvent.setup();
    mount();
    const catalog = await screen.findByRole('tree', { name: '카탈로그' });
    const hwRoot = await within(catalog).findByRole('treeitem', { name: /^HW Unit Operations \[\d+\]$/ });
    await user.click(hwRoot);
    const op = within(catalog)
      .getAllByRole('treeitem')
      .find((li) => li.getAttribute('aria-level') === '2' && /^U?HW/.test(li.textContent ?? ''))!;
    fireEvent.contextMenu(op);
    await user.click(screen.getByRole('menuitem', { name: coreT('Insert unit operation') }));
    await waitFor(() => expect(insertUnitOp).toHaveBeenCalledTimes(1));
    expect(vi.mocked(insertUnitOp).mock.calls[0][1]).toEqual({ op: expect.objectContaining({ id: op.textContent!.split(':')[0] }), kind: 'hw' });
  });
});
