/**
 * port/*.ts 는 플러그인 코드의 복사본이다. 머리말이 출처 범위와 그 해시를 적고, 이 테스트가 지금 vendor 의 범위와
 * 맞춰 본다. vendor 가 새 릴리스로 옮겨 가 범위가 바뀌면 빨갛게 된다(설계상): 조용히 낡은 복사본을 싣지 않는다.
 * 다시 옮기는 법은 docs/superpowers/plans/2026-11-06-notebook-commands.md 의 Global Constraints "Porting rule".
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const PORT_DIR = 'src/labnote/port';
const VENDOR_PREFIX = 'app/vendor/labnoteo/';

const FROM = /^\/\/ Ported from app\/vendor\/labnoteo\/(\S+):(\d+)-(\d+) sha256:([0-9a-f]{16})$/;
const VERSION = /^\/\/ labnoteO \d+\.\d+\.\d+, Apache-2\.0\.$/;
const CHANGES = /^\/\/ Changes: /;

/** 범위(1부터, 양끝 포함)의 줄을 LF 로 이은 글의 SHA-256, 소문자 16진 앞 16글자. scripts/portHash.mjs 와 같다. */
function rangeHash(text: string, from: number, to: number): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n').slice(from - 1, to);
  return createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex').slice(0, 16);
}

/** 포트 파일 하나의 문제. 비어 있으면 머리말이 맞고 vendor 와 어긋나지 않는다. `vendorRoot` 는 vendor/labnoteo 폴더. */
function checkPort(file: string, code: string, vendorRoot = 'vendor/labnoteo'): string[] {
  const lines = code.replace(/\r\n/g, '\n').split('\n');
  const problems: string[] = [];
  const ranges: Array<{ path: string; from: number; to: number; hash: string }> = [];
  let i = 0;
  for (; i < lines.length; i++) {
    const m = FROM.exec(lines[i]);
    if (!m) break;
    ranges.push({ path: m[1], from: Number(m[2]), to: Number(m[3]), hash: m[4] });
  }
  if (ranges.length === 0) return [`${file}: no "// Ported from" line at the top`];
  if (!VERSION.test(lines[i] ?? '')) problems.push(`${file}: line ${i + 1} is not "// labnoteO <version>, Apache-2.0."`);
  else i++;
  if (!CHANGES.test(lines[i] ?? '')) problems.push(`${file}: no "// Changes:" line after the version line`);
  for (const r of ranges) {
    const source = join(vendorRoot, r.path);
    const where = `${VENDOR_PREFIX}${r.path}:${r.from}-${r.to}`;
    if (!existsSync(source)) {
      problems.push(`${file}: ${where} names a vendor file that does not exist`);
      continue;
    }
    const text = readFileSync(source, 'utf-8');
    const count = text.replace(/\r\n/g, '\n').split('\n').length;
    if (r.from < 1 || r.to < r.from || r.to > count || rangeHash(text, r.from, r.to) !== r.hash) {
      problems.push(`port drift: re-port ${file} (${where})`);
    }
  }
  return problems;
}

const ports = readdirSync(PORT_DIR)
  .filter((n) => /\.tsx?$/.test(n))
  .map((n) => `${PORT_DIR}/${n}`);

describe('옮겨 온 코드의 출처', () => {
  it('port/ 에 파일이 있다 (검사가 실제로 무언가를 본다)', () => {
    expect(ports).toEqual(expect.arrayContaining([`${PORT_DIR}/rankPickItems.ts`, `${PORT_DIR}/bilingualName.ts`]));
  });

  // it.each 는 빈 목록이면 아무것도 돌리지 않으므로 위 테스트가 목록이 비지 않았음을 지킨다
  it.each(ports.length ? ports : ['(none)'])('%s: 머리말이 있고 vendor 의 범위와 해시가 맞다', (file) => {
    if (file === '(none)') return;
    expect(checkPort(file, readFileSync(file, 'utf-8'))).toEqual([]);
  });

  it('검사 자체: 해시가 틀린 머리말은 port drift 로 걸린다', () => {
    const header = (hash: string) =>
      [
        `// Ported from app/vendor/labnoteo/src/i18n.ts:36-39 sha256:${hash}`,
        '// labnoteO 0.138.0, Apache-2.0.',
        '// Changes: none.',
        'export {};',
      ].join('\n');
    const right = rangeHash(readFileSync('vendor/labnoteo/src/i18n.ts', 'utf-8'), 36, 39);
    expect(checkPort('port/x.ts', header(right))).toEqual([]);
    expect(checkPort('port/x.ts', header('0000000000000000'))).toEqual([
      'port drift: re-port port/x.ts (app/vendor/labnoteo/src/i18n.ts:36-39)',
    ]);
  });

  it('검사 자체: 머리말이 없거나, 판이나 Changes 줄이 빠졌거나, 없는 파일을 적으면 걸린다', () => {
    expect(checkPort('port/x.ts', 'export {};')).toEqual(['port/x.ts: no "// Ported from" line at the top']);
    expect(
      checkPort('port/x.ts', '// Ported from app/vendor/labnoteo/src/nope.ts:1-2 sha256:0000000000000000\nexport {};'),
    ).toEqual([
      'port/x.ts: line 2 is not "// labnoteO <version>, Apache-2.0."',
      'port/x.ts: no "// Changes:" line after the version line',
      'port/x.ts: app/vendor/labnoteo/src/nope.ts:1-2 names a vendor file that does not exist',
    ]);
  });

  it('scripts/portHash.mjs 는 이 테스트와 같은 해시를 낸다 (CRLF 를 LF 로 보고)', () => {
    const run = (path: string) =>
      execFileSync(process.execPath, ['scripts/portHash.mjs', path, '28', '88'], { encoding: 'utf-8' }).trim();
    const expected = rangeHash(readFileSync('vendor/labnoteo/src/modals.ts', 'utf-8'), 28, 88);
    expect(run('vendor/labnoteo/src/modals.ts')).toBe(expected);
    // 머리말에 적는 저장소 기준 경로도 받는다
    expect(run('app/vendor/labnoteo/src/modals.ts')).toBe(expected);
    expect(rangeHash('a\r\nb\r\nc', 1, 2)).toBe(rangeHash('a\nb\nc', 1, 2));
  });
});
