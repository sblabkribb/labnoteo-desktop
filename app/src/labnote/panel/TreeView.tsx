import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import type { TreeNode } from '@labnoteo/core';
import { treeKeyAction, type KeyRow } from '../../../vendor/labnoteo/src/views/treeKeys';
import type { MenuAnchor } from '../ui/menuStore';
import { treeIcon } from './treeIcons';
import { depthAttrs } from '../../tree/depth';
import { Icon, type IconName } from '../../ui/Icon';

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
  /** 줄의 아이콘 뒤에 그릴 표시(견본)의 클래스. 없으면 그리지 않는다. 색은 styles/tokens.css 의 토큰으로만 칠한다(Samples 패널의 종류 색). */
  nodeClass?(node: TreeNode): string | undefined;
  /** 줄(treeitem) 자체에 더할 클래스. 파일 탭은 앱 안 보기 화면이 없는 첨부에 'dim' 을 단다. */
  rowClass?(node: TreeNode): string | undefined;
  /** 이름 뒤 오른쪽에 붙는 흐린 덧말(개수 등, 괄호 없이). 없으면 그리지 않는다. */
  meta?(node: TreeNode): string | undefined;
  /** 줄 이름 대신 그릴 것(찾기의 <mark> 칠하기). 없으면 node.label. */
  renderLabel?(node: TreeNode): ReactNode;
  /** 이름 뒤 오른쪽에 붙는 흐린 고정폭 코드(WB030, UHW250). 덧말보다 앞이다. */
  code?(node: TreeNode): ReactNode | undefined;
  /** 아이콘 뒤의 상태 모양. onClick 이 있으면 단추(줄을 열지 않는다), 없으면 이름이 붙은 그림이다. */
  state?(node: TreeNode): TreeState | undefined;
  /** 줄에 커서를 올리면 보이는 작은 단추들(마우스용: 탭 정지가 아니다. 같은 일은 줄과 메뉴로도 한다). */
  actions?(node: TreeNode): TreeAction[] | undefined;
  /** 이 id 의 줄로 초점을 옮기고 보이게 스크롤한다. seq 마다 한 번, 그 줄이 그려진 뒤에(조상이 펼쳐지길 기다린다). */
  focusRequest?: { id: string; seq: number };
}

export interface TreeState {
  icon: IconName;
  label: string;
  onClick?: () => void;
}

export interface TreeAction {
  icon: IconName;
  label: string;
  run: () => void;
}

/**
 * 줄의 title. 이름은 좁은 사이드바에서 말줄임으로 잘리므로 title 이 늘 전체 이름을 담는다:
 * tooltip 이 없으면 이름, 이름이 든 tooltip 은 그대로, 설명뿐인 tooltip 이면 이름 줄을 앞에 붙인다.
 */
export function rowTitle(node: TreeNode): string {
  const tip = node.tooltip;
  if (!tip) return node.label;
  return tip.includes(node.label) ? tip : `${node.label}
${tip}`;
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
 * - 줄: [접기 표시 14][아이콘 16][이름 …][덧말]. 접기 표시와 아이콘은 Lucide(ui/Icon.tsx, treeIcon 이 이름을 고른다)이고 장식이다.
 *   자식이 없는 줄도 접기 자리를 비워 두어 아이콘이 한 줄로 선다.
 * - 들여쓰기는 data-depth(styles/tree.css), 들여쓰기 안내선은 독에 커서나 초점이 있을 때만 보인다. tooltip 은 title. color 는 쓰지 않는다.
 */
export function TreeView({ nodes, label, expanded, onToggle, onActivate, onContext, isCurrent, toggleOnActivate = true, scrollCurrent = false, className = 'wf-tree', nodeClass, rowClass: extraClass, meta, renderLabel, code, state, actions, focusRequest }: TreeViewProps) {
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

  const handledFocus = useRef<number>();
  useEffect(() => {
    if (!focusRequest || handledFocus.current === focusRequest.seq) return;
    const row = rows.find((r) => r.node.id === focusRequest.id);
    if (!row) return; // 아직 접힌 부모 아래: 펼친 뒤 다시 본다
    handledFocus.current = focusRequest.seq;
    setFocusKey(row.key);
    const el = refs.current.get(row.key);
    el?.scrollIntoView?.({ block: 'nearest' });
    el?.focus();
  }, [focusRequest, rows]);

  const activate = (row: Row) => {
    setFocusKey(row.key);
    if (row.hasChildren && toggleOnActivate) onToggle(row.node.id, !row.expanded);
    onActivate(row.node);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLLIElement>, index: number) => {
    // Alt/Ctrl/Meta+arrow belongs to the app (Alt+←/→ is back and forward): never take it as tree movement.
    if ((e.altKey || e.ctrlKey || e.metaKey) && /^(Arrow|Home$|End$)/.test(e.key)) return;
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
        const rowClass = ['wf-tree-row', row.node.dimmed ? 'dimmed' : '', deep ?? '', extraClass?.(row.node) ?? ''].filter(Boolean).join(' ');
        const mark = nodeClass?.(row.node);
        const icon = treeIcon(row.node.icon, row.expanded);
        const note = meta?.(row.node);
        const codeText = code?.(row.node);
        const shape = state?.(row.node);
        const buttons = actions?.(row.node) ?? [];
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
            title={rowTitle(row.node)}
            className={rowClass}
            onClick={() => activate(row)}
            onKeyDown={(e) => onKeyDown(e, i)}
            onContextMenu={(e) => onContextMenu(e, row)}
            onFocus={(e) => {
              if (e.target === e.currentTarget) setFocusKey(row.key);
            }}
          >
            <span className="tree-chevron" aria-hidden="true">
              {row.hasChildren && <Icon name="chevron-right" size={14} />}
            </span>
            {icon ? <Icon name={icon} className={`tree-icon ti-${row.node.icon}`} /> : <span className="tree-icon" aria-hidden="true" />}
            {mark && <span className={mark} aria-hidden="true" />}
            {shape &&
              (shape.onClick ? (
                <button
                  type="button"
                  className="tree-state"
                  data-icon={shape.icon}
                  tabIndex={-1}
                  aria-label={shape.label}
                  title={shape.label}
                  onClick={(e) => {
                    e.stopPropagation();
                    shape.onClick!();
                  }}
                >
                  <Icon name={shape.icon} size={14} />
                </button>
              ) : (
                <span className="tree-state" data-icon={shape.icon} role="img" aria-label={shape.label} title={shape.label}>
                  <Icon name={shape.icon} size={14} />
                </span>
              ))}
            <span className="wf-tree-label">{renderLabel ? renderLabel(row.node) : row.node.label}</span>
            {codeText !== undefined && codeText !== '' && <span className="meta code">{codeText}</span>}
            {note && <span className="tree-meta">{note}</span>}
            {buttons.length > 0 && (
              <span className="tree-actions">
                {buttons.map((b) => (
                  <button
                    key={b.label}
                    type="button"
                    className="tree-action"
                    tabIndex={-1}
                    aria-label={b.label}
                    title={b.label}
                    onClick={(e) => {
                      e.stopPropagation();
                      b.run();
                    }}
                  >
                    <Icon name={b.icon} size={14} />
                  </button>
                ))}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
