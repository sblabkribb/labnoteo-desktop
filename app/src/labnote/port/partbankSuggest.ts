// Ported from app/vendor/labnoteo/src/sampleSuggest.ts:220-230 sha256:72092c5cee44859a
// Ported from app/vendor/labnoteo/src/sampleSuggest.ts:261-268 sha256:8f3af26e4cc0d527
// labnoteO 0.140.2, Apache-2.0.
// Changes: partbankSearchType is a free function: plugin.partbank.configured becomes a `configured: boolean` argument, it takes the parsed SampleTrigger (whose typesToSearch the caller parsed with env.types()) instead of typesToSearch, and strainTypeOf(plugin) becomes an optional `strainType` argument (partbankSource passes strainTypeOf(env)). The partbank branch of renderSuggestion becomes partbankRowLabel(translate, type, strainType?), which returns the two row texts { label, detail } instead of writing DOM; the translator parameter is named `translate`, not `t`, so the app's scan of calls to its own `t` (catalogs.test.ts) does not see it. PARTBANK_ORDER (100) places the row after the local actions (samples/sources.ts orderRows).
import { searchEntitiesForSampleType, searchScopeLabel, type SampleTrigger, type Translator } from '@labnoteo/core';

/** The partbank row's place among the action rows: after catalog (10), generate (20) and manual (30). */
export const PARTBANK_ORDER = 100;

/**
 * The type to offer a partbank search for: the concrete type when one was
 * typed, `null` for `@sample`, or undefined when partbank has nothing of
 * that kind (or no connection is set up).
 */
export function partbankSearchType(
  configured: boolean,
  trigger: SampleTrigger,
  strainType?: string,
): string | null | undefined {
  const typesToSearch = trigger.typesToSearch;
  if (!configured) return undefined;
  if (typesToSearch.length !== 1) {
    // `@sample` expands to every type, which is the only multi-type trigger.
    return typesToSearch.length > 1 ? null : undefined;
  }
  const type = typesToSearch[0];
  return searchEntitiesForSampleType(type, { strainType }).length > 0 ? type : undefined;
}

/** The row's title and the line under it, naming what the search covers. */
export function partbankRowLabel(translate: Translator, type: string | null, strainType?: string): { label: string; detail: string } {
  const entities = searchEntitiesForSampleType(type, { strainType });
  return {
    label: translate('Search partbank'),
    detail: translate('Find and register partbank {0}', searchScopeLabel(entities, translate)),
  };
}
