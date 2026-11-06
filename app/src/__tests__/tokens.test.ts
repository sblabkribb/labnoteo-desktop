import { readFileSync } from 'node:fs';
import { literalColours } from './css';

const css = readFileSync('src/app.css', 'utf-8');

/** 중괄호 짝을 세어 `selector {` 로 시작하는 블록의 안쪽 본문을 꺼낸다. 못 찾으면 던진다(조용히 빈 값을 주지 않는다). */
function block(selector: string, source = css): { body: string; start: number; end: number } {
  const start = source.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`블록을 찾지 못했다: ${selector}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return { body: source.slice(open + 1, i), start, end: i + 1 };
  }
  throw new Error(`닫히지 않은 블록: ${selector}`);
}

function props(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;}]+?)\s*(?:;|$)/g)) out[m[1]] = m[2].trim();
  return out;
}

const SEL = {
  root: ':root',
  media: '@media (prefers-color-scheme: dark)',
  darkSystem: ':root:not([data-theme="light"])',
  dark: ':root[data-theme="dark"]',
  light: ':root[data-theme="light"]',
};
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * `:root` 에서 값이 날것의 색인 사용자 지정 속성은 테마 색 토큰이다. 그런 토큰마다 라이트·다크·시스템 다크 블록 모두에
 * 정의가 있어야 한다: :root 에만 있으면 다크 사용자가 라이트 값을 본다. 빠진 것을 `블록: 토큰` 으로 돌려준다.
 */
function parityGaps(source: string): string[] {
  const root = props(block(SEL.root, source).body);
  const colourTokens = Object.keys(root).filter((k) => literalColours(root[k]).length > 0);
  if (colourTokens.length === 0) throw new Error(':root 에서 색 토큰을 하나도 읽지 못했다');
  const gaps: string[] = [];
  for (const name of ['light', 'dark', 'darkSystem'] as const) {
    const defined = props(block(SEL[name], source).body);
    for (const k of colourTokens) if (!(k in defined)) gaps.push(`${name}: ${k}`);
  }
  return gaps;
}

/** 시스템 다크 @media 안에서 `:root:not([data-theme="light"])` 블록 말고 남는 것. 비어야 한다. */
function mediaExtras(source: string): string {
  const media = block(SEL.media, source).body;
  const inner = block(SEL.darkSystem, media);
  return stripComments(media.slice(0, inner.start) + media.slice(inner.end)).trim();
}

/**
 * 토큰 블록(:root, 라이트, 다크, 시스템 다크 @media) 밖의 날것의 색. 글자 전체에서 #hex 와 색 함수를, 규칙 본문의 선언 값에서
 * 이름 있는 색까지 찾는다(이름 있는 색은 선택자의 낱말과 섞이지 않게 값에서만 찾는다).
 * `transparent`·`currentColor`·`inherit`·`none` 은 색으로 세지 않는다.
 */
function rawColoursOutside(source: string): string[] {
  const blocks = [SEL.light, SEL.dark, SEL.media, SEL.root].map((sel) => block(sel, source));
  let outside = source;
  for (const b of blocks.sort((a, b) => b.start - a.start)) outside = outside.slice(0, b.start) + outside.slice(b.end);
  outside = stripComments(outside);
  if (outside.length < 200) throw new Error('토큰 블록 밖의 규칙을 거의 읽지 못했다');
  const found = [...(outside.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [])];
  for (const m of outside.matchAll(/\{([^{}]*)\}/g)) {
    for (const decl of m[1].split(';')) {
      const value = decl.slice(decl.indexOf(':') + 1);
      if (decl.includes(':')) found.push(...literalColours(value).filter((c) => !c.startsWith('#')));
    }
  }
  return found;
}

const ROOT = block(':root');
const MEDIA = block('@media (prefers-color-scheme: dark)');
const DARK_SYSTEM = block(':root:not([data-theme="light"])');
const DARK = block(':root[data-theme="dark"]');
const LIGHT = block(':root[data-theme="light"]');

const root = props(ROOT.body);
const themes = {
  light: { ...root, ...props(LIGHT.body) },
  dark: { ...root, ...props(DARK.body) },
  darkSystem: { ...root, ...props(DARK_SYSTEM.body) },
};

function lum(hex: string): number {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error(`#rrggbb 가 아니다: ${hex}`);
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function ratio(a: string, b: string): number {
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const REQUIRED = [
  '--bg', '--bg-elevated', '--bg-hover', '--bg-selected', '--bg-selection', '--border', '--border-strong', '--text', '--text-muted',
  '--accent', '--accent-text', '--danger', '--radius', '--space-1', '--space-2', '--space-3', '--space-4', '--space-5',
  '--space-6', '--indent', '--font-ui', '--font-mono', '--font-size',
];

describe('디자인 토큰', () => {
  it('요구한 토큰이 :root 에 모두 있다', () => {
    for (const name of REQUIRED) expect(root[name], name).toBeTruthy();
  });

  it('모든 토큰이 라이트·다크 양쪽에 정의돼 있다', () => {
    const light = Object.keys(props(LIGHT.body)).sort();
    expect(light.length).toBeGreaterThan(8);
    expect(Object.keys(props(DARK.body)).sort()).toEqual(light);
    expect(Object.keys(props(DARK_SYSTEM.body)).sort()).toEqual(light);
    // :root 의 색 토큰은 하나도 빠짐없이 세 테마 블록에 있다 (위 비교는 라이트 블록에서 시작해 :root 에만 있는 토큰을 못 본다)
    expect(parityGaps(css)).toEqual([]);
    // 시스템 다크와 수동 다크는 값도 같아야 한다 (같은 모양이 두 곳에서 갈라지지 않게)
    expect(props(DARK_SYSTEM.body)).toEqual(props(DARK.body));
    // 테마가 바꾸는 토큰은 :root 에도 기본값이 있고, 그 값은 수동 라이트와 같다 (data-theme 없는 시스템 라이트 사용자가 보는 값)
    const lightProps = props(LIGHT.body);
    for (const name of light) expect(root[name], name).toBe(lightProps[name]);
  });

  it('시스템 다크 규칙은 수동 라이트 선택을 덮지 않는다', () => {
    expect(MEDIA.body).toContain(':root:not([data-theme="light"])');
    // @media 안에는 그 블록 하나뿐이다: 다른 규칙이 숨으면 아래의 "블록 밖 날것의 색" 검사도 그것을 보지 못한다
    expect(mediaExtras(css)).toBe('');
  });

  it('토큰 검사기 자기 점검: 일부러 망가뜨린 사본을 잡아낸다', () => {
    // :root 에만 넣은 색 토큰
    expect(parityGaps(css.replace('--danger: #a31d15;', '--danger: #a31d15;\n  --warning: #b45309;'))).toEqual([
      'light: --warning', 'dark: --warning', 'darkSystem: --warning',
    ]);
    // :root 에 있는 숫자·글꼴 토큰은 색이 아니라 테마 블록에 없어도 된다
    expect(parityGaps(css)).toEqual([]);
    // @media 안에 숨긴 두 번째 규칙
    const smuggled = css.replace('    color-scheme: dark;\n  }\n}', '    color-scheme: dark;\n  }\n  .sidebar { background: #000000; }\n}');
    expect(smuggled).not.toBe(css);
    expect(mediaExtras(smuggled)).toBe('.sidebar { background: #000000; }');
    // 블록 밖의 이름 있는 색과 새 색 함수
    for (const bad of ['gray', 'White', 'oklch(0.5 0.1 200)', 'lab(50% 0 0)', 'lch(50% 0 0)', 'hwb(0 0% 0%)', 'color-mix(in srgb, var(--accent), white)', 'color(display-p3 1 0 0)', 'Canvas']) {
      expect(rawColoursOutside(css.replace('.empty-state { color: var(--text-muted); }', `.empty-state { color: ${bad}; }`)), bad).not.toEqual([]);
    }
    for (const ok of ['transparent', 'currentColor', 'inherit', 'none']) {
      expect(rawColoursOutside(css.replace('.empty-state { color: var(--text-muted); }', `.empty-state { color: ${ok}; }`)), ok).toEqual([]);
    }
  });

  it('본문 대비가 두 테마 모두 4.5:1 이상이다', () => {
    for (const [name, t] of Object.entries(themes)) {
      for (const [fg, bg] of [
        ['--text', '--bg'], ['--text-muted', '--bg'], ['--text', '--bg-elevated'], ['--text-muted', '--bg-elevated'],
        ['--text', '--bg-hover'], ['--text-muted', '--bg-hover'], ['--text', '--bg-selected'], ['--text-muted', '--bg-selected'],
        ['--accent-text', '--accent'], ['--accent', '--bg-selected'], ['--accent', '--bg-hover'], ['--danger', '--bg-selected'], ['--danger', '--bg'], ['--danger', '--bg-elevated'],
      ]) {
        expect(ratio(t[fg], t[bg]), `${name} ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('포커스 링·입력 테두리는 배경 대비 3:1 이상이다', () => {
    for (const [name, t] of Object.entries(themes)) {
      for (const fg of ['--accent', '--border-strong']) {
        for (const bg of ['--bg', '--bg-elevated']) expect(ratio(t[fg], t[bg]), `${name} ${fg} on ${bg}`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('선택 행·텍스트 선택은 배경과 눈에 띄게 구분되고, 그 위 글자도 읽힌다', () => {
    for (const [name, t] of Object.entries(themes)) {
      expect(ratio(t['--bg-selected'], t['--bg']), `${name} selected row on bg`).toBeGreaterThanOrEqual(1.5);
      expect(ratio(t['--bg-selection'], t['--bg']), `${name} ::selection on bg`).toBeGreaterThanOrEqual(1.9);
      expect(ratio(t['--text'], t['--bg-selection']), `${name} text on ::selection`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('props 는 세미콜론 없는 마지막 선언도 읽는다', () => {
    expect(props('--a: #111111; --b: #222222')).toEqual({ '--a': '#111111', '--b': '#222222' });
    expect(props('--a: #111111;\n  --b: #222222\n')).toEqual({ '--a': '#111111', '--b': '#222222' });
    expect(props('--a: #111111; color-scheme: dark;')).toEqual({ '--a': '#111111' });
  });

  it('대비 계산이 실제로 틀린 색을 걸러 낸다 (검사기 자체의 자기 점검)', () => {
    expect(ratio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(ratio('#777777', '#808080')).toBeLessThan(1.2);
    expect(() => lum('rgb(0,0,0)')).toThrow();
  });

  it('토큰 블록 밖에는 날것의 색 값이 없다', () => {
    expect(rawColoursOutside(css)).toEqual([]);
  });

  it('CDN 글꼴을 부르지 않는다', () => {
    expect(css).not.toMatch(/@import/);
    expect(css).not.toMatch(/url\(\s*['"]?https?:/);
    expect(css).not.toMatch(/@font-face/);
  });

  it('포커스 링 규칙이 있다', () => {
    const rule = css.match(/:focus-visible\s*\{([^}]*)\}/);
    expect(rule).not.toBeNull();
    expect(rule![1]).toMatch(/outline:\s*2px solid var\(--accent\)/);
  });

  it('트리 들여쓰기는 --indent 토큰으로 계산한다', () => {
    for (let d = 1; d <= 24; d++) expect(css).toContain(`[data-depth="${d}"] { padding-left: calc(var(--indent) * ${d}); }`);
    expect(css).not.toContain('[data-depth="25"]');
  });
});
