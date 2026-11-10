import { readFileSync } from 'node:fs';
import { allCss, declarations, literalColours, parseRules, SYSTEM_COLOURS, type Rule } from './css';

/** 토큰 블록(라이트 = :root, 다크, 시스템 다크, 고대비 대응, 인쇄의 라이트 값)이 있는 파일. */
const css = readFileSync('src/styles/tokens.css', 'utf-8');
/** 앱 스타일 전부(불러오는 순서대로). 토큰 블록 밖의 규칙과 날것의 색 검사는 이것을 읽는다. */
const all = allCss();

/** 테마 블록의 선택자(spec §2.2): 각 값은 테마마다 한 번 정의한다. 다크는 속성 블록과 시스템 @media 블록 두 곳이고 같아야 한다. */
const LIGHT_SELECTORS = [':root', ':root[data-theme="light"]'];
const DARK_SELECTORS = [':root[data-theme="dark"]'];
const DARK_SYSTEM_SELECTORS = [':root:not([data-theme])'];
const DARK_MEDIA = '@media (prefers-color-scheme: dark)';
const PRINT_SELECTORS = [':root[data-theme]', ':root:not([data-theme])'];

const same = (a: string[], b: string[]) => a.length === b.length && a.every((s, i) => s === b[i]);

/** 선택자 목록과 @-규칙 머리가 정확히 맞는 규칙. 하나가 아니면 던진다(조용히 빈 값을 주지 않는다). */
function only(rules: Rule[], selectors: string[], atRule?: string): Rule {
  const hits = rules.filter((r) => same(r.selectors, selectors) && r.atRule === atRule);
  if (hits.length !== 1) throw new Error(`${atRule ?? ''} ${selectors.join(', ')}: 규칙이 ${hits.length}개`);
  return hits[0];
}

/** 규칙 본문의 사용자 지정 속성(--x)만. */
function props(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const d of declarations(body.replace(/;\s*$/, ''))) if (d.prop.startsWith('--')) out[d.prop] = d.value;
  return out;
}

function themeBlocks(source: string) {
  const rules = parseRules(source);
  return {
    rules,
    light: only(rules, LIGHT_SELECTORS),
    dark: only(rules, DARK_SELECTORS),
    darkSystem: only(rules, DARK_SYSTEM_SELECTORS, DARK_MEDIA),
    statics: only(rules, [':root']),
  };
}

const isColourToken = (v: string) => literalColours(v).length > 0;

/** 라이트 블록의 색 토큰마다 다크·시스템 다크 블록에 정의가 있는지. 빠진 것(또는 남는 것)을 `블록: 토큰` 으로 돌려준다. */
function parityGaps(source: string): string[] {
  const b = themeBlocks(source);
  const light = props(b.light.body);
  const colourTokens = Object.keys(light).filter((k) => isColourToken(light[k]));
  if (colourTokens.length === 0) throw new Error('라이트 블록에서 색 토큰을 하나도 읽지 못했다');
  const gaps: string[] = [];
  for (const name of ['dark', 'darkSystem'] as const) {
    const defined = props(b[name].body);
    for (const k of colourTokens) if (!(k in defined)) gaps.push(`${name}: ${k}`);
    for (const k of Object.keys(defined)) if (!colourTokens.includes(k)) gaps.push(`${name} extra: ${k}`);
  }
  // 색 토큰은 테마와 무관한 :root 블록에 두지 않는다(그러면 다크 사용자가 라이트 값을 본다)
  const statics = props(b.statics.body);
  for (const k of Object.keys(statics)) if (isColourToken(statics[k])) gaps.push(`static: ${k}`);
  return gaps;
}

const SYSTEM = new Set(SYSTEM_COLOURS);

/**
 * 토큰 블록(라이트, 다크, 시스템 다크, 인쇄 토큰) 밖의 날것의 색. 모든 규칙의 선언 값에서 #hex, 색 함수, 이름 있는 색을 찾는다.
 * `transparent`·`currentColor`·`inherit`·`none` 은 색이 아니다. forced-colors @media 안에서는 CSS 시스템 색만 허용한다.
 */
function rawColoursOutside(source: string): string[] {
  const found: string[] = [];
  for (const r of parseRules(source)) {
    const tokenBlock =
      (!r.atRule && (same(r.selectors, LIGHT_SELECTORS) || same(r.selectors, DARK_SELECTORS))) ||
      (r.atRule === DARK_MEDIA && same(r.selectors, DARK_SYSTEM_SELECTORS)) ||
      (r.atRule === '@media print' && same(r.selectors, PRINT_SELECTORS));
    if (tokenBlock) continue;
    const forced = r.atRule?.includes('forced-colors') ?? false;
    for (const d of declarations(r.body.replace(/;\s*$/, ''))) {
      found.push(...literalColours(d.value).filter((c) => !(forced && SYSTEM.has(c.toLowerCase()))));
    }
  }
  return found;
}

// ── WCAG 대비 ──

type RGB = [number, number, number];
type RGBA = [number, number, number, number];

/** `#rgb`, `#rrggbb`, `rgb(r, g, b)`, `rgba(r, g, b, a)` 만 읽는다. 그 밖의 모양은 던진다(대비를 잴 수 없는 토큰이 표에 들어오면 알게). */
function parseColour(v: string): RGBA {
  const s = v.trim();
  let m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) return [...[...m[1]].map((c) => parseInt(c + c, 16)), 1] as RGBA;
  m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16), 1];
  m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(s);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
  throw new Error(`대비를 잴 수 없는 색: ${v}`);
}

/** 반투명 색을 불투명 바탕 위에 겹친 결과. */
function composite(top: RGBA, under: RGB): RGB {
  const a = top[3];
  return [0, 1, 2].map((i) => top[i] * a + under[i] * (1 - a)) as RGB;
}

function lum([r, g, b]: RGB): number {
  const [R, G, B] = [r, g, b].map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

function ratioRgb(a: RGB, b: RGB): number {
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** 테마 `t` 에서 글자 토큰 `fg` 를 바탕 토큰 `bg` 위에 놓았을 때의 대비. 반투명 바탕은 --bg 위에, 반투명 글자는 그 바탕 위에 겹친다. */
function contrast(t: Record<string, string>, fg: string, bg: string): number {
  const base = parseColour(t['--bg']);
  if (base[3] !== 1) throw new Error('--bg 는 불투명해야 한다');
  const page: RGB = [base[0], base[1], base[2]];
  const surface = composite(parseColour(t[bg]), page);
  const text = composite(parseColour(t[fg]), surface);
  return ratioRgb(text, surface);
}

const blocks = themeBlocks(css);
const statics = props(blocks.statics.body);
const themes = {
  light: { ...statics, ...props(blocks.light.body) },
  dark: { ...statics, ...props(blocks.dark.body) },
  darkSystem: { ...statics, ...props(blocks.darkSystem.body) },
};

const TEXT = ['--text', '--text-muted', '--accent', '--danger', '--warning', '--success'];
const SURFACES = ['--bg', '--bg-side', '--bg-hover', '--bg-selected', '--menu-bg'];

/** 표 전체를 재고 모자란 쌍을 `테마 fg on bg = 비` 로 돌려준다. */
function contrastFailures(t: Record<string, string>, name: string): string[] {
  const out: string[] = [];
  const need = (fg: string, bg: string, min: number) => {
    const r = contrast(t, fg, bg);
    if (r < min) out.push(`${name} ${fg} on ${bg} = ${r.toFixed(2)} < ${min}`);
  };
  for (const fg of TEXT) for (const bg of SURFACES) need(fg, bg, 4.5);
  for (const bg of SURFACES) need('--text-faint', bg, 3);
  need('--accent-text', '--accent-fill', 4.5);
  need('--accent-text', '--accent-fill-hover', 4.5);
  // 채운 위험 단추(확인 단계)의 글자는 --bg 다
  need('--bg', '--danger', 4.5);
  // 글자가 반투명 바탕(텍스트 선택, 칩) 위에 놓여도 읽힌다
  need('--text', '--bg-selection', 4.5);
  need('--text', '--accent-soft', 4.5);
  need('--text-muted', '--accent-soft', 4.5);
  // 찾기에 맞은 글자(<mark>)는 그 칠 위에서도 읽힌다
  need('--text', '--search-hit', 4.5);
  // 포커스 링(강조색)은 바탕 대비 3:1 이상
  for (const bg of SURFACES) need('--accent', bg, 3);
  return out;
}

const REQUIRED = [
  '--bg', '--bg-side', '--bg-ribbon', '--bg-elevated', '--menu-bg', '--bg-hover', '--bg-selected', '--bg-selection', '--border',
  '--border-strong', '--guide', '--text', '--text-muted', '--text-faint', '--accent', '--accent-fill', '--accent-fill-hover', '--accent-text',
  '--accent-soft', '--search-hit', '--danger', '--warning', '--success', '--shadow', '--shadow-menu', '--scrim', '--checker-a', '--checker-b',
  '--radius', '--radius-s', '--radius-m', '--radius-l', '--radius-xl',
  '--space-1', '--space-2', '--space-3', '--space-4', '--space-5', '--space-6', '--space-7', '--space-8',
  '--row-h', '--ribbon-w', '--side-w', '--right-w', '--viewheader-h', '--statusbar-h',
  '--indent', '--font-ui', '--font-mono', '--font-size',
];

describe('디자인 토큰', () => {
  it('요구한 토큰이 라이트·다크 모두에 있다', () => {
    for (const [name, t] of Object.entries(themes)) for (const k of REQUIRED) expect(t[k], `${name} ${k}`).toBeTruthy();
  });

  it('간격 눈금은 2·4·6·8·12·16·24·32px, 둥글기는 4·6·8·10px 이고 --radius 는 --radius-m 이다', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((i) => statics[`--space-${i}`])).toEqual(['2px', '4px', '6px', '8px', '12px', '16px', '24px', '32px']);
    expect(['s', 'm', 'l', 'xl'].map((k) => statics[`--radius-${k}`])).toEqual(['4px', '6px', '8px', '10px']);
    expect(statics['--radius']).toBe('var(--radius-m)');
    expect(statics['--row-h']).toBe('28px');
  });

  it('테마 블록은 세 개뿐이고, 색 토큰은 세 블록 모두에 있으며 두 다크 블록은 같다', () => {
    expect(parityGaps(css)).toEqual([]);
    expect(props(blocks.darkSystem.body)).toEqual(props(blocks.dark.body));
    expect(Object.keys(props(blocks.light.body)).length).toBeGreaterThan(20);
    // 시스템 다크 @media 안에는 그 블록 하나뿐이다: 다른 규칙이 숨지 않는다
    expect(blocks.rules.filter((r) => r.atRule === DARK_MEDIA)).toHaveLength(1);
    // 예전 모양(:root:not([data-theme="light"]))은 없다: System 은 속성을 지우므로 :not([data-theme]) 로 충분하다
    expect(css).not.toContain(':root:not([data-theme="light"])');
    // color-scheme 도 테마마다 정한다
    expect(declarations(blocks.light.body).find((d) => d.prop === 'color-scheme')?.value).toBe('light');
    expect(declarations(blocks.dark.body).find((d) => d.prop === 'color-scheme')?.value).toBe('dark');
    expect(declarations(blocks.darkSystem.body).find((d) => d.prop === 'color-scheme')?.value).toBe('dark');
  });

  it('토큰 검사기 자기 점검: 일부러 망가뜨린 사본을 잡아낸다', () => {
    const lightBody = blocks.light.body;
    // 라이트에만 넣은 색 토큰
    const probe = css.replace('--danger: #b3261e;', '--danger: #b3261e;\n  --probe: #b45309;');
    expect(probe).not.toBe(css);
    expect(parityGaps(probe)).toEqual(['dark: --probe', 'darkSystem: --probe']);
    // 테마와 무관한 :root 블록에 넣은 색 토큰
    expect(parityGaps(css.replace('--radius-s: 4px;', '--radius-s: 4px;\n  --oops: #123456;'))).toEqual(['static: --oops']);
    // @media 안에 숨긴 두 번째 규칙
    const smuggled = css.replace(`${DARK_MEDIA} {`, `${DARK_MEDIA} {\n  .sidebar { background: #000000; }`);
    expect(smuggled).not.toBe(css);
    expect(parseRules(smuggled).filter((r) => r.atRule === DARK_MEDIA)).toHaveLength(2);
    expect(rawColoursOutside(smuggled)).toEqual(['#000000']);
    // 블록 밖의 이름 있는 색과 새 색 함수
    expect(all).toContain('.empty-state { color: var(--text-muted); }');
    for (const bad of ['gray', 'White', 'oklch(0.5 0.1 200)', 'lab(50% 0 0)', 'color-mix(in srgb, var(--accent), white)', 'Canvas']) {
      expect(rawColoursOutside(all.replace('.empty-state { color: var(--text-muted); }', `.empty-state { color: ${bad}; }`)), bad).not.toEqual([]);
    }
    expect(rawColoursOutside(`${all}\n@media (forced-colors: active) { .probe { outline-color: Highlight; } }`)).toEqual([]);
    expect(rawColoursOutside(`${all}\n@media (forced-colors: active) { .probe { outline-color: red; } }`)).toEqual(['red']);
    for (const ok of ['transparent', 'currentColor', 'inherit', 'none']) {
      expect(rawColoursOutside(all.replace('.empty-state { color: var(--text-muted); }', `.empty-state { color: ${ok}; }`)), ok).toEqual([]);
    }
    expect(lightBody).toContain('--text-muted');
  });

  it('대비 표: 두 테마 모두 글자 4.5:1, 흐린 표시 3:1, 강조 채움 위 글자 4.5:1 이상이다', () => {
    for (const [name, t] of Object.entries(themes)) expect(contrastFailures(t, name)).toEqual([]);
  });

  it('대비 표 자기 점검: 값을 낮추면 실제로 걸린다', () => {
    // 라이트 --text-muted 를 예전 입력 테두리색으로 내리면 표가 실패한다
    const weak = { ...themes.light, '--text-muted': '#8a8a94' };
    expect(contrastFailures(weak, 'light').some((f) => f.startsWith('light --text-muted on'))).toBe(true);
    // 흐린 표시를 더 흐리게 하면 3:1 아래로 내려간다
    expect(contrastFailures({ ...themes.dark, '--text-faint': '#555555' }, 'dark').some((f) => f.includes('--text-faint'))).toBe(true);
    // 반투명 바탕은 --bg 위에 겹쳐 잰다: 흰 바탕의 10% 검정은 거의 흰색이다
    expect(contrast({ '--bg': '#ffffff', '--a': '#000000', '--s': 'rgba(0, 0, 0, 0.1)' }, '--a', '--s')).toBeGreaterThan(15);
    expect(contrast({ '--bg': '#000000', '--a': '#000000', '--s': 'rgba(0, 0, 0, 0.1)' }, '--a', '--s')).toBeCloseTo(1, 5);
    expect(ratioRgb([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5);
    expect(() => parseColour('oklch(0.5 0.1 200)')).toThrow();
    expect(parseColour('#abc')).toEqual([170, 187, 204, 1]);
  });

  it('선택 행·텍스트 선택은 바탕과 구분된다', () => {
    for (const [name, t] of Object.entries(themes)) {
      expect(contrast(t, '--bg-selected', '--bg'), `${name} selected row`).toBeGreaterThanOrEqual(1.2);
      expect(contrast(t, '--bg-selection', '--bg'), `${name} ::selection`).toBeGreaterThanOrEqual(1.2);
    }
  });

  it('편집기 밖의 텍스트 선택은 배경과 글자색을 함께 정한다', () => {
    const rules = parseRules(all).filter((r) => !r.atRule && r.selectors.includes('::selection'));
    expect(rules).toHaveLength(1);
    const decl = Object.fromEntries(declarations(rules[0].body).map((d) => [d.prop, d.value]));
    expect(decl.background).toBe('var(--bg-selection)');
    expect(decl.color).toBe('var(--text)');
  });

  it('--text-faint 는 글자가 아닌 표시에만 쓴다 (svg, .chev, .sep, ::before/::after)', () => {
    const misuse = parseRules(all)
      .filter((r) => declarations(r.body.replace(/;\s*$/, '')).some((d) => d.prop === 'color' && d.value.includes('var(--text-faint)')))
      .flatMap((r) => r.selectors)
      .filter((s) => !/(^|[\s>])svg$|\.chev$|\.sep$|::?(before|after)$/.test(s));
    expect(misuse).toEqual([]);
  });

  it('토큰 블록 밖에는 날것의 색 값이 없다', () => {
    expect(rawColoursOutside(all)).toEqual([]);
  });

  it('고대비(forced-colors)에서 강조색과 테두리는 시스템 색을 쓴다', () => {
    const forced = parseRules(css).filter((r) => r.atRule?.includes('forced-colors'));
    expect(forced).toHaveLength(1);
    const p = props(forced[0].body);
    expect(p['--accent']).toBe('Highlight');
    expect(p['--border']).toBe('CanvasText');
    // 테마 블록(특이도 0,2,0)을 이기려면 같은 특이도로 뒤에 온다
    expect(forced[0].selectors).toEqual(expect.arrayContaining([':root[data-theme]', ':root:not([data-theme])']));
    expect(forced[0].order).toBeGreaterThan(blocks.darkSystem.order);
    // 앱 전체의 forced-colors 규칙은 열린 줄·고른 항목·포커스 링을 다시 그린다
    const fc = parseRules(all).filter((r) => r.atRule?.includes('forced-colors')).flatMap((r) => r.selectors).join(' ');
    expect(fc).toMatch(/\[aria-current\]/);
    expect(fc).toMatch(/\[aria-selected="true"\]/);
    expect(fc).toMatch(/:focus-visible/);
  });

  it('CDN 글꼴을 부르지 않는다', () => {
    expect(all).not.toMatch(/@import/);
    expect(all).not.toMatch(/url\(\s*['"]?https?:/);
    expect(all).not.toMatch(/@font-face/);
  });

  it('포커스 링 규칙이 있다', () => {
    const rule = parseRules(all).find((r) => !r.atRule && same(r.selectors, [':focus-visible']));
    expect(rule).toBeDefined();
    expect(rule!.body).toMatch(/outline:\s*2px solid var\(--accent\)/);
  });

  it('print forces the light colour tokens over every dark block', () => {
    const printRules = parseRules(css).filter((r) => r.atRule === '@media print' && r.selectors.some((sel) => sel.startsWith(':root')));
    expect(printRules).toHaveLength(1);
    const p = printRules[0];
    expect(p.selectors).toEqual(PRINT_SELECTORS);
    expect(p.order).toBeGreaterThan(Math.max(blocks.dark.order, blocks.darkSystem.order));
    const values = Object.fromEntries(declarations(p.body.replace(/;\s*$/, '')).map((d) => [d.prop, d.value]));
    const light = props(blocks.light.body);
    for (const k of Object.keys(light)) if (isColourToken(light[k])) expect(values[k], k).toBe(light[k]);
    expect(values['color-scheme']).toBe('light');
  });
});
