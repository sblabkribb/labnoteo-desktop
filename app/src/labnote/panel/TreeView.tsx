import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import type { TreeNode } from '@labnoteo/core';
import { treeKeyAction, type KeyRow } from '../../../vendor/labnoteo/src/views/treeKeys';
import type { MenuAnchor } from '../ui/menuStore';
import { iconClass } from './treeIcons';
import { depthAttrs } from '../../tree/depth';


interface Row extends KeyRow {
  node: TreeNode;
  /** 뿌리부터의 id 경로: 같은 노드가 여러 묶음에 나와도(저자별) 줄마다 다르다. */
  key: string;
  depth: number;
}

export interface TreeViewProps {
  nodes: readonly TreeNode[];
  /** 트리의 접근 가능한 이름. */
  label: string;
  /** 펼친 노드의 id. */
  expanded: ReadonlySet<string>;
  onToggle(id: string, open: boolean): void;
  /** 클릭, Enter, Space. 묶음 노드는 그 전에 접히거나 펼쳐진다. */
  onActivate(node: TreeNode): void;
  /** 우클릭, 메뉴 키, Shift+F10. */
  onContext?(node: TreeNode, anchor: MenuAnchor): void;
  /** 지금 열린 노트에 해당하는 노드(aria-current). */
  isCurrent?(node: TreeNode): boolean;
  /** false 면 클릭·Enter 가 묶음 노드를 접거나 펼치지 않는다(화살표만). 개요 패널은 제목으로 옮기기만 한다. 기본 true. */
  toggleOnActivate?: boolean;
  /** true 면 현재 줄(isCurrent)이 바뀔 때 그 줄을 보이게 스크롤한다(block: 'nearest'). 초점은 옮기지 않는다. 개요 패널. */
  scrollCurrent?: boolean;
  /** 목록(role=tree)의 클래스. 기본은 워크플로 패널의 'wf-tree', 노트 트리는 'plain-list note-tree'. */
  className?: string;
}

function flatten(nodes: readonly TreeNode[], expanded: ReadonlySet<string>): Row[] {
  const rows: Row[] = [];
  const walk = (list: readonly TreeNode[], depth: number, parent: number, prefix: string) => {
    for (const node of list) {
      const hasChildren = (node.children?.length ?? 0) > 0;
      const open = hasChildren && expanded.has(node.id);
      const key = `${prefix}/${node.id}`;
      rows.push({ node, key, depth, parent, hasChildren, expanded: open });
      if (open) walk(node.children!, depth + 1, rows.length - 1, key);
    }
  };
  walk(nodes, 0, -1, '');
  return rows;
}

/** 숨은(접힌 부모 아래) 현재 노드의 보이는 가장 가까운 조상 줄. 현재 노드가 없으면 undefined. */
function visibleAncestorKey(nodes: readonly TreeNode[], rows: readonly Row[], isCurrent: (node: TreeNode) => boolean): string | undefined {
  const find = (list: readonly TreeNode[], prefix: string): string[] | undefined => {
    for (const node of list) {
      const key = `${prefix}/${node.id}`;
      if (isCurrent(node)) return [key];
      const below = node.children ? find(node.children, key) : undefined;
      if (below) return [key, ...below];
    }
    return undefined;
  };
  const path = find(nodes, '');
  if (!path) return undefined;
  const visible = new Set(rows.map((r) => r.key));
  for (let i = path.length - 1; i >= 0; i--) if (visible.has(path[i])) return path[i];
  return undefined;
}

/**
 * 코어 TreeNode 를 그리는 트리(role=tree). 펼친 줄만 그리는 평평한 목록이고 각 줄이 treeitem 이다(aria-level).
 * - 키보드는 vendor 의 treeKeyAction(WAI-ARIA 트리 패턴)을 따른다. 탭 정지는 한 줄(roving tabindex).
 * - 들여쓰기는 data-depth(app.css 의 NoteTree 와 같은 규칙), 아이콘은 TREE_ICON_CLASS, tooltip 은 title. color 는 쓰지 않는다.
 */
export function TreeView({ nodes, label, expanded, onToggle, onActivate, onContext, isCurrent, toggleOnActivate = true, scrollCurrent = false, className = 'wf-tree' }: TreeViewProps) {
  const rows = useMemo(() => flatten(nodes, expanded), [nodes, expanded]);
  const [focusKey, setFocusKey] = useState<string>();
  const refs = useRef(new Map<string, HTMLLIElement>());
  /** 키보드로 옮긴 초점: 다시 그린 뒤 그 줄에 초점을 준다. */
  const moveFocus = useRef(false);
  const tabStop = rows.some((r) => r.key === focusKey) ? focusKey : rows[0]?.key;

  useEffect(() => {
    if (!moveFocus.current || tabStop === undefined) return;
    moveFocus.current = false;
    refs.current.get(tabStop)?.focus();
  }, [tabStop, rows]);

  const visibleCurrent = isCurrent ? rows.find((r) => isCurrent(r.node))?.key : undefined;
  // scrollCurrent(개요): 현재 노드가 접힌 부모 아래 숨어 있으면 보이는 가장 가까운 조상을 대신 표시하고 스크롤한다.
  const currentKey = scrollCurrent && isCurrent && visibleCurrent === undefined ? visibleAncestorKey(nodes, rows, isCurrent) : visibleCurrent;
  useEffect(() => {
    if (!scrollCurrent || currentKey === undefined) return;
    // jsdom 에는 scrollIntoView 가 없다. focus() 는 부르지 않는다.
    refs.current.get(currentKey)?.scrollIntoView?.({ block: 'nearest' });
  }, [scrollCurrent, currentKey]);

  const activate = (row: Row) => {
    setFocusKey(row.key);
    if (row.hasChildren && toggleOnActivate) onToggle(row.node.id, !row.expanded);
    onActivate(row.node);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLLIElement>, index: number) => {
    const row = rows[index];
    const action = treeKeyAction(rows, index, { key: e.key, shiftKey: e.shiftKey });
    if (!action) return;
    e.preventDefault();
    e.stopPropagation();
    switch (action.kind) {
      case 'focus':
        moveFocus.current = true;
        setFocusKey(rows[action.index].key);
        break;
      case 'expand':
        onToggle(row.node.id, true);
        break;
      case 'collapse':
        onToggle(row.node.id, false);
        break;
      case 'activate':
        activate(row);
        break;
      case 'menu':
        onContext?.(row.node, { element: e.currentTarget });
        break;
    }
  };

  const onContextMenu = (e: MouseEvent<HTMLLIElement>, row: Row) => {
    if (!onContext) return;
    e.preventDefault();
    setFocusKey(row.key);
    onContext(row.node, { x: e.clientX, y: e.clientY });
  };

  return (
    <ul role="tree" aria-label={label} className={className}>
      {rows.map((row, i) => {
        const { className: deep, ...depth } = depthAttrs(row.depth);
        const rowClass = ['wf-tree-row', row.node.dimmed ? 'dimmed' : '', deep ?? ''].filter(Boolean).join(' ');
        return (
          <li
            key={row.key}
            ref={(el) => {
              if (el) refs.current.set(row.key, el);
              else refs.current.delete(row.key);
            }}
            role="treeitem"
            aria-level={row.depth + 1}
            aria-expanded={row.hasChildren ? row.expanded : undefined}
            aria-current={(scrollCurrent ? row.key === currentKey : isCurrent?.(row.node)) ? 'true' : undefined}
            {...depth}
            tabIndex={row.key === tabStop ? 0 : -1}
            title={row.node.tooltip}
            className={rowClass}
            onClick={() => activate(row)}
            onKeyDown={(e) => onKeyDown(e, i)}
            onContextMenu={(e) => onContextMenu(e, row)}
            onFocus={(e) => {
              if (e.target === e.currentTarget) setFocusKey(row.key);
            }}
          >
            <span className={`tree-icon ${iconClass(row.node.icon)}`} aria-hidden="true" />
            <span className="wf-tree-label">{row.node.label}</span>
          </li>
        );
      })}
    </ul>
  );
}
