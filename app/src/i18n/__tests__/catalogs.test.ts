import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { catalogs } from '../t';

/** 템플릿이 쓰는 자리 표시의 집합: `{0}` 을 두 번 써도 하나다. */
const placeholders = (s: string) => [...new Set(s.match(/\{\d+\}/g) ?? [])].sort();

describe('번역 목록', () => {
  const { ko, en } = catalogs;

  it('ko 와 en 은 같은 키를 가진다: 한쪽에만 있는 키가 없다', () => {
    const onlyKo = Object.keys(ko).filter((k) => !Object.hasOwn(en, k));
    const onlyEn = Object.keys(en).filter((k) => !Object.hasOwn(ko, k));
    expect({ onlyKo, onlyEn }).toEqual({ onlyKo: [], onlyEn: [] });
    expect(Object.keys(ko).length).toBeGreaterThan(60); // 목록을 실제로 읽었다
  });

  it('키마다 두 언어의 자리 표시({0} {1} …) 집합이 같다', () => {
    const differ = Object.keys(ko)
      .filter((k) => Object.hasOwn(en, k))
      .filter((k) => placeholders(ko[k]).join() !== placeholders(en[k]).join())
      .map((k) => `${k}: ko ${placeholders(ko[k])} / en ${placeholders(en[k])}`);
    expect(differ).toEqual([]);
    expect(placeholders(ko['search.truncated'])).toEqual(['{0}']); // 검사가 자리 표시를 실제로 읽었다
  });

  it('빈 번역이 없다', () => {
    for (const [lang, cat] of Object.entries(catalogs)) {
      for (const [k, v] of Object.entries(cat)) expect(v.trim(), `${lang} ${k}`).not.toBe('');
    }
  });
});

// 테스트가 아닌 소스 전부(.ts, .tsx). __tests__ 폴더와 *.test.* 는 뺀다.
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === '__tests__' ? [] : sources(p);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : [];
  });
}

const QUOTED = new RegExp(String.raw`'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"`, 'g');
const literals = (code: string) => [...code.matchAll(QUOTED)].map((m) => m[1] ?? m[2]);

/** `t(` 뒤 첫 인자(최상위 쉼표나 닫는 괄호까지)의 글자. `t(gone ? 'a' : 'b')` 처럼 삼항으로 고른 키도 잡는다. */
export function firstArgsOfT(code: string): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(/(?<![\w.$])t\(/g)) {
    let depth = 0;
    let quote = '';
    let i = m.index! + m[0].length;
    const start = i;
    for (; i < code.length; i++) {
      const c = code[i];
      if (quote) {
        if (c === '\\') i++;
        else if (c === quote) quote = '';
        continue;
      }
      if (c === "'" || c === '"' || c === '`') quote = c;
      else if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') {
        if (depth === 0) break;
        depth--;
      } else if (c === ',' && depth === 0) break;
    }
    out.push(code.slice(start, i));
  }
  return out;
}

describe('소스가 부르는 번역 키', () => {
  const { ko, en } = catalogs;
  const files = sources('src').map((f) => ({ f, code: readFileSync(f, 'utf-8') }));
  const missing = (keys: Array<{ f: string; key: string }>) =>
    keys.filter(({ key }) => !Object.hasOwn(ko, key) || !Object.hasOwn(en, key)).map(({ f, key }) => `${f}: ${key}`);

  it("t('…') 에 글자 그대로 넘긴 키는 두 목록 모두에 있다", () => {
    const keys = files.flatMap(({ f, code }) => firstArgsOfT(code).flatMap(literals).map((key) => ({ f, key })));
    expect(new Set(keys.map((k) => k.key)).size).toBeGreaterThan(50); // 소스를 실제로 읽었다
    expect(missing(keys)).toEqual([]);
  });

  // t(key), t(error) 처럼 변수로 넘기는 키는 다른 곳(목록 배열, 상태)에 글자로 적혀 있다.
  // 번역 키의 이름 공간(app., editor. …)으로 시작하는 문자열 글자는 모두 키여야 한다.
  it('번역 키 모양의 문자열 글자(변수로 t 에 넘길 키)도 두 목록 모두에 있다', () => {
    const spaces = new Set(Object.keys(ko).map((k) => k.split('.')[0]));
    const KEYLIKE = new RegExp(String.raw`^(${[...spaces].join('|')})\.[A-Za-z][\w.]*$`);
    const keys = files.flatMap(({ f, code }) => literals(code).filter((s) => KEYLIKE.test(s)).map((key) => ({ f, key })));
    expect(keys.map((k) => k.key)).toEqual(expect.arrayContaining(['theme.system', 'vault.error.missing'])); // 변수로 넘기는 키를 실제로 찾았다
    expect(missing(keys)).toEqual([]);
  });

  it('첫 인자 추출기는 삼항·추가 인자·괄호를 견딘다', () => {
    expect(firstArgsOfT(`t('a.b', x) + t(gone ? 'c.d' : "e.f") + format(t('g.h'), [1]) + it('no.key', f)`)).toEqual([
      `'a.b'`,
      `gone ? 'c.d' : "e.f"`,
      `'g.h'`,
    ]);
  });
});
