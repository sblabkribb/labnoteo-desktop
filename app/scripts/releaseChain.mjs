#!/usr/bin/env node
// 앱 버전이 적힌 여섯 곳을 한 스크립트가 맡는다 (sync-core.yml 과 release.yml 이 같은 것을 부른다).
//   node app/scripts/releaseChain.mjs versions   여섯 곳이 같으면 그 버전을 찍고, 다르면 곳마다 적고 exit 1
//   node app/scripts/releaseChain.mjs bump       패치 번호를 올려 파일에 쓰고 `new=<v>` 를 찍는다
//   node app/scripts/releaseChain.mjs set <v>    <v>(x.y.z) 로 맞춰 쓰고 `new=<v>` 를 찍는다
// 파일은 이 스크립트 위치로 찾으므로 어느 폴더에서 불러도 된다(보통 저장소 루트).
// 함수들은 글 → 글(순수)이고 app/src/__tests__/releaseChain.test.ts 가 시험한다.
// 고칠 때는 곳마다 고정한 정규식으로 그 한 줄만 바꾼다(형식·줄바꿈 그대로). JSON 파싱은 확인에만 쓴다.
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = 'app/package.json';
const LOCK = 'app/package-lock.json';
const CONF = 'app/src-tauri/tauri.conf.json';
const TOML = 'app/src-tauri/Cargo.toml';
const CLOCK = 'app/src-tauri/Cargo.lock';

/** 버전이 적힌 파일(저장소 기준 경로). 여섯 곳이 이 다섯 파일에 있다. */
export const VERSION_FILES = Object.freeze([PKG, LOCK, CONF, TOML, CLOCK]);

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

// 맨 위(2칸 들여쓰기) "version" — 더 깊이 들여쓴 의존성 버전은 걸리지 않는다.
const TOP_JSON_VERSION = /^(  "version": ")([^"\r\n]*)(")/gm;

/**
 * 여섯 곳. `re` 는 g 플래그와 (앞)(버전)(뒤) 세 묶음을 갖고, 파일에서 꼭 한 번 맞아야 한다.
 * `parse` 는 고친 결과를 정규식과 따로 확인하려고 JSON 을 읽는다(TOML 은 정규식 그대로).
 */
const SITES = [
  {
    key: 'package.json',
    file: PKG,
    re: TOP_JSON_VERSION,
    parse: (text) => JSON.parse(text).version,
  },
  {
    key: 'package-lock.json#version',
    file: LOCK,
    re: TOP_JSON_VERSION,
    parse: (text) => JSON.parse(text).version,
  },
  {
    key: 'package-lock.json#packages[""]',
    file: LOCK,
    // "packages" 안의 "" 항목: 그 항목의 6칸 줄들 가운데 첫 "version".
    re: /^(    "": \{\r?\n(?:      .*\r?\n)*?      "version": ")([^"\r\n]*)(")/gm,
    parse: (text) => JSON.parse(text).packages?.['']?.version,
  },
  {
    key: 'tauri.conf.json',
    file: CONF,
    re: TOP_JSON_VERSION,
    parse: (text) => JSON.parse(text).version,
  },
  {
    key: 'Cargo.toml',
    file: TOML,
    // [package] 표 안(다음 `[` 머리 전)의 version.
    re: /^(\[package\][ \t]*\r?\n(?:(?!\[).*\r?\n)*?version = ")([^"\r\n]*)(")/gm,
  },
  {
    key: 'Cargo.lock#labnoteo-app',
    file: CLOCK,
    re: /^(\[\[package\]\]\r?\nname = "labnoteo-app"\r?\nversion = ")([^"\r\n]*)(")/gm,
  },
];

function assertSemver(v) {
  if (typeof v !== 'string' || !SEMVER.test(v)) {
    throw new Error(`not a plain x.y.z version: ${JSON.stringify(v)}`);
  }
}

function fileText(files, site) {
  const text = files[site.file];
  if (typeof text !== 'string') throw new Error(`${site.key}: file ${site.file} is missing`);
  return text;
}

/** 정규식이 꼭 한 번 맞는 자리. 없거나 둘 이상이면 그 곳 이름으로 던진다. */
function matchOnce(site, text) {
  const all = [...text.matchAll(site.re)];
  if (all.length !== 1) {
    throw new Error(
      `${site.key}: expected exactly one version in ${site.file}, found ${all.length}`,
    );
  }
  return all[0];
}

/** '0.1.9' → '0.1.10'. x.y.z 가 아니면 던진다. */
export function bumpPatch(v) {
  assertSemver(v);
  const [major, minor, patch] = v.split('.').map(Number);
  return `${major}.${minor}.${patch + 1}`;
}

/** 여섯 곳의 버전을 읽는다: { 'package.json': '0.1.0', ... }. */
export function readVersions(files) {
  const out = {};
  for (const site of SITES) {
    const text = fileText(files, site);
    const fromRegex = matchOnce(site, text)[2];
    if (site.parse) {
      let parsed;
      try {
        parsed = site.parse(text);
      } catch (e) {
        throw new Error(`${site.key}: ${site.file} is not valid JSON (${e.message})`);
      }
      if (parsed !== fromRegex) {
        throw new Error(`${site.key}: line edit sees ${fromRegex} but JSON says ${parsed}`);
      }
    }
    out[site.key] = fromRegex;
  }
  return out;
}

/** 여섯 곳을 `v` 로 바꾼 새 파일 묶음(입력은 그대로). 다른 줄·줄바꿈은 건드리지 않는다. */
export function setVersion(files, v) {
  assertSemver(v);
  const out = { ...files };
  for (const site of SITES) {
    const text = fileText(out, site);
    const m = matchOnce(site, text);
    const start = m.index + m[1].length;
    out[site.file] = text.slice(0, start) + v + text.slice(start + m[2].length);
  }
  const got = assertSameVersion(out);
  if (got !== v) throw new Error(`setVersion wrote ${got}, wanted ${v}`);
  return out;
}

/** 여섯 곳이 같으면 그 버전을, 아니면 곳마다 적은 오류를 던진다. */
export function assertSameVersion(files) {
  const versions = readVersions(files);
  const distinct = new Set(Object.values(versions));
  if (distinct.size !== 1) {
    const lines = Object.entries(versions).map(([k, v]) => `  ${k} = ${v}`);
    throw new Error(`app version differs between sites:\n${lines.join('\n')}`);
  }
  const [v] = distinct;
  assertSemver(v);
  return v;
}

// ---- CLI ----

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function loadFiles() {
  const files = {};
  for (const f of VERSION_FILES) files[f] = readFileSync(join(repoRoot, f), 'utf8');
  return files;
}

function saveFiles(before, after) {
  for (const f of VERSION_FILES) {
    if (after[f] !== before[f]) writeFileSync(join(repoRoot, f), after[f], 'utf8');
  }
}

const USAGE = 'usage: node app/scripts/releaseChain.mjs versions | bump | set <x.y.z>';

function main(argv) {
  const [cmd, arg] = argv;
  if (cmd === 'versions' && argv.length === 1) {
    console.log(assertSameVersion(loadFiles()));
    return 0;
  }
  if (cmd === 'bump' && argv.length === 1) {
    const files = loadFiles();
    const next = bumpPatch(assertSameVersion(files));
    saveFiles(files, setVersion(files, next));
    console.log(`new=${next}`);
    return 0;
  }
  if (cmd === 'set' && argv.length === 2) {
    const files = loadFiles();
    assertSameVersion(files);
    saveFiles(files, setVersion(files, arg));
    console.log(`new=${arg}`);
    return 0;
  }
  console.error(USAGE);
  return 2;
}

function isMain() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    // GitHub Actions 는 `::error::` 줄을 주석으로 보여 준다. 여러 줄은 %0A 로 잇는다.
    console.error(`::error::${String(e.message).replace(/\n/g, '%0A')}`);
    console.error(e.message);
    process.exitCode = 1;
  }
}
