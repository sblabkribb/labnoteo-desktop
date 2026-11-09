// @vitest-environment jsdom
/**
 * Samples 사이드 탭(plan SP5 Task 25, D15): 플러그인 views/sampleView.ts 의 앱판. Local·Global 트리, 찾기, 도움말,
 * 같은 폴더 알림, 펼침 씨앗, 맥락 메뉴(#159), 사용처 고르기, 새로 읽기, 종류 색 견본.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { buildSampleTree, type TreeNode } from '@labnoteo/core';
import { getSampleDisplayMeta } from '@labnoteo/core/lib/sampleUtils';
import { getLang, setLang } from '../../i18n/lang';
import { t } from '../../i18n/t';
import { coreT } from '../../labnote/i18n';
import { createTestHost, type TestHost } from '../../labnote/__tests__/testHost';
import { ContextMenu } from '../../labnote/ui/ContextMenu';
import { closeMenu } from '../../labnote/ui/menuStore';
import {
  SAMPLE_PANEL_REFRESH_MS,
  SAMPLE_SEARCH_MS,
  sampleMenuItems,
  seedInitialExpansion,
  showUsages,
  typeMenuItems,
} from '../../labnote/port/sampleView';
import { sampleCommands } from '../commands';
import { createSampleEnv, sampleEvents } from '../env';
import { samples } from '../sampleStore';
import { SamplesPanel } from '../SamplesPanel';
import { GLOBAL, LOCAL, NOTE, SAMPLE_VAULT } from './fixtures';

vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));

const lang = getLang();
let hosts: TestHost[] = [];
const host = (files: Record<string, string> = SAMPLE_VAULT, settings = {}) => {
  const th = createTestHost(files, settings);
  hosts.push(th);
  return th;
};

beforeEach(() => setLang('ko'));
afterEach(() => {
  act(() => closeMenu());
  cleanup();
  for (const th of hosts) th.cleanup();
  hosts = [];
  samples.resetForTest();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setLang(lang);
});

function mount(th: TestHost, activePath: string | undefined = NOTE) {
  return render(
    <>
      <SamplesPanel ctx={th.ctx} activePath={activePath} />
      <ContextMenu />
    </>,
  );
}

const row = (name: RegExp | string) => screen.getByRole('treeitem', { name });
const findRow = (name: RegExp | string) => screen.findByRole('treeitem', { name });

async function treeFixture(): Promise<TreeNode[]> {
  const th = host();
  const types = getSampleDisplayMeta([]).types;
  return buildSampleTree(th.host.fs, { local: LOCAL, global: GLOBAL }, types, { discarded: coreT('(discarded)') });
}

function collectAllIds(nodes: readonly TreeNode[]): Set<string> {
  const ids = new Set<string>();
  const walk = (list: readonly TreeNode[]) => {
    for (const n of list) {
      ids.add(n.id);
      if (n.children) walk(n.children);
    }
  };
  walk(nodes);
  return ids;
}

function findNode(nodes: readonly TreeNode[], id: string): TreeNode {
  const stack = [...nodes];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (n.id === id) return n;
    stack.push(...(n.children ?? []));
  }
  throw new Error(`no node ${id}`);
}

describe('SamplesPanel', () => {
  it('shows Local and Global roots in the UI language with type counts and the hint', async () => {
    const th = host();
    mount(th);
    expect(await screen.findByText(t('samples.root.local'))).toBeTruthy();
    expect(t('samples.root.local')).toBe('샘플 (로컬)');
    expect(screen.getByText(t('samples.root.global'))).toBeTruthy();
    expect(await screen.findByText('DNA [1]')).toBeTruthy();
    expect(screen.getByText('Reagent [1]')).toBeTruthy();
    expect(
      screen.getByText(coreT('Type @dna (or another type) in a note, or right-click → "{0}" to register a sample.', coreT('Add sample'))),
    ).toBeTruthy();
    expect(screen.getByPlaceholderText(coreT('Search samples'))).toBeTruthy();
  });

  it('detail rows use the app prefixes in the UI language', async () => {
    const th = host();
    mount(th);
    await findRow(/DNA-1/);
    fireEvent.click(row(/DNA-1/));
    expect(await screen.findByText(t('samples.detail.alias', 'pUC'))).toBeTruthy();
    expect(screen.getByText(t('samples.detail.description', '', 'miniprep'))).toBeTruthy();
    expect(screen.getByText(t('samples.detail.location', 'Freezer A / B3'))).toBeTruthy();
    expect(t('samples.detail.location', 'x')).toBe('보관 위치: x');
  });

  it('a discarded sample is labelled with the plugin key', async () => {
    const th = host();
    mount(th);
    const reagent = await findRow(/Reagent-7/);
    expect(coreT('(discarded)')).toMatch(/[가-힣]/);
    expect(reagent.textContent).toContain(coreT('(discarded)'));
    expect(reagent.className).toContain('dimmed');
  });

  it('outside an experiment the Local root shows the same-folder notice', async () => {
    const th = host();
    mount(th, 'Home.md');
    expect(
      await screen.findByText(
        coreT('Notes outside an experiment use the Global samples below. Open an experiment note to see its samples.'),
      ),
    ).toBeTruthy();
    // Local 아래에는 빈 종류 줄이 없다: 종류 줄은 Global 아래의 것뿐이다
    expect(screen.getAllByText(/^DNA \[/)).toHaveLength(1);
  });

  it('expansion is seeded with roots and types that have samples; search expands everything', async () => {
    const tree = await treeFixture();
    expect(seedInitialExpansion(tree, false)).toEqual(
      new Set(['sampleRoot:local', 'sampleRoot:global', 'sampleType:local:DNA', 'sampleType:global:Reagent']),
    );
    expect(seedInitialExpansion(tree, true).size).toBe(collectAllIds(tree).size);
  });

  it('search matches ID, alias, every description and storage location, debounced 200 ms', async () => {
    expect(SAMPLE_SEARCH_MS).toBe(200);
    const th = host();
    mount(th);
    await findRow(/DNA-1/);
    await findRow(/Reagent-7/);
    vi.useFakeTimers();
    fireEvent.change(screen.getByPlaceholderText(coreT('Search samples')), { target: { value: 'B3' } });
    act(() => vi.advanceTimersByTime(SAMPLE_SEARCH_MS - 1));
    expect(row(/DNA-1/)).toBeTruthy();
    expect(row(/Reagent-7/)).toBeTruthy();
    act(() => vi.advanceTimersByTime(1));
    expect(row(/DNA-1/)).toBeTruthy();
    expect(screen.queryByRole('treeitem', { name: /Reagent-7/ })).toBeNull();
    // 찾는 동안에는 남은 것을 모두 펼친다: 견본의 세부 줄이 보인다
    expect(screen.getByText(t('samples.detail.location', 'Freezer A / B3'))).toBeTruthy();
    for (const [q, shown] of [
      ['puc', /DNA-1/],
      ['polymerase', /Reagent-7/],
      ['reagent-7', /Reagent-7/],
    ] as const) {
      fireEvent.change(screen.getByPlaceholderText(coreT('Search samples')), { target: { value: q } });
      act(() => vi.advanceTimersByTime(SAMPLE_SEARCH_MS));
      expect(row(shown)).toBeTruthy();
      expect(screen.getAllByRole('treeitem').filter((li) => /^(DNA|Reagent)-\d/.test(li.textContent ?? ''))).toHaveLength(1);
    }
  });

  it('right-click a sample lists the plugin menu without partbank items', async () => {
    const tree = await treeFixture();
    const local = findNode(tree, 'sample:local:DNA:DNA-1');
    const globalDiscarded = findNode(tree, 'sample:global:Reagent:Reagent-7');
    expect(sampleMenuItems(local, LOCAL, GLOBAL)).toEqual([
      'show', 'copyId', 'insertReference', 'usages', 'edit', 'moveGlobal', 'changeType', 'discard', 'delete',
    ]);
    expect(sampleMenuItems(globalDiscarded, LOCAL, GLOBAL)).toEqual([
      'show', 'copyId', 'insertReference', 'usages', 'edit', 'moveLocal', 'changeType', 'undiscard', 'delete',
    ]);
    expect(sampleMenuItems(globalDiscarded, GLOBAL, GLOBAL)).not.toContain('moveLocal'); // #159
    expect(typeMenuItems(findNode(tree, 'sampleType:local:DNA'))).toEqual(['addSample']);
    expect(typeMenuItems(findNode(tree, 'sampleRoot:local'))).toEqual([]);

    const th = host();
    mount(th);
    fireEvent.contextMenu(await findRow(/DNA-1/));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getAllByRole('menuitem').map((m) => m.textContent)).toEqual([
      coreT('Show sample definition'),
      coreT('Copy sample ID'),
      coreT('Insert reference'),
      coreT('View usages'),
      coreT('Edit sample'),
      coreT('Move to Global'),
      coreT('Change type'),
      coreT('Mark as discarded'),
      coreT('Delete sample'),
    ]);
  });

  it('Add sample on a type node creates the sample in the folder the tree shows', async () => {
    const th = host();
    th.setActive(NOTE);
    th.answer.prompt('ladder', '', '');
    mount(th);
    fireEvent.contextMenu(await findRow('DNA [1]'));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getAllByRole('menuitem').map((m) => m.textContent)).toEqual([coreT('Add sample')]);
    fireEvent.click(within(menu).getByRole('menuitem', { name: coreT('Add sample') }));
    await waitFor(async () => expect(await th.host.fs.read(`${LOCAL}/DNA.json`)).toContain('ladder'));
    // 쓴 뒤 패널이 다시 읽는다(env.changed → sampleEvents)
    expect(await findRow('DNA [2]')).toBeTruthy();
  });

  it('View usages opens a picker of spots, or says the sample is unused', async () => {
    const th = host();
    th.answer.pick(undefined);
    await showUsages(createSampleEnv(th.ctx), LOCAL, { type: 'DNA', id: 'DNA-1' });
    expect(th.asked.pick[0].opts?.title).toBe(coreT('Notes using {0} ({1})', 'DNA-1', '1'));
    expect(th.asked.pick[0].items.every((i) => i.label === NOTE)).toBe(true);
    await showUsages(createSampleEnv(th.ctx), GLOBAL, { type: 'Reagent', id: 'Reagent-900' });
    expect(th.notes.at(-1)!.message).toBe(coreT('{0} is not used in any note.', 'Reagent-900'));
  });

  it('picking a usage opens the note at its line', async () => {
    const th = host();
    const open = vi.spyOn(th.ctx, 'openFile');
    th.answer.pick((items) => items.at(-1)!.value);
    await showUsages(createSampleEnv(th.ctx), LOCAL, { type: 'DNA', id: 'DNA-1' });
    const spot = th.asked.pick[0].items.at(-1)!.value as { path: string; line: number; ch: number };
    expect(spot.line).toBe(4);
    expect(open).toHaveBeenLastCalledWith(NOTE, { line: 4, ch: spot.ch });
  });

  it('Insert reference of a discarded sample notes the discard date', async () => {
    const th = host();
    const m = await th.mount(NOTE);
    mount(th);
    fireEvent.contextMenu(await findRow(/Reagent-7/));
    fireEvent.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: coreT('Insert reference') }));
    await waitFor(() => expect(th.notes.map((n) => n.message)).toContain(coreT('{0} was marked discarded on {1}.', 'Reagent-7', '2026-10-01')));
    await waitFor(() => expect(m.view().state.doc.toString()).toContain('Reagent-7;Taq'));
  });

  it('Insert reference without an open note says to open one', async () => {
    const th = host();
    mount(th);
    fireEvent.contextMenu(await findRow(/DNA-1/));
    fireEvent.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: coreT('Insert reference') }));
    await waitFor(() => expect(th.notes.at(-1)?.message).toBe(coreT('Open a note to insert into.')));
  });

  it('Shift+F10 opens the menu; Copy sample ID writes the clipboard', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const th = host();
    mount(th);
    const dna = await findRow(/DNA-1/);
    dna.focus();
    fireEvent.keyDown(dna, { key: 'F10', shiftKey: true });
    const menu = await screen.findByRole('menu');
    fireEvent.click(within(menu).getByRole('menuitem', { name: coreT('Copy sample ID') }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('DNA-1'));
    await waitFor(() => expect(th.notes.map((n) => n.message)).toContain(coreT('Copied: {0}', 'DNA-1')));
  });

  it('refreshes on sampleEvents and on registry watcher events', async () => {
    expect(SAMPLE_PANEL_REFRESH_MS).toBe(300);
    const th = host();
    samples.configure(th.host.fs, th.ctx.settings);
    mount(th);
    expect(await screen.findByText('DNA [1]')).toBeTruthy();
    const rec = (ids: string[]) =>
      JSON.stringify(Object.fromEntries(ids.map((id) => [id, { type: 'DNA', descriptions: [], sources: [] }])));
    await th.host.fs.write(`${LOCAL}/DNA.json`, rec(['DNA-1', 'DNA-2']));
    act(() => sampleEvents.emit([LOCAL]));
    expect(await screen.findByText('DNA [2]')).toBeTruthy();
    await th.host.fs.write(`${LOCAL}/DNA.json`, rec(['DNA-1', 'DNA-2', 'DNA-3']));
    act(() => samples.vaultChanged([`${LOCAL}/DNA.json`]));
    expect(await screen.findByText('DNA [3]')).toBeTruthy();
  });

  it('type nodes carry the swatch class, no style attribute', async () => {
    const th = host();
    const { container } = mount(th);
    const dna = await findRow('DNA [1]');
    expect(dna.querySelector('.sample-swatch.lno-sample-t-dna')).toBeTruthy();
    expect(row('Reagent [1]').querySelector('.sample-swatch.lno-sample-t-reagent')).toBeTruthy();
    expect(container.querySelector('[style]')).toBeNull();
  });

  it('an experiment with sample_tracking: no still shows its trees', async () => {
    const th = host();
    mount(th, 'labnote/062_Gel/001_run.labnote.md');
    expect(await screen.findByText(t('samples.root.global'))).toBeTruthy();
    expect(screen.getByText(t('samples.root.local'))).toBeTruthy();
  });

  it('the global switch off replaces the tree with the plugin sentence', async () => {
    const th = host(SAMPLE_VAULT, { sampleTracking: false });
    mount(th);
    expect(await screen.findByText(coreT('Sample tracking is turned off in {0}.', t('cmd.sampleSettings')))).toBeTruthy();
    expect(screen.queryByRole('tree')).toBeNull();
  });

  it('open-sample-view shows the Samples tab', async () => {
    const th = host();
    const cmd = sampleCommands.find((c) => c.id === 'open-sample-view')!;
    expect(cmd.nameKey).toBe('Open sample view');
    await cmd.run(th.ctx);
    expect(th.panels).toEqual(['samples']);
  });
});
