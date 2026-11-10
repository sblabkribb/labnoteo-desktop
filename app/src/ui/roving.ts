/**
 * Roving tabindex: in a tablist, radiogroup or tree only one item is in the Tab order (tabindex=0); the arrows move between
 * the others. `rovingStop` picks that item: the active one while it is still in the list, else the first, so the widget never
 * drops out of the Tab order when its active item goes away (a stale saved tab, a removed option). Written for this app
 * (the pattern is the WAI-ARIA one that Astryx also follows; no code copied).
 */
export function rovingStop<T>(items: readonly T[], active: T | undefined): T | undefined {
  return active !== undefined && items.includes(active) ? active : items[0];
}
