/**
 * 코어와 옮겨 온 플러그인 코드의 문장은 coreT(플러그인의 l10n.ko.ts)로 번역된다. 그 목록에 없는 키는 한국어 화면에서
 * 영어로 나온다. KO_ROOTS 의 coreT( / host.t( / paletteName( 첫 인자에 적힌 글자는 모두 obsidianKo 에 있어야 한다.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
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
  // 같은 파일 위쪽의 `const NAME = '...'` 상수. 아래 '상수 인자의 글자도 obsidianKo 에 있다' 가 그 글자를 확인한다.
  'src/integrations/IntegrationSettingsDialog.tsx': ['CLEARTEXT', 'FULL_ADDRESS'],
};

/** DYNAMIC_ARGS 의 대문자 이름 인자: 같은 파일의 `const NAME = '글자'` 에서 글자를 찾는다(없으면 undefined). */
function constantLiteral(code: string, name: string): string | undefined {
  const line = code.split('\n').find((l) => l.startsWith(`const ${name} = `));
  return line === undefined ? undefined : literals(line.slice(`const ${name} = `.length))[0];
}

/** 검사하는 폴더. SP6 의 연동 폴더도 본다. 아직 없는 폴더는 건너뛴다. */
const KO_ROOTS = ['src/labnote', 'src/integrations', 'src/partbank', 'src/ai', 'src/bfworkflow'];

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

describe('KO_ROOTS 가 코어 번역에 넘기는 키', () => {
  const files = KO_ROOTS.filter((root) => existsSync(root))
    .flatMap(sources)
    .map((f) => ({ f, code: readFileSync(f, 'utf-8') }));

  it('scans every SP6 folder, not only src/labnote', () => {
    expect(KO_ROOTS).toEqual(['src/labnote', 'src/integrations', 'src/partbank', 'src/ai', 'src/bfworkflow']);
    expect(files.map((x) => x.f)).toContain('src/integrations/IntegrationSettingsDialog.tsx'); // 새 폴더도 실제로 읽었다
  });

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

  it('상수 인자의 글자도 obsidianKo 에 있다', () => {
    const bad = Object.entries(DYNAMIC_ARGS).flatMap(([f, args]) =>
      args
        .filter((a) => /^[A-Z][A-Z0-9_]*$/.test(a))
        .flatMap((a) => {
          const key = constantLiteral(readFileSync(f, 'utf-8'), a);
          return key !== undefined && Object.hasOwn(obsidianKo, key) ? [] : [`${f}: ${a} = ${String(key)}`];
        }),
    );
    expect(bad).toEqual([]);
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
