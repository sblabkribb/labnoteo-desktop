// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setLang } from '../../../i18n/lang';
import { coreT } from '../../i18n';
import { createTestHost, type TestHost } from '../../__tests__/testHost';
import { vaultRefresh } from '../../commands/context';
import { insertUnitOp } from '../../commands/unitOp';
import { statusNames } from '../../port/status';
import { ContextMenu } from '../../ui/ContextMenu';
import { closeMenu } from '../../ui/menuStore';
import { WorkflowsPanel } from '../WorkflowsPanel';
import { readme } from './panelFixtures';

vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
vi.mock('../../commands/unitOp', () => ({ insertUnitOp: vi.fn(async () => undefined), unitOpCommands: [] }));

const A = 'labnote/001_A';
const B = 'labnote/002_B';
const C = 'labnote/003_C';

let h: TestHost;

beforeEach(() => {
  setLang('ko');
  vi.mocked(insertUnitOp).mockClear();
});

afterEach(() => {
  act(() => closeMenu());
  cleanup();
  h?.cleanup();
  setLang('ko');
});

function vault(): Record<string, string> {
  return {
    [`${A}/README.labnote.md`]: readme('첫 실험', 'failed', 'discuss: true\n'),
    [`${B}/README.labnote.md`]: readme('둘째', 'in-progress'),
    [`${B}/001_WD010_Design.labnote.md`]: '# 설계\n\n수율 확인 @issue;ISS-a1;수율 논의\n',
    [`${C}/README.labnote.md`]: readme('셋째', 'completed'),
  };
}

function mount(files = vault(), settings = {}) {
  h = createTestHost(files, settings);
  render(
    <>
      <WorkflowsPanel ctx={h.ctx} />
      <ContextMenu />
    </>,
  );
  return h;
}

const experimentsTree = () => screen.getByRole('tree', { name: '실험 목록' });
const row = (name: RegExp | string) => screen.getByRole('treeitem', { name });
const findRow = (name: RegExp | string) => screen.findByRole('treeitem', { name });

describe('WorkflowsPanel', () => {
  it('grouping by discuss puts flagged and markered experiments under "Something to discuss"', async () => {
    mount(vault(), { workflowViewGroupBy: 'discuss' });
    // 마커는 첫 그리기 뒤 따로 센다: 002 는 마커가 도착한 뒤에야 논의 그룹으로 간다
    const group = await findRow(`${coreT('Something to discuss')} [2]`);
    expect(group.getAttribute('aria-expanded')).toBe('true');
    expect(row(`${coreT('Nothing to discuss')} [1]`)).toBeTruthy();
    const items = within(experimentsTree()).getAllByRole('treeitem').map((li) => li.textContent);
    const at = items.indexOf(group.textContent);
    expect(items.slice(at + 1, at + 3)).toEqual([expect.stringMatching(/첫 실험/), expect.stringMatching(/둘째/)]);
  });

  it('filter by a Korean status name finds the experiment', async () => {
    const user = userEvent.setup();
    mount();
    await findRow(/첫 실험/);
    const ko = statusNames(h.host).failed;
    expect(ko).toMatch(/[가-힣]/);
    await user.type(screen.getByRole('searchbox', { name: '실험 찾기' }), ko);
    await waitFor(() => expect(screen.queryByRole('treeitem', { name: /둘째/ })).toBeNull());
    expect(row(/첫 실험/)).toBeTruthy();

    await user.clear(screen.getByRole('searchbox', { name: '실험 찾기' }));
    await user.type(screen.getByRole('searchbox', { name: '실험 찾기' }), '없는말');
    expect(await screen.findByText(coreT('No experiment matches "{0}". The search reads folder names, titles, projects, authors, statuses, workflow note names, and dates written with "-" (last updated or created).', '없는말'))).toBeTruthy();
  });

  it('the experiment context menu has Retry only for failed/needs-repeat', async () => {
    mount();
    fireEvent.contextMenu(await findRow(/첫 실험/));
    const failedMenu = screen.getAllByRole('menuitem').map((m) => m.textContent);
    expect(failedMenu).toEqual([coreT('Change experiment status'), coreT('Toggle discussion flag'), coreT('Retry this experiment')]);
    act(() => closeMenu());

    fireEvent.contextMenu(row(/셋째/));
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual([
      coreT('Change experiment status'),
      coreT('Toggle discussion flag'),
    ]);
  });

  it('Show @issue markers picks a spot and opens that note at the marker line', async () => {
    const user = userEvent.setup();
    mount();
    const openFile = vi.spyOn(h.host, 'openFile');
    h.answer.pick((items) => items[0].value);
    // 마커 수가 도착하면 메뉴에 항목이 생긴다
    await waitFor(() => {
      act(() => closeMenu());
      fireEvent.contextMenu(row(/둘째/));
      expect(screen.getByRole('menuitem', { name: coreT('Show @issue markers') })).toBeTruthy();
    });
    await user.click(screen.getByRole('menuitem', { name: coreT('Show @issue markers') }));
    await waitFor(() => expect(openFile).toHaveBeenCalledWith(`${B}/001_WD010_Design.labnote.md`, { line: 2 }));
    expect(h.asked.pick[0].opts?.title).toBe(coreT('@issue markers of {0} ({1})', '002_B', '1'));
    expect(h.asked.pick[0].items.map((i) => i.description)).toEqual(['001_WD010_Design.labnote.md:3']);
  });

  it("the catalog unit-op 'Insert unit operation' calls insertUnitOp with that item", async () => {
    const user = userEvent.setup();
    mount();
    const catalog = await screen.findByRole('tree', { name: '카탈로그' });
    const hwRoot = await within(catalog).findByRole('treeitem', { name: /^HW Unit Operations \[\d+\]$/ });
    await user.click(hwRoot);
    expect(hwRoot.getAttribute('aria-expanded')).toBe('true');
    const op = within(catalog)
      .getAllByRole('treeitem')
      .find((li) => li.getAttribute('aria-level') === '2' && /^U?HW/.test(li.textContent ?? ''))!;
    expect(op).toBeTruthy();
    const id = op.textContent!.split(':')[0];
    fireEvent.contextMenu(op);
    await user.click(screen.getByRole('menuitem', { name: coreT('Insert unit operation') }));
    await waitFor(() => expect(insertUnitOp).toHaveBeenCalledTimes(1));
    expect(vi.mocked(insertUnitOp).mock.calls[0][0]).toBe(h.ctx);
    expect(vi.mocked(insertUnitOp).mock.calls[0][1]).toEqual({ op: expect.objectContaining({ id }), kind: 'hw' });
  });

  it('keyboard: ArrowRight expands, Enter opens', async () => {
    const user = userEvent.setup();
    mount();
    const catalog = await screen.findByRole('tree', { name: '카탈로그' });
    const root = await within(catalog).findByRole('treeitem', { name: /^Workflows \[\d+\]$/ });
    expect(root.getAttribute('aria-expanded')).toBe('false');
    root.focus();
    await user.keyboard('{ArrowRight}');
    expect(root.getAttribute('aria-expanded')).toBe('true');
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement?.getAttribute('aria-level')).toBe('2');

    const exp = row(/셋째/);
    exp.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(h.opened).toEqual([`${C}/README.labnote.md`]));
    // 클릭도 연다
    await user.click(row(/둘째/));
    await waitFor(() => expect(h.opened).toEqual([`${C}/README.labnote.md`, `${B}/README.labnote.md`]));
  });

  it('no style attributes', async () => {
    const { container } = render(<div />);
    mount();
    await findRow(/첫 실험/);
    expect(document.querySelectorAll('[style]')).toHaveLength(0);
    expect(container.querySelectorAll('[style]')).toHaveLength(0);
  });

  it('language switch relabels the open tree without refetch', async () => {
    mount();
    await findRow(/^실험 \[3\]/);
    await screen.findByRole('tree', { name: '카탈로그' });
    await waitFor(() => expect(within(experimentsTree()).getByRole('treeitem', { name: /둘째/ }).getAttribute('title')).toMatch(/@issue/));
    const calls = h.vault.log.length;
    act(() => setLang('en'));
    expect(await screen.findByRole('treeitem', { name: /^Experiments \[3\]/ })).toBeTruthy();
    expect(screen.getByRole('tree', { name: 'Experiments' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New experiment' })).toBeTruthy();
    expect(h.vault.log.length).toBe(calls);
  });

  it('a vault refresh re-reads in the background and keeps the rows meanwhile', async () => {
    mount();
    await findRow(/셋째/);
    await h.vault.mem.write(`${C}/README.labnote.md`, readme('셋째 고침', 'completed'));
    act(() => vaultRefresh.emit());
    expect(row(/셋째/)).toBeTruthy(); // 비우지 않는다
    expect(await findRow(/셋째 고침/)).toBeTruthy();
  });

  it('grouping by last updated puts experiments into week groups with translated names (#515)', async () => {
    const user = userEvent.setup();
    mount();
    await findRow(/첫 실험/);
    await user.selectOptions(screen.getByRole('combobox', { name: '묶는 기준' }), 'updated');
    expect(h.ctx.settings.workflowViewGroupBy).toBe('updated');
    // 픽스처의 last_updated_date 는 2026-02-03: 지난주보다 앞이다
    expect(coreT('Earlier')).not.toBe('Earlier');
    expect(await findRow(`${coreT('Earlier')} [3]`)).toBeTruthy();
  });

  it('group-by is kept in settings, and New experiment runs create-experiment', async () => {
    const user = userEvent.setup();
    mount();
    await findRow(/첫 실험/);
    await user.selectOptions(screen.getByRole('combobox', { name: '묶는 기준' }), 'project');
    expect(h.ctx.settings.workflowViewGroupBy).toBe('project');
    expect(await findRow('단백질 [3]')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '새 실험' }));
    await waitFor(() => expect(h.asked.prompt).toHaveLength(1)); // 실험 제목을 묻는다
  });
});
