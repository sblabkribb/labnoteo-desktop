// Ported from app/vendor/labnoteo/src/modals.ts:28-88 sha256:eabb6bd0568e5688
// labnoteO 0.140.2, Apache-2.0.
// Changes: only the ranking functions (pickRank, startsWordWithoutSpaces, rankPickItems, withSelectedFirst); the Obsidian modals are not copied.
// Changes: `PickItem` is imported from @labnoteo/core here; the source imports it at the top of modals.ts.

import type { PickItem } from '@labnoteo/core';

/**
 * How well `item` matches the lowercased query `q`, lower first, or undefined when it does not (#324, #401, #485).
 * See the source comment in app/vendor/labnoteo/src/modals.ts above `pickRank` for the full ranking order.
 */
function pickRank<T>(item: PickItem<T>, q: string): number | undefined {
  const label = item.label.toLowerCase();
  const keywords = item.keywords?.map(k => k.toLowerCase()) ?? [];
  const short = keywords.filter(k => k.split(/\s+/).length <= 3);
  if (label === q || short.includes(q) || label.split(/[\s:·|]+/).includes(q)) return 0;
  if (label.includes(q)) return 1;
  if (short.some(k => k.includes(q)) || item.description?.toLowerCase().includes(q)) return 2;
  if (item.detail?.toLowerCase().includes(q) || keywords.some(k => k.includes(q))) return 3;
  const fields = [label, ...short, item.description?.toLowerCase() ?? ''];
  if (fields.some(f => startsWordWithoutSpaces(f, q))) return 4;
  const words = q.split(/\s+/).filter(Boolean);
  if (words.length > 1 && words.every(w => fields.some(f => f.includes(w)))) return 5;
  const all = [...fields, ...keywords, item.detail?.toLowerCase() ?? ''];
  if (words.length > 1 && words.every(w => all.some(f => f.includes(w)))) return 6;
  return undefined;
}

/**
 * Whether `q`, spaces removed, is in `field` with its spaces removed, starting
 * where a word of `field` starts: `primerdesign` finds `primer design`, while
 * `eac` does not find `the access`.
 */
function startsWordWithoutSpaces(field: string, q: string): boolean {
  const compact = q.replace(/\s+/g, '');
  if (compact.length < 2) return false;
  const at: number[] = [];
  let joined = '';
  for (let i = 0; i < field.length; i++) {
    if (/\s/.test(field[i])) continue;
    at.push(i);
    joined += field[i];
  }
  for (let i = joined.indexOf(compact); i !== -1; i = joined.indexOf(compact, i + 1)) {
    const start = at[i];
    if (start === 0 || /[\s:·|_\-/([]/.test(field[start - 1])) return true;
  }
  return false;
}

/** The items matching `query`, best match first and in their given order otherwise. */
export function rankPickItems<T>(items: readonly PickItem<T>[], query: string): PickItem<T>[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...items];
  return items
    .map((item, index) => ({ item, index, rank: pickRank(item, q) }))
    .filter((r): r is { item: PickItem<T>; index: number; rank: number } => r.rank !== undefined)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(r => r.item);
}

/**
 * `items` with the one holding `selected` first, so a picker that always opens
 * on its first row opens on the current value (#537). Only for the unsearched
 * list: once something is typed, the best match belongs at the top.
 */
export function withSelectedFirst<T>(items: PickItem<T>[], query: string, selected: T | undefined): PickItem<T>[] {
  if (query.trim() || selected === undefined) return items;
  const index = items.findIndex(item => item.value === selected);
  if (index > 0) items.unshift(...items.splice(index, 1));
  return items;
}
