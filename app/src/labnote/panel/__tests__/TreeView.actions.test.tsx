// @vitest-environment jsdom
/**
 * 줄의 작은 단추(TreeAction)를 키보드로도: 단추는 탭 정지가 아니지만(줄 하나만 탭 정지), 줄에 초점이 있을 때 보인다.
 * 그래서 단추에 키(`key`)가 있으면 그 줄에서 그 키가 단추를 누르고, 줄과 단추가 aria-keyshortcuts 로 알린다.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { TreeNode } from '@labnoteo/core';
import { TreeView, type TreeAction } from '../TreeView';

afterEach(cleanup);

const NODES: TreeNode[] = [
  { id: 'a', label: 'Alpha', kind: 'sampleType', icon: 'beaker' },
  { id: 'b', label: 'Beta', kind: 'sample', icon: 'beaker' },
];

const base = { nodes: NODES, label: 'tree', expanded: new Set<string>(), onToggle: () => undefined, onActivate: () => undefined };

function mount(withKey: boolean) {
  const run = vi.fn();
  const actions = (n: TreeNode): TreeAction[] | undefined =>
    n.id === 'a' ? [{ icon: 'plus', label: 'Add', run, ...(withKey ? { key: '+' } : {}) }] : undefined;
  render(<TreeView {...base} actions={actions} />);
  const [a, b] = screen.getAllByRole('treeitem');
  return { run, a, b };
}

describe('TreeView row actions from the keyboard', () => {
  it('"+" on a focused row runs the action that carries that key, and says so with aria-keyshortcuts', () => {
    const { run, a } = mount(true);
    a.focus();
    fireEvent.keyDown(a, { key: '+', shiftKey: true });
    expect(run).toHaveBeenCalledTimes(1);
    expect(a.getAttribute('aria-keyshortcuts')).toBe('+');
    expect(screen.getByRole('button', { name: 'Add', hidden: true }).getAttribute('aria-keyshortcuts')).toBe('+');
  });

  it('Ctrl/Alt/Meta with "+" stays with the app (zoom), and rows without the action ignore it', () => {
    const { run, a, b } = mount(true);
    fireEvent.keyDown(a, { key: '+', ctrlKey: true });
    fireEvent.keyDown(a, { key: '+', altKey: true });
    fireEvent.keyDown(a, { key: '+', metaKey: true });
    fireEvent.keyDown(b, { key: '+' });
    expect(run).not.toHaveBeenCalled();
    expect(b.hasAttribute('aria-keyshortcuts')).toBe(false);
  });

  it('an action without a key is not run by any key, and the row has no aria-keyshortcuts', () => {
    const { run, a } = mount(false);
    fireEvent.keyDown(a, { key: '+' });
    expect(run).not.toHaveBeenCalled();
    expect(a.hasAttribute('aria-keyshortcuts')).toBe(false);
  });
});
