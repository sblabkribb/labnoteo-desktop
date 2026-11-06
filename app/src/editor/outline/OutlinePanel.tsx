import { useMemo, useState } from 'react';
import type { TreeNode } from '@labnoteo/core';
import { t } from '../../i18n/t';
import { TreeView } from '../../labnote/panel/TreeView';
import { currentItem, toTree } from './extract';
import { useOutline } from './outlineStore';

export interface OutlinePanelProps {
  /** 제목을 고르면: 그 노트와 제목 줄(0부터). */
  onReveal(path: string, line0: number): void;
}

/**
 * 사이드바의 개요 탭: 열린 노트의 제목 트리(`### [UHW010 …]` 포함). 제목을 고르면(클릭, Enter, Space) 편집기 커서를
 * 그 제목 줄로 옮긴다. 커서가 든 제목은 aria-current 로 표시한다. 묶음은 처음에 모두 펼쳐 있고 화살표로만 접는다.
 */
export function OutlinePanel({ onReveal }: OutlinePanelProps) {
  const outline = useOutline();
  const items = useMemo(() => outline?.items ?? [], [outline?.items]);
  const nodes = useMemo(() => toTree(items), [items]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const expanded = useMemo(() => {
    const open = new Set<string>();
    const walk = (list: readonly TreeNode[]) => {
      for (const n of list) {
        if (!n.children?.length) continue;
        if (!collapsed.has(n.id)) open.add(n.id);
        walk(n.children);
      }
    };
    walk(nodes);
    return open;
  }, [nodes, collapsed]);
  const current = outline ? currentItem(items, outline.cursorLine) : undefined;

  if (!outline || items.length === 0) return <p>{t('outline.empty')}</p>;
  const path = outline.path;
  return (
    <TreeView
      nodes={nodes}
      label={t('outline.label')}
      expanded={expanded}
      toggleOnActivate={false}
      onToggle={(id, open) =>
        setCollapsed((prev) => {
          const next = new Set(prev);
          if (open) next.delete(id);
          else next.add(id);
          return next;
        })
      }
      onActivate={(node) => onReveal(path, Number(node.id) - 1)}
      isCurrent={(node) => current !== undefined && node.id === String(current.line)}
    />
  );
}
