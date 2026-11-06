#!/usr/bin/env node
// 옮겨 온 코드(app/src/labnote/port/*.ts)의 머리말에 적는 해시를 낸다.
//   node scripts/portHash.mjs <path> <from> <to>
// <path> 는 app/ 기준(vendor/labnoteo/src/x.ts)이나 머리말처럼 저장소 기준(app/vendor/labnoteo/src/x.ts) 모두 받는다.
// 해시: <from>..<to> 줄(1부터, 양끝 포함)을 \n 으로 이은 글(CRLF 는 LF 로 본다)의 SHA-256, 소문자 16진 앞 16글자.
// src/labnote/__tests__/provenance.test.ts 가 같은 계산으로 머리말을 확인한다.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [path, fromArg, toArg] = process.argv.slice(2);
const from = Number(fromArg);
const to = Number(toArg);
if (!path || !Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) {
  console.error('usage: node scripts/portHash.mjs <path> <from> <to>');
  process.exit(2);
}

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const candidates = [resolve(path), join(appDir, path), join(appDir, '..', path)];
const file = candidates.find((p) => existsSync(p));
if (!file) {
  console.error(`not found: ${path}`);
  process.exit(1);
}

const lines = readFileSync(file, 'utf-8').replace(/\r\n/g, '\n').split('\n');
if (to > lines.length) {
  console.error(`${path} has ${lines.length} lines, fewer than ${to}`);
  process.exit(1);
}
const range = lines.slice(from - 1, to).join('\n');
console.log(createHash('sha256').update(range, 'utf8').digest('hex').slice(0, 16));
