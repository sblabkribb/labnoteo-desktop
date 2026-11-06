import { useEffect, useMemo, useState } from 'react';
import type { TreeNode } from '@labnoteo/core';
import { t } from '../i18n/t';
import { TreeView } from '../labnote/panel/TreeView';
import type { MenuAnchor } from '../labnote/ui/menuStore';
import type { TreeEntry } from './useTree';

interface Props {
  entries: TreeEntry[];
  /** 지금 열려 있는 노트의 vault-relative 경로. 철자의 대소문자는 달라도 된다. */
  selected?: string;
  onSelect: (path: string) => void;
  /**
   * 줄의 맥락 메뉴를 연다: 오른쪽 클릭(누른 좌표), 또는 Shift+F10 / 메뉴 키(그 줄 아래). 없으면 기본 동작 그대로.
   */
  onContextMenu?: (entry: TreeEntry, anchor: MenuAnchor) => void;
}

/**
 * NTFS 는 대소문자를 구분하지 않으므로 `Note.md` 와 `note.md` 는 한 파일이다.
 * 접힘 상태, 노드 id 와 선택 비교는 이 키로 하고, 화면에 그리는 이름과 `onSelect` 로 넘기는
 * 경로는 걸음이 디스크에서 읽은 철자 그대로다.
 */
const fold = (path: string) => path.toLowerCase();

/**
 * 걸음이 준 평평한 목록(깊이 포함, 부모가 자식보다 앞)을 코어 TreeNode 숲으로 엮는다. 깊이 스택으로 부모를 찾는다.
 * 폴더와 노트 모두 코어의 'category' 종류이고 아이콘으로 구분한다. payload 는 원래 줄(TreeEntry)이다.
 */
function nest(entries: readonly TreeEntry[]): TreeNode[] {
  const roots: TreeNode[] = [];
  const stack: { depth: number; node: TreeNode }[] = [];
  for (const e of entries) {
    const node: TreeNode = {
      id: fold(e.path),
      label: e.name,
      kind: 'category',
      icon: e.isDir ? 'folder' : 'file',
      tooltip: e.name, // 말줄임으로 잘린 긴 이름은 title 로 본다(경로가 아니라 이름)
      payload: e,
      ...(e.isDir ? { children: [] } : {}),
    };
    while (stack.length > 0 && stack[stack.length - 1].depth >= e.depth) stack.pop();
    const parent = stack[stack.length - 1];
    (parent ? parent.node.children! : roots).push(node);
    if (e.isDir) stack.push({ depth: e.depth, node });
  }
  return roots;
}

const entryOf = (node: TreeNode) => node.payload as TreeEntry;

/**
 * 보관함의 노트 트리. WAI-ARIA 트리(role=tree, treeitem, roving tabindex)는 TreeView 가 그린다: 화살표·Home·End 로 움직이고,
 * 왼쪽·오른쪽으로 접고 펴고, Enter·Space 로 노트를 연다. 폴더는 처음에 모두 펼쳐져 있고, 지금 열린 노트의 조상은
 * 그 노트가 열릴 때 다시 펼쳐진다.
 */
export function NoteTree({ entries, selected, onSelect, onContextMenu }: Props) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const nodes = useMemo(() => nest(entries), [entries]);
  const expanded = useMemo(
    () => new Set(entries.filter((e) => e.isDir && !collapsed.has(fold(e.path))).map((e) => fold(e.path))),
    [entries, collapsed],
  );
  const selectedKey = selected === undefined ? undefined : fold(selected);

  // 열린 노트의 조상 폴더는 펼친다: 노트를 열었는데 트리에서 그 줄이 접혀 안 보이는 일이 없게.
  useEffect(() => {
    if (selectedKey === undefined) return;
    setCollapsed((prev) => {
      const ancestors = [...prev].filter((dir) => selectedKey.startsWith(`${dir}/`));
      if (ancestors.length === 0) return prev;
      const next = new Set(prev);
      ancestors.forEach((dir) => next.delete(dir));
      return next;
    });
  }, [selectedKey]);

  if (entries.length === 0) return <p>{t('tree.empty')}</p>;

  const toggle = (id: string, open: boolean) =>
    setCollapsed((prev) => {
      if (open !== prev.has(id)) return prev;
      const next = new Set(prev);
      if (open) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <nav aria-label={t('tree.label')}>
      <TreeView
        className="plain-list note-tree"
        nodes={nodes}
        label={t('tree.label')}
        expanded={expanded}
        onToggle={toggle}
        onActivate={(node) => {
          const e = entryOf(node);
          if (!e.isDir) onSelect(e.path);
        }}
        onContext={
          onContextMenu &&
          ((node, anchor) => {
            // 메뉴 키가 만든 contextmenu 사건은 좌표가 (0, 0) 이다: 누른 점 대신 초점이 있는 줄 아래에 연다
            const el = document.activeElement;
            const fromKeyboard = 'x' in anchor && anchor.x === 0 && anchor.y === 0 && el instanceof HTMLElement;
            onContextMenu(entryOf(node), fromKeyboard ? { element: el } : anchor);
          })
        }
        isCurrent={(node) => node.id === selectedKey}
      />
    </nav>
  );
}
