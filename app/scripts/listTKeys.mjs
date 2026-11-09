#!/usr/bin/env node
// 플러그인 소스의 줄 범위에서 번역 키를 뽑는다. 옮길 코드의 문장이 한국어로 나오는지 미리 본다.
//   node scripts/listTKeys.mjs <vendor path> <from> <to>
// <path> 는 app/ 기준(vendor/labnoteo/src/x.ts)이나 저장소 기준(app/vendor/labnoteo/src/x.ts) 모두 받는다.
// <from>..<to> 줄(1부터, 양끝 포함)에서 시작하는 t( / this.t( / plugin.t( / host.t( 부름의 첫 인자에 적힌 글자를
// 모두 찾아 [{ key, inKo }] JSON 배열 하나로 낸다(inKo: vendor/labnoteo/src/l10n.ko.ts 에 그 키가 있는지).
// 인자는 줄을 넘어도 되고 삼항이면 글자 둘을 모두 낸다(src/labnote/__tests__/koCoverage.test.ts 와 같은 방식).
// inKo 가 false 인 키가 하나라도 있으면 1 로 끝난다. 잘못된 인자는 2.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [path, fromArg, toArg] = process.argv.slice(2);
const from = Number(fromArg);
const to = Number(toArg);
if (!path || !Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) {
  console.error('usage: node scripts/listTKeys.mjs <vendor path> <from> <to>');
  process.exit(2);
}

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const find = (p) => [resolve(p), join(appDir, p), join(appDir, '..', p)].find((c) => existsSync(c));
const file = find(path);
if (!file) {
  console.error(`not found: ${path}`);
  process.exit(2);
}
const koFile = join(appDir, 'vendor', 'labnoteo', 'src', 'l10n.ko.ts');

const QUOTED = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"/g;
/** 글자 안의 \' 같은 이스케이프를 풀어 키 원문으로 만든다. */
const unescape = (s) => s.replace(/\\(.)/g, '$1');
const literals = (code) => [...code.matchAll(QUOTED)].map((m) => unescape(m[1] ?? m[2]));

/** l10n.ko.ts 의 키: 줄 첫머리의 글자 뒤에 쌍점이 오는 것. 값이 다음 줄에 있어도 된다. */
const KO_KEY = /^\s*(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)")\s*:/gm;
const koText = readFileSync(koFile, 'utf-8').replace(/\r\n/g, '\n');
const koKeys = new Set([...koText.matchAll(KO_KEY)].map((m) => unescape(m[1] ?? m[2])));

const lines = readFileSync(file, 'utf-8').replace(/\r\n/g, '\n').split('\n');
if (to > lines.length) {
  console.error(`${path} has ${lines.length} lines, fewer than ${to}`);
  process.exit(2);
}
// 부름은 범위 안에서 시작해야 하지만 인자는 범위 밖까지 이어져도 된다.
const code = lines.slice(from - 1).join('\n');
const rangeEnd = lines.slice(from - 1, to).join('\n').length;

// 맨 t( 는 앞에 이름 글자나 `.` 이 없어야 하고(`format(`, `x.t(` 는 아니다), 점이 붙으면 this. / plugin. / host. 만 받는다.
const CALLEE = /(?:(?<![\w$.])|(?<=(?<![\w$.])(?:this|plugin|host)\.))t\(/g;

/** 여는 괄호 뒤부터 최상위 쉼표나 닫는 괄호까지(src/i18n/__tests__/callArgs.ts 의 firstArgsOf 와 같은 셈). */
function firstArg(start) {
  let depth = 0;
  let quote = '';
  let i = start;
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
  return code.slice(start, i);
}

const out = [];
const seen = new Set();
for (const m of code.matchAll(CALLEE)) {
  if (m.index >= rangeEnd) break;
  for (const key of literals(firstArg(m.index + m[0].length))) {
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, inKo: koKeys.has(key) });
  }
}
console.log(JSON.stringify(out, null, 2));
process.exit(out.every((k) => k.inKo) ? 0 : 1);
