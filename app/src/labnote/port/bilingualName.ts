// Ported from app/vendor/labnoteo/src/i18n.ts:36-39 sha256:5aab26fe641bb93f
// labnoteO 0.140.2, Apache-2.0.
// Changes: the parameter `t` is renamed `translate`, so the app's scan of calls to its own `t` (catalogs.test.ts) does not see it.
// Changes: `Translator` is imported from @labnoteo/core here; the source imports it at the top of i18n.ts.

import type { Translator } from '@labnoteo/core';

/** Command-palette label: the translation with the English key appended, so either language matches the search. */
export function bilingualName(translate: Translator, key: string): string {
  const local = translate(key);
  return local === key ? key : `${local} (${key})`;
}
