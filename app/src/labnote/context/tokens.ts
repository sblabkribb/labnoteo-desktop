// Token estimate for the AI context budget (spec §5.4). No tokenizer: a
// character-class count that is deliberately pessimistic for Korean, since BPE
// tokenisers usually give 1-2 tokens per Hangul syllable. Shown as "≈" in the UI.

function isHangul(cp: number): boolean {
  return (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0x1100 && cp <= 0x11ff) || (cp >= 0x3130 && cp <= 0x318f);
}

function isCjkOther(cp: number): boolean {
  return (cp >= 0x3040 && cp <= 0x30ff) || (cp >= 0x4e00 && cp <= 0x9fff);
}

/** `ceil(ascii/4) + hangul + cjkOther + ceil(other/3)`, counted by code point. */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let wide = 0;
  let other = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp <= 0x7f) ascii++;
    else if (isHangul(cp) || isCjkOther(cp)) wide++;
    else other++;
  }
  return Math.ceil(ascii / 4) + wide + Math.ceil(other / 3);
}

const ELLIPSIS = '…';

/**
 * `text` cut to at most `maxTokens` estimated tokens, ending in `…` when cut.
 * Cuts on code points, so a surrogate pair is never split.
 */
export function truncateToTokens(text: string, maxTokens: number): string {
  const max = Math.max(0, Math.floor(maxTokens));
  if (estimateTokens(text) <= max) return text;
  const chars = Array.from(text);
  let lo = 0;
  let hi = chars.length;
  // Largest prefix length whose cut text fits.
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTokens(chars.slice(0, mid).join('') + ELLIPSIS) <= max) lo = mid;
    else hi = mid - 1;
  }
  if (lo === 0) return estimateTokens(ELLIPSIS) <= max ? ELLIPSIS : '';
  return chars.slice(0, lo).join('').trimEnd() + ELLIPSIS;
}
