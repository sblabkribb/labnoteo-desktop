/**
 * GitHub 저장소 이름 만들기 (spec §4 "Repo names", P-R5).
 *
 * The slug is UI only: Rust re-validates every name (`^[A-Za-z0-9._-]{1,100}$`,
 * not `.`/`..`, not ending in `.git`) before anything is sent.
 *
 * Hangul is romanised offline with Revised Romanization, **syllable by
 * syllable**: each syllable's initial, vowel and final are spelled on their
 * own and joined, with no assimilation between syllables (신라 → `sinra`,
 * not `silla`). The result is therefore approximate; the user can edit the
 * name. A `-` appears only where the folder name had a separator.
 */

const INITIALS = ['g', 'kk', 'n', 'd', 'tt', 'r', 'm', 'b', 'pp', 's', 'ss', '', 'j', 'jj', 'ch', 'k', 't', 'p', 'h'];
const VOWELS = [
  'a', 'ae', 'ya', 'yae', 'eo', 'e', 'yeo', 'ye', 'o', 'wa', 'wae',
  'oe', 'yo', 'u', 'wo', 'we', 'wi', 'yu', 'eu', 'ui', 'i',
];
// Finals as pronounced at the end of a syllable (ㄱㄲㄳ → k, ㅅㅆㅈㅊㅌㅎ → t, …).
const FINALS = [
  '', 'k', 'k', 'k', 'n', 'n', 'n', 't', 'l', 'k', 'm', 'l', 'l', 'l',
  'p', 'l', 'm', 'p', 'p', 't', 't', 'ng', 't', 't', 'k', 't', 'p', 't',
];

const SYLLABLE_FIRST = 0xac00;
const SYLLABLE_LAST = 0xd7a3;

const MAX_SLUG = 90;
const MAX_NAME = 100;

/** Hangul syllables to Latin letters (syllable by syllable); everything else is kept. */
export function romanize(text: string): string {
  let out = '';
  for (const ch of text.normalize('NFC')) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < SYLLABLE_FIRST || code > SYLLABLE_LAST) {
      out += ch;
      continue;
    }
    const index = code - SYLLABLE_FIRST;
    const initial = Math.floor(index / (21 * 28));
    const vowel = Math.floor((index % (21 * 28)) / 28);
    const final = index % 28;
    out += INITIALS[initial] + VOWELS[vowel] + FINALS[final];
  }
  return out;
}

/** Drops `-`/`.` at both ends and any trailing `.git`, until nothing changes. */
function tidyEnds(s: string): string {
  let prev = '';
  let cur = s;
  while (cur !== prev) {
    prev = cur;
    cur = cur.replace(/^[-.]+|[-.]+$/g, '');
    if (cur.toLowerCase().endsWith('.git')) cur = cur.slice(0, -4);
  }
  return cur;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** `labnote-YYYYMMDD-xxxx` (local date; `xxxx` from `rand`, lowercase letters and digits). */
function fallbackName(today: Date, rand: () => string): string {
  const day = `${today.getFullYear()}${pad2(today.getMonth() + 1)}${pad2(today.getDate())}`;
  const tail = (rand().toLowerCase().replace(/[^a-z0-9]/g, '') + '0000').slice(0, 4);
  return `labnote-${day}-${tail}`;
}

/**
 * The repo-name slug of a folder name: NFC, romanise Hangul, lowercase, map
 * `[^a-z0-9._-]+` to `-` (collapsing repeats), trim `-`/`.`, strip `.git`,
 * cut to 90 characters. Empty → `labnote-YYYYMMDD-xxxx`.
 */
export function slugify(folderName: string, today: Date, rand: () => string): string {
  const latin = romanize(folderName.normalize('NFC')).toLowerCase();
  const mapped = latin.replace(/[^a-z0-9._-]+/g, '-').replace(/-{2,}/g, '-');
  const slug = tidyEnds(tidyEnds(mapped).slice(0, MAX_SLUG));
  return slug === '' ? fallbackName(today, rand) : slug;
}

/** Caps a name at `max` characters without leaving `-`/`.`/`.git` at the end. */
function capName(name: string, max: number): string {
  if (name.length <= max) return name;
  const cut = tidyEnds(name.slice(0, max));
  return cut === '' ? name.slice(0, max) : cut;
}

/** `{slug}` under the user's own account, `{me}-{slug}` under an org (≤ 100 characters). */
export function repoNameFor(owner: { login: string; kind: 'user' | 'org' }, me: string, slug: string): string {
  return owner.kind === 'org' ? capName(`${me}-${slug}`, MAX_NAME) : capName(slug, MAX_NAME);
}

/** "이름 바꾸기": `base` for n ≤ 1, else `base-n`, shortening `base` to stay within 100 characters. */
export function nextFreeName(base: string, n: number): string {
  if (n <= 1) return base;
  const suffix = `-${n}`;
  const room = MAX_NAME - suffix.length;
  const head = base.length <= room ? base : tidyEnds(base.slice(0, room));
  return `${head}${suffix}`;
}
