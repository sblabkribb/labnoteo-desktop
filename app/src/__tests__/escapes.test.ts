import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// A Windows path typed in a string with one backslash is silently a different string: the
// backslash plus the next letter becomes an escape, or vanishes. This guard reads every source file and flags
//   1. a backslash followed by a character that is not a JavaScript escape, and
//   2. a single backslash right after a drive letter and colon (valid escapes like \b, \n, \t
//      pass rule 1 but are still not a path separator).
// The way to write a path separator in a string is a doubled backslash, or String.raw.

const BS = String.fromCharCode(92);
const VALID_AFTER_BACKSLASH = new Set([...'nrtbfv0xu\'"`$', BS, '\n', '\r']);

/** Quoted string literals on one line (comments and regex literals are not parsed). */
const QUOTED = new RegExp(String.raw`'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"`, 'g');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules') return [];
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.tsx?$/.test(name) ? [p] : [];
  });
}

/** Problems in one source text, as "line N: literal". */
export function badEscapes(text: string): string[] {
  const out: string[] = [];
  text.split('\n').forEach((line, i) => {
    for (const m of line.match(QUOTED) ?? []) {
      let bad = false;
      for (let k = 0; k < m.length; k++) {
        if (m[k] !== BS) continue;
        const next = m[k + 1];
        const prev2 = m.slice(Math.max(0, k - 2), k);
        if (next === undefined || !VALID_AFTER_BACKSLASH.has(next)) bad = true;
        // A lone backslash after "X:" (a doubled one would have skipped past below).
        if (next !== BS && /^[A-Za-z]:$/.test(prev2)) bad = true;
        if (next === BS) k++; // skip the escaped backslash
      }
      if (bad) out.push(`line ${i + 1}: ${m}`);
    }
  });
  return out;
}

describe('backslash escapes in string literals', () => {
  it('the guard recognises the mangled Windows paths', () => {
    const mangled = ["'D:" + BS + "lab'", "'D:" + BS + "a'", "'D:" + BS + "b'", "'a" + BS + "d'"];
    for (const m of mangled) expect(badEscapes(`const p = ${m};`), m).toHaveLength(1);
    const fine = ["'D:" + BS + BS + "lab'", "'line" + BS + "n'", "'it" + BS + "'s'"];
    for (const f of fine) expect(badEscapes(`const p = ${f};`), f).toEqual([]);
  });

  it('no source file under src has one', () => {
    const found = sources('src').flatMap((f) => badEscapes(readFileSync(f, 'utf-8')).map((p) => `${f} ${p}`));
    expect(found).toEqual([]);
  });
});
