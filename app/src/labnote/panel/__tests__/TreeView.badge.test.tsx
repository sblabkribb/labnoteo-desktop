// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import type { TreeNode } from '@labnoteo/core';
import { TreeView } from '../TreeView';

afterEach(cleanup);

const NODES: TreeNode[] = [
  { id: 'a', label: 'Alpha', kind: 'experiment', icon: 'beaker' },
  { id: 'b', label: 'Beta', kind: 'experiment', icon: 'beaker' },
];

const base = { nodes: NODES, label: 'tree', expanded: new Set<string>(), onToggle: () => undefined, onActivate: () => undefined };

describe('TreeView badge slot', () => {
  it('draws the badge after the label and the code chip, as a labelled image', () => {
    const { container } = render(
      <TreeView {...base} code={(n) => (n.id === 'a' ? 'WB030' : undefined)} badge={(n) => (n.id === 'a' ? { icon: 'cloud-check', label: 'GitHub에 올라가 있음' } : undefined)} />,
    );
    const rows = container.querySelectorAll('li');
    const badge = rows[0].querySelector('.tree-badge')!;
    expect(badge.getAttribute('role')).toBe('img');
    expect(badge.getAttribute('aria-label')).toBe('GitHub에 올라가 있음');
    expect(badge.getAttribute('title')).toBe('GitHub에 올라가 있음');
    expect(badge.getAttribute('data-icon')).toBe('cloud-check');
    expect(badge.querySelector('svg')).toBeTruthy();
    const kids = [...rows[0].children];
    expect(kids.indexOf(badge)).toBeGreaterThan(kids.indexOf(rows[0].querySelector('.wf-tree-label')!));
    expect(kids.indexOf(badge)).toBeGreaterThan(kids.indexOf(rows[0].querySelector('.meta.code')!));
    expect(rows[1].querySelector('.tree-badge')).toBeNull();
    expect(container.querySelector('[style]')).toBeNull();
  });

  it('without badge the tree renders exactly as before', () => {
    const a = render(<TreeView {...base} />).container.innerHTML;
    cleanup();
    const b = render(<TreeView {...base} badge={() => undefined} />).container.innerHTML;
    expect(b).toBe(a);
    expect(a).not.toContain('tree-badge');
  });
});
