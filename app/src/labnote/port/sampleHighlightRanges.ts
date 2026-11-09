// Ported from app/vendor/labnoteo/src/sampleHighlight.ts:40-67 sha256:23311c4c48e8a6a5
// Ported from app/vendor/labnoteo/src/sampleHighlight.ts:78-107 sha256:cd226ae8ef546144
// Ported from app/vendor/labnoteo/src/sampleHighlight.ts:109-215 sha256:4007eec8f1158ad6
// labnoteO 0.140.2, Apache-2.0.
// Changes: sample checks only (issue markers dropped); colour → sampleTypeClass instead of an inline style (CSP); returns plain ranges for a CM6 ViewPlugin; definedIds passed in.
// Changes: HighlightState and MarkerOptions keep only their sample members (colors, the marker, duplicate, comment and malformed members go with the markers); collectTokenRanges loses its `colors` parameter, adds sampleTypeClass(type) after the ID class and uses the app's lno-* class names; sampleTokenRanges is the app's entry point over these.
import { findSampleIdRanges, staleSampleAliasEnd } from '@labnoteo/core';
import { sampleTypeClass } from '../../samples/typeClass';
import type { KnownSampleIds } from './sampleIdIndex';

export interface HighlightState {
  types: readonly string[];
  /** Lower-cased sample IDs the note can resolve; without it no ID is marked missing (#210). */
  knownIds?: ReadonlySet<string>;
  /** Changes whenever `knownIds` may have, so the editor redraws. */
  sampleVersion?: number;
  /** Tooltip of a sample ID the registry does not have. */
  missingTitle?: string;
  /** Registry aliases by lower-cased ID, read with `knownIds` (#239). */
  knownAliases?: ReadonlyMap<string, string>;
  /** Tooltip of a reference whose alias differs from the registry's `alias`. */
  staleAliasTitle?: (alias: string) => string;
  /** Discard dates by lower-cased ID, read with `knownIds` (#330). */
  discardedIds?: ReadonlyMap<string, string>;
  /** Tooltip of a reference to a discarded sample. */
  discardedTitle?: (date: string) => string;
}

const SAMPLE_ID_CLASS = 'lno-sample-id';
const MISSING_SAMPLE_CLASS = 'lno-sample-id-missing';
const STALE_ALIAS_CLASS = 'lno-sample-alias-stale';
const DISCARDED_SAMPLE_CLASS = 'lno-sample-discarded';

/** One span to decorate, with the class and optional tooltip it carries. */
export interface TokenRange {
  start: number;
  end: number;
  cls: string;
  title?: string;
}

/** Which sample marks to draw, and how, in the editor. */
export interface MarkerOptions {
  /** Tooltip for a sample ID the note cannot resolve, undefined otherwise (#210). */
  missing?: (id: string) => string | undefined;
  /** The registry alias of a sample ID to hold its references to, with the tooltip for one that differs (#239). */
  staleAlias?: (id: string) => { alias: string; title: string } | undefined;
  /** Tooltip for a discarded sample's ID, undefined otherwise (#330). */
  discarded?: (id: string) => string | undefined;
  /** The text stops where reading view split it, e.g. before a link (#329). */
  cut?: boolean;
}

/**
 * Tooltip for the sample IDs of a note that are neither in its registries nor
 * defined in the note itself, which the sample sync has yet to save.
 */
export function missingSampleCheck(
  state: HighlightState,
  definedIds: ReadonlySet<string>,
): ((id: string) => string | undefined) | undefined {
  const known = state.knownIds;
  if (!known) return undefined;
  const title = state.missingTitle ?? '';
  return (id) => {
    const key = id.toLowerCase();
    return known.has(key) || definedIds.has(key) ? undefined : title;
  };
}

/**
 * The registry alias that a note's references to a sample should carry. Not
 * for the samples the note defines itself: the sample sync writes their alias
 * to the registry on save.
 */
export function staleAliasCheck(state: HighlightState, definedIds: ReadonlySet<string>): MarkerOptions['staleAlias'] {
  const aliases = state.knownAliases;
  if (!aliases) return undefined;
  return (id) => {
    const key = id.toLowerCase();
    const alias = aliases.get(key);
    if (!alias || definedIds.has(key)) return undefined;
    return { alias, title: state.staleAliasTitle?.(alias) ?? '' };
  };
}

/** Tooltip for the references of a note to a discarded sample (#330). */
export function discardedSampleCheck(state: HighlightState): MarkerOptions['discarded'] {
  const dates = state.discardedIds;
  if (!dates) return undefined;
  return (id) => {
    const date = dates.get(id.toLowerCase());
    return date === undefined ? undefined : (state.discardedTitle?.(date) ?? '');
  };
}

/**
 * Sample IDs, ordered by position and non-overlapping. Sample IDs in code are
 * kept, since the sample sync does register them.
 */
export function collectTokenRanges(text: string, types: readonly string[], opts: MarkerOptions = {}): TokenRange[] {
  const ranges: TokenRange[] = [];
  for (const r of findSampleIdRanges(text, types)) {
    const base = `${SAMPLE_ID_CLASS} ${sampleTypeClass(r.type)}`;
    const id = text.slice(r.start, r.end);
    const title = opts.missing?.(id);
    if (title !== undefined) {
      ranges.push({ start: r.start, end: r.end, cls: `${base} ${MISSING_SAMPLE_CLASS}`, title });
      continue;
    }
    const stale = opts.staleAlias?.(id);
    const end = stale ? staleSampleAliasEnd(text, r.end, stale.alias, opts.cut) : undefined;
    const range: TokenRange =
      stale && end !== undefined
        ? { start: r.start, end, cls: `${base} ${STALE_ALIAS_CLASS}`, title: stale.title }
        : { start: r.start, end: r.end, cls: base };
    const discarded = opts.discarded?.(id);
    if (discarded !== undefined) {
      range.cls = `${range.cls} ${DISCARDED_SAMPLE_CLASS}`;
      range.title = range.title ? `${discarded}\n${range.title}` : discarded;
    }
    ranges.push(range);
  }

  // A stale alias's mark reaches past its ID and may cover the next one.
  let last = 0;
  return ranges
    .sort((a, b) => a.start - b.start)
    .filter((r) => {
      if (r.start < last) return false;
      last = r.end;
      return true;
    });
}

/** What the app's highlighter knows about a note when it scans (part of) it. */
export interface SampleHighlightInput {
  types: readonly string[];
  /** undefined: the index has not read the note's registries, or one is unreadable — nothing is marked missing, stale or discarded. */
  known: KnownSampleIds | undefined;
  /** Lower-cased IDs the whole note defines (findDefinedSampleIds over the full doc). */
  defined: ReadonlySet<string>;
  titles: { missing: string; stale(alias: string): string; discarded(date: string): string };
}

/** One mark for CodeMirror (or a rendered cell): class names and an optional `title` tooltip, never a style. */
export interface SampleTokenRange {
  from: number;
  to: number;
  cls: string;
  title?: string;
}

/** Sorted, non-overlapping; `offset` is added to every position (visible-range scanning). */
export function sampleTokenRanges(text: string, input: SampleHighlightInput, offset = 0): SampleTokenRange[] {
  const { known, titles } = input;
  const state: HighlightState = {
    types: input.types,
    knownIds: known?.ids,
    knownAliases: known?.aliases,
    discardedIds: known?.discarded,
    missingTitle: titles.missing,
    staleAliasTitle: titles.stale,
    discardedTitle: titles.discarded,
  };
  const opts: MarkerOptions = known
    ? {
        missing: missingSampleCheck(state, input.defined),
        staleAlias: staleAliasCheck(state, input.defined),
        discarded: discardedSampleCheck(state),
      }
    : {};
  return collectTokenRanges(text, input.types, opts).map((r) =>
    r.title === undefined
      ? { from: r.start + offset, to: r.end + offset, cls: r.cls }
      : { from: r.start + offset, to: r.end + offset, cls: r.cls, title: r.title },
  );
}
