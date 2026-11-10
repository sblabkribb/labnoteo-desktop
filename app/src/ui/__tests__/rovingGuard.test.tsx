// @vitest-environment jsdom
/**
 * Roving tabindex guard: every tablist, radiogroup and tree keeps exactly one Tab stop (tabindex=0), after mount and after
 * its active item is gone (a stale saved tab, a removed option, a deleted tree row). With none, keyboard users could not reach it.
 */
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import type { TreeNode } from '@labnoteo/core';
import { setLang } from '../../i18n/lang';
import { fromPluginData } from '../../labnote/settings';
import { TreeView } from '../../labnote/panel/TreeView';
import { Dock } from '../Dock';
import { DEFAULT_PREFS, layoutStore, type LeftTab, type RightTab } from '../layoutStore';
import { rovingStop } from '../roving';
import { RightDock } from '../RightDock';
import { Segmented } from '../Segmented';
import { SettingsModal, type SettingsDeps } from '../SettingsModal';

const invoke = vi.hoisted(() => vi.fn(async (_cmd: string, args?: { prefs?: unknown }) => args?.prefs ?? null));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

beforeEach(() => layoutStore.resetForTest());
afterEach(() => {
  cleanup();
  setLang('ko');
});

const stops = (root: ParentNode, role: string) =>
  [...root.querySelectorAll<HTMLElement>(`[role="${role}"]`)].filter((el) => el.getAttribute('tabindex') === '0');

describe('rovingStop', () => {
  it('keeps the active item when it is present, else falls back to the first, else none', () => {
    expect(rovingStop(['a', 'b'], 'b')).toBe('b');
    expect(rovingStop(['a', 'b'], 'gone')).toBe('a');
    expect(rovingStop(['a', 'b'], undefined)).toBe('a');
    expect(rovingStop([], 'a')).toBeUndefined();
  });
});

describe('exactly one tabindex=0 per roving widget', () => {
  const opts = [
    { value: 'a', label: 'A' },
    { value: 'b', label: 'B' },
    { value: 'c', label: 'C' },
  ];

  it('Segmented: after mount and after the chosen option is removed', () => {
    const { container, rerender } = render(<Segmented value="b" options={opts} onChange={() => {}} label="g" />);
    expect(stops(container, 'radio').map((x) => x.textContent)).toEqual(['B']);
    rerender(<Segmented value="b" options={opts.filter((o) => o.value !== 'b')} onChange={() => {}} label="g" />);
    expect(stops(container, 'radio').map((x) => x.textContent)).toEqual(['A']);
  });

  it('Segmented: arrows from a missing value move from the Tab stop', () => {
    const onChange = vi.fn();
    const { getByRole } = render(<Segmented value="gone" options={opts} onChange={onChange} label="g" />);
    fireEvent.keyDown(getByRole('radiogroup'), { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith('b');
    fireEvent.keyDown(getByRole('radiogroup'), { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenLastCalledWith('c');
  });

  it('Dock: after mount and with a tab that no longer exists', () => {
    const { container, rerender } = render(
      <Dock tab="experiments" onTab={() => {}} footer={null}>
        x
      </Dock>,
    );
    expect(stops(container, 'tab').map((x) => x.id)).toEqual(['sidebar-tab-experiments']);
    rerender(
      <Dock tab={'gone' as LeftTab} onTab={() => {}} footer={null}>
        x
      </Dock>,
    );
    expect(stops(container, 'tab').map((x) => x.id)).toEqual(['sidebar-tab-files']);
  });

  it('RightDock: after mount and with a tab that no longer exists', () => {
    const { container } = render(<RightDock outline={<p>o</p>} links={<p>l</p>} />);
    act(() => layoutStore.update({ ...DEFAULT_PREFS, rightOpen: true, rightTab: 'links' }));
    expect(stops(container, 'tab').map((x) => x.id)).toEqual(['sidebar-tab-links']);
    act(() => layoutStore.update({ rightTab: 'gone' as RightTab }));
    expect(stops(container, 'tab').map((x) => x.id)).toEqual(['sidebar-tab-outline']);
  });

  it('Settings tabs: after mount, and an unknown starting page falls back to the first page', () => {
    const deps = { settings: () => fromPluginData(undefined), theme: () => 'system', version: '1.0.0' } as unknown as SettingsDeps;
    const nav = () => document.querySelector<HTMLElement>('[role="tablist"]')!;
    const about = render(<SettingsModal spec={{ kind: 'settings', page: 'about', deps }} onDone={() => {}} onCancel={() => {}} />);
    expect(stops(nav(), 'tab')).toHaveLength(1);
    expect(stops(nav(), 'tab')[0].getAttribute('aria-selected')).toBe('true');
    about.unmount();
    render(<SettingsModal spec={{ kind: 'settings', page: 'gone' as 'about', deps }} onDone={() => {}} onCancel={() => {}} />);
    expect(stops(nav(), 'tab')).toHaveLength(1);
    expect(stops(nav(), 'tab')[0].getAttribute('aria-selected')).toBe('true');
    // the fallback page is shown, not an empty pane
    expect(document.querySelectorAll('[role="tabpanel"]:not([hidden])')).toHaveLength(1);
  });

  it('TreeView: after mount and after the focused row is removed', () => {
    const node = (id: string): TreeNode => ({ id, label: id, kind: 'category', icon: 'file' });
    const props = { label: 't', expanded: new Set<string>(), onToggle: () => {}, onActivate: () => {} };
    const { container, rerender } = render(<TreeView nodes={[node('a'), node('b'), node('c')]} {...props} />);
    expect(stops(container, 'treeitem')).toHaveLength(1);
    const items = container.querySelectorAll<HTMLElement>('[role="treeitem"]');
    act(() => items[0].focus());
    fireEvent.keyDown(items[0], { key: 'ArrowDown' });
    expect(stops(container, 'treeitem').map((x) => x.querySelector('.wf-tree-label')?.textContent)).toEqual(['b']);
    rerender(<TreeView nodes={[node('a'), node('c')]} {...props} />);
    expect(stops(container, 'treeitem')).toHaveLength(1);
  });
});
