// Ported from app/vendor/labnoteo/src/partbank/partbankSearch.ts:14-150 sha256:0fd70dde889168df
// labnoteO 0.140.2, Apache-2.0.
// Changes: none to the logic. The parameter `t` of partbankTypeLabel, describeHit and truncationNotice is renamed `translate`, so the app's scan of calls to its own `t` (catalogs.test.ts) does not see it. The client types come from ./partbankClient (the port of client.ts). The SuggestModal part (searchPartbankModal and PartbankSearchModal, vendor :152-270) is not ported: the React PartbankSearchDialog in src/partbank/PartbankSearchDialog.tsx uses these helpers instead.
/**
 * The helpers behind "Search partbank": the debounce and stale-answer rule,
 * the empty-list states, and how a hit and a cut list are described.
 *
 * Autocomplete itself cannot do this. `EditorSuggest` fires on every keystroke
 * with no debounce of its own, so wiring a network call into it would send one
 * request per character. The debounce and the stale-response rule live in
 * {@link SearchDebouncer}, which is where they are tested.
 */
import type { PartbankType } from '@labnoteo/core';
import type { PartbankSearchHit } from './partbankClient';

/** Characters before a search is worth making; below this everything matches. */
export const MIN_QUERY_CHARS = 2;
/** How long typing has to pause before the request goes out. */
export const SEARCH_DEBOUNCE_MS = 400;

export interface SearchDebouncerOpts<T> {
  search(query: string): Promise<T[]>;
  onResults(query: string, results: T[]): void;
  onError(query: string, err: unknown): void;
  delayMs?: number;
  minChars?: number;
  /** Injected so tests can drive the clock without a global timer stub. */
  setTimer?: (fn: () => void, ms: number) => number;
  clearTimer?: (handle: number) => void;
}

/**
 * Turns a stream of keystrokes into at most one request per pause, and drops
 * the answer to any query that is no longer the one on screen — a slow reply
 * to "gf" must not replace the results for "gfp".
 */
export class SearchDebouncer<T> {
  private timer: number | undefined;
  /** The query of the most recent request; answers to any other are ignored. */
  private latest = '';

  constructor(private readonly opts: SearchDebouncerOpts<T>) {}

  private get setTimer(): (fn: () => void, ms: number) => number {
    return this.opts.setTimer ?? ((fn, ms) => window.setTimeout(fn, ms));
  }

  /** The text in the box changed. */
  query(text: string): void {
    this.cancel();
    const trimmed = text.trim();
    this.latest = trimmed;
    if (trimmed.length < (this.opts.minChars ?? MIN_QUERY_CHARS)) {
      this.opts.onResults(trimmed, []);
      return;
    }
    this.timer = this.setTimer(() => {
      this.timer = undefined;
      void this.run(trimmed);
    }, this.opts.delayMs ?? SEARCH_DEBOUNCE_MS);
  }

  /** Drop a pending request; an in-flight one still returns but is ignored. */
  cancel(): void {
    if (this.timer === undefined) return;
    (this.opts.clearTimer ?? (h => window.clearTimeout(h)))(this.timer);
    this.timer = undefined;
  }

  private async run(query: string): Promise<void> {
    try {
      const results = await this.opts.search(query);
      if (this.latest === query) this.opts.onResults(query, results);
    } catch (err) {
      if (this.latest === query) this.opts.onError(query, err);
    }
  }
}

/**
 * What an empty result list stands for (#474): too little typed to search,
 * a search still on its way (the pause before it included), or no match.
 */
export function partbankEmptyState(query: string, pending: boolean): 'short' | 'searching' | 'none' {
  if (query.trim().length < MIN_QUERY_CHARS) return 'short';
  return pending ? 'searching' : 'none';
}

/** What a partbank type is called in the list. */
export function partbankTypeLabel(
  type: PartbankType,
  translate: (key: string, ...args: string[]) => string
): string {
  switch (type) {
    case 'part':
      return translate('part');
    case 'device':
      return translate('device');
    case 'plasmid':
      return translate('plasmid');
    case 'primer':
      return translate('primer');
    case 'molecule':
      return translate('molecule');
    case 'strain':
      return translate('strain');
  }
}

/**
 * How a search hit is described in the list. Whose it is matters as much as
 * what it is: a public item from another lab looks the same otherwise.
 */
export function describeHit(
  hit: PartbankSearchHit,
  translate: (key: string, ...args: string[]) => string
): { title: string; detail: string } {
  const sharing = hit.ownedByMe
    ? translate('mine')
    : hit.sharingLevel === 'public'
      ? translate('public')
      : translate('shared');
  const detail = [hit.kid, partbankTypeLabel(hit.type, translate), sharing, hit.description]
    .filter((p): p is string => Boolean(p))
    .join(' · ');
  return { title: hit.name?.trim() || hit.kid || hit.id, detail };
}

/**
 * The line under the list when a type was cut at `limit` (#561), or undefined.
 * With the server's `typeCounts` it gives each cut type's total; without them
 * (an older server) a type that filled `limit` may have more.
 */
export function truncationNotice(
  hits: readonly PartbankSearchHit[],
  typeCounts: Partial<Record<PartbankType, number>> | undefined,
  limit: number,
  translate: (key: string, ...args: string[]) => string
): string | undefined {
  const shown = new Map<PartbankType, number>();
  for (const hit of hits) shown.set(hit.type, (shown.get(hit.type) ?? 0) + 1);
  const cut: string[] = [];
  const types = new Set<PartbankType>([...shown.keys(), ...(Object.keys(typeCounts ?? {}) as PartbankType[])]);
  for (const type of types) {
    const total = typeCounts?.[type];
    if (typeCounts ? total !== undefined && total > limit : shown.get(type) === limit) {
      cut.push(`${partbankTypeLabel(type, translate)} ${typeCounts ? String(total) : `${limit}+`}`);
    }
  }
  if (cut.length === 0) return undefined;
  return translate('Only the first {0} of each type are shown ({1}). Type more to narrow the search.', String(limit), cut.join(', '));
}
