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

const BT = String.fromCharCode(96); // a backtick, which cannot be written inside a template literal

/**
 * String literals on one line: single-quoted, double-quoted and template (backtick). One
 * alternation scanned left to right, so a backtick inside a quoted string is part of that string.
 * A template that spans lines, comments and regex literals are not parsed.
 */
const QUOTED = new RegExp(
  String.raw`'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|${BT}(?:[^${BT}\\\n]|\\.)*${BT}`,
  'g',
);

/** A line that is only a comment: `// …`, `/* …` or a JSDoc ` * …` continuation. */
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;

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
    // A whole-line comment holds no string: a ported JSDoc may quote TeX such as `\,` verbatim.
    if (COMMENT_LINE.test(line)) return;
    for (const found of line.matchAll(QUOTED)) {
      const m = found[0];
      // String.raw keeps every backslash as written: it is the sanctioned way to type a path.
      if (m[0] === BT && line.slice(0, found.index).endsWith('String.raw')) continue;
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

  it('the guard reads template literals too, not only quoted strings', () => {
    const mangled = [BT + 'D:' + BS + 'lab' + BT, BT + 'a' + BS + 'd/${x}' + BT, BT + '${root}' + BS + 'lab' + BT];
    for (const m of mangled) expect(badEscapes(`const p = ${m};`), m).toHaveLength(1);
    const fine = [
      BT + 'D:' + BS + BS + 'lab' + BT,
      BT + '${root}' + BS + BS + 'lab' + BT,
      BT + 'line' + BS + 'n' + BT,
      BT + 'a ' + BS + BT + ' b' + BT,
      BT + 'price ' + BS + '${x}' + BT,
    ];
    for (const f of fine) expect(badEscapes(`const p = ${f};`), f).toEqual([]);
    // A backtick inside a quoted string does not open a template that swallows the rest of the line.
    expect(badEscapes(`const a = '${BT}'; const b = 'D:${BS}lab';`)).toHaveLength(1);
    // String.raw is the sanctioned way to write a path with single backslashes.
    expect(badEscapes('const p = String.raw' + BT + 'D:' + BS + 'lab' + BT + ';')).toEqual([]);
  });

  it('a whole-line comment is not read as a string, but code before a trailing comment still is', () => {
    expect(badEscapes('  // `' + BS + ',` is a thin space')).toEqual([]);
    expect(badEscapes(' * so `$3' + BS + ',mL$` printed')).toEqual([]);
    expect(badEscapes('/* `' + BS + 'mu L` */')).toEqual([]);
    expect(badEscapes("const p = 'D:" + BS + "lab'; // note")).toHaveLength(1);
  });

  it('no source file under src has one', () => {
    const found = sources('src').flatMap((f) => badEscapes(readFileSync(f, 'utf-8')).map((p) => `${f} ${p}`));
    expect(found).toEqual([]);
  });
});
