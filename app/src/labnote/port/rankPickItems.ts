// Ported from app/vendor/labnoteo/src/modals.ts:28-88 sha256:eabb6bd0568e5688
// labnoteO 0.140.2, Apache-2.0.
// Changes: only the ranking functions (pickRank, startsWordWithoutSpaces, rankPickItems, withSelectedFirst); the Obsidian modals are not copied.
// Changes: pickRank is replaced by pickScore (UI redesign Task 11): tiers exact code > exact name > prefix > word prefix > all tokens in the names > all tokens anywhere, a tighter name match first within a tier.
// Changes: `PickItem` is imported from @labnoteo/core here; the source imports it at the top of modals.ts.

import type { PickItem } from '@labnoteo/core';

/** A catalog code at the start of a label (`WB030: DNA Assembly`, `UHW380: …`). */
const CODE = /^([A-Za-z]{1,4}\d{2,4}[A-Za-z]?)\s*:\s*/;

/** The tiers of {@link pickScore}: higher is better. */
const TIER = { code: 1000, name: 900, prefix: 800, wordPrefix: 700, inName: 600, searchWord: 500, anywhere: 300 } as const;

/**
 * A picker row may carry search words besides its names (`searchWords`, app side: the catalog's Korean search words, a
 * unit operation's equipment). They find the row but rank below every name match.
 */
type WithSearchWords = { searchWords?: readonly string[] };

/**
 * How well `item` matches the lowercased query `q`, higher first, or undefined when it does not
 * (UI redesign Task 11, replacing the plugin's #324/#401/#485 order):
 * exact code 1000, exact name (en or ko) 900, name or code prefix 800, a word of a name starting with it 700
 * (also with the spaces left out, `primerdesign`), every token in the names 600, every token anywhere
 * (description, detail, long keywords) 300. Within a name tier a match covering more of the name comes first,
 * so `조립` puts `DNA 조립` ahead of `DNA 올리고머 조립`.
 */
function pickScore<T>(item: PickItem<T>, q: string): number | undefined {
  const label = item.label.toLowerCase();
  const code = CODE.exec(label);
  const keywords = item.keywords?.map(k => k.toLowerCase()) ?? [];
  const names = [code ? label.slice(code[0].length) : label, ...keywords.filter(k => k.split(/\s+/).length <= 3)];
  const codeText = code?.[1];
  if (codeText !== undefined && codeText === q) return TIER.code;
  const cover = (field: string) => Math.min(99, Math.floor((99 * q.length) / Math.max(q.length, field.length)));
  let best: number | undefined;
  const offer = (score: number) => {
    if (best === undefined || score > best) best = score;
  };
  if (codeText?.startsWith(q)) offer(TIER.prefix);
  for (const name of names) {
    if (name === q) offer(TIER.name);
    else if (name.startsWith(q)) offer(TIER.prefix + cover(name));
    else if (wordStarts(name, q) || startsWordWithoutSpaces(name, q)) offer(TIER.wordPrefix + cover(name));
    else if (name.includes(q)) offer(TIER.inName + cover(name));
  }
  if (best !== undefined) return best;
  const words = q.split(/\s+/).filter(Boolean);
  if (words.length > 1 && words.every(w => names.some(f => f.includes(w)))) return TIER.inName;
  const search = ((item as WithSearchWords).searchWords ?? []).map(k => k.toLowerCase());
  for (const word of search) {
    if (word === q || word.startsWith(q) || wordStarts(word, q)) offer(TIER.searchWord + cover(word));
  }
  if (best !== undefined) return best;
  const all = [label, ...keywords, ...search, item.description?.toLowerCase() ?? '', item.detail?.toLowerCase() ?? ''];
  if (words.every(w => all.some(f => f.includes(w)))) return TIER.anywhere;
  return undefined;
}

/** Whether a word of `field` starts with `q` (words split at spaces and the separators labels use). */
function wordStarts(field: string, q: string): boolean {
  for (let i = field.indexOf(q); i !== -1; i = field.indexOf(q, i + 1)) {
    if (i === 0 || /[\s:·|_\-/([]/.test(field[i - 1])) return true;
  }
  return false;
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
    .map((item, index) => ({ item, index, score: pickScore(item, q) }))
    .filter((r): r is { item: PickItem<T>; index: number; score: number } => r.score !== undefined)
    .sort((a, b) => b.score - a.score || a.index - b.index)
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
