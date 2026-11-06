/**
 * 코어와 옮겨 온 플러그인 코드의 문장은 coreT(플러그인의 l10n.ko.ts)로 번역된다. 그 목록에 없는 키는 한국어 화면에서
 * 영어로 나온다. src/labnote 의 coreT( / host.t( / paletteName( 첫 인자에 적힌 글자는 모두 obsidianKo 에 있어야 한다.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import obsidianKo from '../../../vendor/labnoteo/src/l10n.ko';
import { firstArgsOf } from '../../i18n/__tests__/callArgs';

// `function paletteName(` 은 부르는 곳이 아니라 정의다. `this.host.t(` 도 `host.t(` 로 잡힌다.
const CALLEE = /(?<![\w$]|function\s+)(?:coreT|paletteName|host\.t)\(/g;

const QUOTED = new RegExp(String.raw`'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"`, 'g');
/** 글자 안의 \' 같은 이스케이프를 풀어 키 원문으로 만든다. */
const unescape = (s: string) => s.replace(/\\(.)/g, '$1');
const literals = (code: string) => [...code.matchAll(QUOTED)].map((m) => unescape(m[1] ?? m[2]));

/**
 * 글자가 하나도 없는 첫 인자: "파일 경로": [인자 글자(앞뒤 공백 뺀 것)]. 새 항목에는 그 키가 어디서 오는지
 * (그리고 그 글자들이 obsidianKo 에 있음을 무엇이 지키는지) 주석으로 이유를 단다.
 */
const DYNAMIC_ARGS: Record<string, string[]> = {
  // 등록된 명령의 nameKey. commands/__tests__/registry.test.ts 가 registerAllCommands 뒤 모든 nameKey 가 obsidianKo 에 있는지 본다.
  'src/labnote/ui/CommandPalette.tsx': ['c.nameKey'],
};

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === '__tests__' ? [] : sources(p);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p.split('\\').join('/')] : [];
  });
}

/** 파일 하나에서 찾은 키와, 글자가 없어 DYNAMIC_ARGS 에 적어야 하는 인자. */
function scan(f: string, code: string) {
  const keys: string[] = [];
  const dynamic: string[] = [];
  for (const arg of firstArgsOf(code, CALLEE)) {
    const found = literals(arg);
    if (found.length === 0 && !(DYNAMIC_ARGS[f] ?? []).includes(arg.trim())) dynamic.push(`${f}: ${arg.trim()}`);
    keys.push(...found);
  }
  return { keys, dynamic };
}

describe('src/labnote 가 코어 번역에 넘기는 키', () => {
  const files = sources('src/labnote').map((f) => ({ f, code: readFileSync(f, 'utf-8') }));

  it('글자 키는 모두 obsidianKo 에 있다', () => {
    const missing = files.flatMap(({ f, code }) =>
      scan(f, code)
        .keys.filter((k) => !Object.hasOwn(obsidianKo, k))
        .map((k) => `${f}: ${k}`),
    );
    expect(missing).toEqual([]);
    expect(files.map((x) => x.f)).toContain('src/labnote/i18n.ts'); // 소스를 실제로 읽었다
  });

  it('글자가 없는 첫 인자는 DYNAMIC_ARGS 에 이유와 함께 적혀 있다', () => {
    expect(files.flatMap(({ f, code }) => scan(f, code).dynamic)).toEqual([]);
  });

  it('검사 자체: 줄을 넘는 중첩 삼항의 host.t 셋에서 키 셋을 찾는다', () => {
    const code = `host.notify(
      'warn',
      reason === 'a'
        ? host.t(
            'First reason.'
          )
        : reason === 'b'
        ? this.host.t('Second reason, with a comma.')
        : host.t("Third \\"quoted\\" reason.", 2)
    );
    export function paletteName(key: string) {}`;
    expect(scan('src/labnote/x.ts', code)).toEqual({
      keys: ['First reason.', 'Second reason, with a comma.', 'Third "quoted" reason.'],
      dynamic: [],
    });
    expect(scan('src/labnote/x.ts', 'coreT(key) + paletteName(cond ? \'A\' : "B")')).toEqual({
      keys: ['A', 'B'],
      dynamic: ['src/labnote/x.ts: key'],
    });
  });
});
