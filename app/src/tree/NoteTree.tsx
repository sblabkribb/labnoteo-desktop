import { useMemo, useState } from 'react';
import { t } from '../i18n/t';
import type { TreeEntry } from './useTree';

interface Props {
  entries: TreeEntry[];
  /** 지금 열려 있는 노트의 vault-relative 경로. 철자의 대소문자는 달라도 된다. */
  selected?: string;
  onSelect: (path: string) => void;
}

/**
 * NTFS 는 대소문자를 구분하지 않으므로 `Note.md` 와 `note.md` 는 한 파일이다.
 * 접힘 상태와 선택 비교는 이 키로 하고, 화면에 그리는 경로와 `onSelect` 로 넘기는
 * 경로는 걸음이 디스크에서 읽은 철자 그대로다.
 */
const fold = (path: string) => path.toLowerCase();

/** app.css 가 들여쓰기를 정해 둔 가장 깊은 단계. */
const MAX_DEPTH = 24;

export function NoteTree({ entries, selected, onSelect }: Props) {
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

  const selectedKey = selected === undefined ? undefined : fold(selected);
  return (
    <nav aria-label={t('tree.label')}>
      <ul className="plain-list">
        {visible.map((e) => {
          return (
            <li key={fold(e.path)} data-depth={Math.min(e.depth, MAX_DEPTH)}>
              {e.isDir ? (
                <button type="button" aria-expanded={!collapsed.has(fold(e.path))} onClick={() => toggle(e.path)}>
                  {e.name}
                </button>
              ) : (
                <button
                  type="button"
                  aria-current={fold(e.path) === selectedKey ? 'true' : undefined}
                  onClick={() => onSelect(e.path)}
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
