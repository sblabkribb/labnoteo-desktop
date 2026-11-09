// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import type { TreeNode } from '@labnoteo/core';
import { TreeView, rowTitle } from '../TreeView';

const node = (label: string, tooltip?: string): TreeNode => ({ id: label, label, kind: 'category', icon: 'file', ...(tooltip ? { tooltip } : {}) });

describe('트리 줄의 title: 말줄임으로 잘린 이름도 전체를 본다', () => {
  it('tooltip 이 없으면 이름 자체가 title 이다', () => {
    expect(rowTitle(node('WF-001: 아주 긴 워크플로 이름'))).toBe('WF-001: 아주 긴 워크플로 이름');
  });

  it('이름이 이미 든 tooltip 은 그대로 둔다', () => {
    expect(rowTitle(node('report.md', 'report.md'))).toBe('report.md');
  });

  it('이름이 없는 tooltip(설명 등) 앞에는 이름 줄을 붙인다', () => {
    expect(rowTitle(node('WF-001: PCR', 'Amplify the insert'))).toBe('WF-001: PCR\nAmplify the insert');
  });

  it('모든 treeitem 이 이름을 담은 title 을 단다 (워크플로·샘플·개요 트리 포함)', () => {
    const nodes = [node('Samples [3]'), node('WF-002: Gibson assembly of a very long name', 'Assemble fragments')];
    render(<TreeView nodes={nodes} label="tree" expanded={new Set()} onToggle={() => {}} onActivate={() => {}} />);
    for (const item of screen.getAllByRole('treeitem')) {
      const label = item.querySelector('.wf-tree-label')!.textContent!;
      expect(item.getAttribute('title')).toContain(label);
    }
  });
});
