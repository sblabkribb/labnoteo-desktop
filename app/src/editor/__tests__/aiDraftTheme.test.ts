/**
 * AI 초안 검토 표시(live/aiDraftReview.ts)의 테마 규칙. 브라우저 없이 editorThemeSpec 을 계단식으로 읽는다: 한 줄에 붙는 클래스
 * 묶음에서 이기는 선언(특이도가 높거나, 같으면 뒤의 것)을 고른다. 녹화(2026-11-12)에서 찾은 두 가지를 지킨다:
 *  - "검토 완료" 단추의 글자가 그 바탕과 같은 색(라이트: 흰 글자, 흰 바탕)이었다.
 *  - Unit Operation 카드 안의 초안 줄(계획·Method 초안은 늘 카드 안이다)은 카드 규칙이 뒤에 있어 초안 바탕·선을 잃었다.
 */
import { readFileSync } from 'node:fs';
import { editorThemeSpec } from '../theme';
import { compareSpecificity, declarations, parseRules, specificity } from '../../__tests__/css';

type Decls = Record<string, string>;
const spec = editorThemeSpec as unknown as Record<string, Decls>;

/** 선택자가 `.a.b` 꼴(클래스만, 한 요소)이고 그 클래스가 모두 `classes` 에 있으면 true. */
function matches(selector: string, classes: readonly string[]): boolean {
  const s = selector.trim();
  if (!/^(\.[\w-]+)+$/.test(s)) return false;
  return s
    .split('.')
    .filter(Boolean)
    .every((c) => classes.includes(c));
}

/** `classes` 를 단 요소에서 `prop`(camelCase) 의 이기는 값. 단축 속성(borderLeft)은 그 이름 그대로만 본다. */
function winning(classes: readonly string[], prop: string): string | undefined {
  let best: { spec: number[]; value: string } | undefined;
  for (const [key, decls] of Object.entries(spec)) {
    if (!decls || typeof decls !== 'object' || !(prop in decls)) continue;
    for (const sel of key.split(',')) {
      if (!matches(sel, classes)) continue;
      const sp = specificity(sel.trim());
      if (!best || compareSpecificity(sp, best.spec) >= 0) best = { spec: sp, value: String(decls[prop]) };
    }
  }
  return best?.value;
}

/** tokens.css 의 라이트·다크 블록 토큰 값. */
function themes(): Record<'light' | 'dark', Record<string, string>> {
  const rules = parseRules(readFileSync('src/styles/tokens.css', 'utf-8'));
  const props = (selectors: string[]) => {
    const r = rules.find((x) => !x.atRule && x.selectors.join(',') === selectors.join(','));
    if (!r) throw new Error(`no block ${selectors.join(', ')}`);
    return Object.fromEntries(declarations(r.body.replace(/;\s*$/, '')).filter((d) => d.prop.startsWith('--')).map((d) => [d.prop, d.value]));
  };
  return { light: props([':root', ':root[data-theme="light"]']), dark: props([':root[data-theme="dark"]']) };
}

function rgb(v: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(v.trim());
  if (!m) throw new Error(`not an opaque #rrggbb colour: ${v}`);
  return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) as [number, number, number];
}
const lum = (c: [number, number, number]) => {
  const [r, g, b] = c.map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: string, b: string) => {
  const [x, y] = [lum(rgb(a)), lum(rgb(b))];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
const token = (t: Record<string, string>, v: string) => {
  const m = /^var\((--[\w-]+)\)$/.exec(v.trim());
  if (!m || !(m[1] in t)) throw new Error(`not a token: ${v}`);
  return t[m[1]];
};

describe('AI draft review theme', () => {
  it('the Done button label reads on its own background in light and dark (4.5:1)', () => {
    const cls = ['cm-ai-draft-done'];
    const color = winning(cls, 'color')!;
    const bg = winning(cls, 'backgroundColor')!;
    for (const [name, t] of Object.entries(themes())) {
      expect(ratio(token(t, color), token(t, bg)), `${name}: ${color} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('a draft line inside a Unit Operation card keeps the draft tint and the 2px accent line', () => {
    for (const card of [
      ['cm-uo-card'],
      ['cm-uo-card', 'cm-uo-card-active'],
      ['cm-uo-card', 'cm-uo-card-first'],
      ['cm-uo-card', 'cm-uo-card-last', 'cm-uo-card-active'],
    ]) {
      const cls = ['cm-line', 'cm-ai-draft', ...card];
      expect(winning(cls, 'backgroundColor'), card.join(' ')).toBe('var(--accent-soft)');
      expect(winning(cls, 'borderLeft'), card.join(' ')).toBe('2px solid var(--accent)');
    }
  });

  it('a draft line outside a card still has the draft tint and line', () => {
    expect(winning(['cm-line', 'cm-ai-draft'], 'backgroundColor')).toBe('var(--accent-soft)');
    expect(winning(['cm-line', 'cm-ai-draft'], 'borderLeft')).toBe('2px solid var(--accent)');
  });
});
