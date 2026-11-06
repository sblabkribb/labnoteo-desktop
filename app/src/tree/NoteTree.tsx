import { useMemo, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { t } from '../i18n/t';
import type { TreeEntry } from './useTree';

interface Props {
  entries: TreeEntry[];
  /** 지금 열려 있는 노트의 vault-relative 경로. 철자의 대소문자는 달라도 된다. */
  selected?: string;
  onSelect: (path: string) => void;
  /**
   * 줄의 맥락 메뉴를 연다: 오른쪽 클릭(누른 좌표), 또는 Shift+F10 / 메뉴 키(그 줄의 단추 아래). 없으면 기본 동작 그대로.
   */
  onContextMenu?: (entry: TreeEntry, anchor: { x: number; y: number } | { element: Element }) => void;
}

/**
 * NTFS 는 대소문자를 구분하지 않으므로 `Note.md` 와 `note.md` 는 한 파일이다.
 * 접힘 상태와 선택 비교는 이 키로 하고, 화면에 그리는 경로와 `onSelect` 로 넘기는
 * 경로는 걸음이 디스크에서 읽은 철자 그대로다.
 */
const fold = (path: string) => path.toLowerCase();

/** app.css 가 들여쓰기를 정해 둔 가장 깊은 단계. */
const MAX_DEPTH = 24;

export function NoteTree({ entries, selected, onSelect, onContextMenu }: Props) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

  const visible = useMemo(() => {
    const rows: TreeEntry[] = [];
    let hiddenBelow: number | null = null;
    for (const e of entries) {
      if (hiddenBelow !== null) {
        if (e.depth > hiddenBelow) continue;
        hiddenBelow = null;
      }
      rows.push(e);
      if (e.isDir && collapsed.has(fold(e.path))) hiddenBelow = e.depth;
    }
    return rows;
  }, [entries, collapsed]);

  function toggle(path: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      const key = fold(path);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }

  if (entries.length === 0) return <p>{t('tree.empty')}</p>;

  const menuHandlers = (e: TreeEntry) =>
    onContextMenu
      ? {
          onContextMenu: (ev: MouseEvent<HTMLButtonElement>) => {
            ev.preventDefault();
            // 키보드가 만든 사건은 좌표가 (0, 0) 이다: 줄 아래에 연다
            const fromKeyboard = ev.clientX === 0 && ev.clientY === 0;
            onContextMenu(e, fromKeyboard ? { element: ev.currentTarget } : { x: ev.clientX, y: ev.clientY });
          },
          onKeyDown: (ev: KeyboardEvent<HTMLButtonElement>) => {
            if (ev.key === 'ContextMenu' || (ev.key === 'F10' && ev.shiftKey)) {
              ev.preventDefault();
              onContextMenu(e, { element: ev.currentTarget });
            }
          },
        }
      : {};

  const selectedKey = selected === undefined ? undefined : fold(selected);
  return (
    <nav aria-label={t('tree.label')}>
      <ul className="plain-list">
        {visible.map((e) => {
          return (
            <li key={fold(e.path)} data-depth={Math.min(e.depth, MAX_DEPTH)}>
              {e.isDir ? (
                <button
                  type="button"
                  title={e.name}
                  aria-expanded={!collapsed.has(fold(e.path))}
                  onClick={() => toggle(e.path)}
                  {...menuHandlers(e)}
                >
                  {e.name}
                </button>
              ) : (
                <button
                  type="button"
                  title={e.name}
                  aria-current={fold(e.path) === selectedKey ? 'true' : undefined}
                  onClick={() => onSelect(e.path)}
                  {...menuHandlers(e)}
                >
                  {e.name}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
