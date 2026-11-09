import { readFileSync } from 'node:fs';
import { buildExperimentTree, buildWorkflowTree, type ExperimentEntry, type TreeNode } from '@labnoteo/core';
import { TREE_ICON_CLASS, iconClass } from '../treeIcons';

function icons(nodes: readonly TreeNode[], out = new Set<string>()): Set<string> {
  for (const n of nodes) {
    if (n.icon) out.add(n.icon);
    icons(n.children ?? [], out);
  }
  return out;
}

describe('TREE_ICON_CLASS', () => {
  it('every core icon name used by buildExperimentTree and buildWorkflowTree has a TREE_ICON_CLASS entry', () => {
    const e = (folder: string, more: Partial<ExperimentEntry> = {}): ExperimentEntry => ({ folder, ...more });
    const entries = [
      e('labnote/001_A', { status: 'planned' }),
      e('labnote/002_B', { status: 'bogus' }),
      e('labnote/003_C'),
      e('labnote/004_D', { discuss: true, status: 'failed' }),
      e('labnote/005_E', { frontMatterError: 'bad yaml' }),
      e('labnote/006_F', { markers: 2, project: 'P', authors: ['K'] }),
    ];
    const used = new Set<string>();
    for (const g of ['status', 'project', 'author', 'discuss'] as const) icons([buildExperimentTree(entries, {}, g)], used);
    const op = { id: 'UHW010', name: 'Op', description: 'd', equipment: 'x' };
    icons(
      buildWorkflowTree({
        workflows: [{ id: 'WD010', name: 'W', description: 'd', category: 'Design' } as never],
        hwUnitOps: [op as never],
        swUnitOps: [{ ...op, id: 'USW010', equipment: undefined, software: 's' } as never],
      }),
      used,
    );
    expect([...used].sort()).toEqual(
      ['beaker', 'comment-discussion', 'file', 'folder', 'symbol-class', 'symbol-function', 'symbol-method', 'warning'].sort(),
    );
    for (const name of used) expect(TREE_ICON_CLASS[name], name).toMatch(/^ti-/);
    expect(iconClass('no-such-icon')).toBe('ti-none');
    expect(iconClass(undefined)).toBe('ti-none');
  });

  it('every icon class draws a glyph in styles/tree.css', () => {
    const css = readFileSync('src/styles/tree.css', 'utf-8');
    for (const cls of new Set(Object.values(TREE_ICON_CLASS))) expect(css, cls).toContain(`.${cls}::before`);
  });
});
