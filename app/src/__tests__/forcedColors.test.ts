/**
 * 고대비(forced-colors)에서도 초점이 보인다. 고대비는 상자 그림자를 지우고 테두리 색을 바꾸므로, 윤곽선을 지운(outline: none)
 * 규칙은 (가) 같은 대상의 :focus-visible 이 보이는 윤곽선을 다시 그리거나(초점 상태가 아닌 규칙만), (나) forced-colors 블록에
 * `outline: 2px solid Highlight` 짝이 있어야 한다. 짝은 지운 규칙보다 특이도가 낮지 않고, 같으면 뒤에 와서 이긴다.
 */
import { describe, expect, it } from 'vitest';
import { allCss, compareSpecificity, declarations, parseRules, specificity, type Rule } from './css';

const rules = parseRules(allCss());
const inForced = (r: Rule) => !!r.atRule?.includes('forced-colors');
const plain = rules.filter((r) => !r.atRule || !/print|forced-colors|prefers-reduced-motion/.test(r.atRule));
const forced = rules.filter(inForced);

/** 상태(초점·마우스·펼침)를 떼어 낸 대상 선택자. */
const STATE = /:focus-visible|:focus-within|:focus|:hover|:not\((?:[^()]|\([^()]*\))*\)|\[aria-expanded="true"\]/g;
const base = (sel: string) => sel.replace(STATE, '').trim();

function outlineOf(r: Rule): string | undefined {
  let out: string | undefined;
  for (const d of declarations(r.body)) {
    if (d.prop === 'outline' || d.prop === 'outline-style') out = d.value;
  }
  return out;
}
const removesOutline = (r: Rule) => /^(none|0)$/.test(outlineOf(r) ?? '');
const drawsOutline = (r: Rule) => {
  const v = outlineOf(r);
  return !!v && /solid|auto|dashed|dotted|double/.test(v);
};
const HIGHLIGHT = /outline:\s*2px solid Highlight/i;

/** 선택자 sel 을 이기는 짝: 같은 대상의 초점 상태에 보이는 윤곽선. */
function counterpart(sel: string, rule: Rule, pool: Rule[], need: RegExp): Rule | undefined {
  const b = base(sel);
  const spec = specificity(sel);
  return pool.find(
    (r) =>
      need.test(r.body) &&
      drawsOutline(r) &&
      r.selectors.some((s) => {
        if (base(s) !== b || !/:focus-visible|:focus-within/.test(s)) return false;
        const c = compareSpecificity(specificity(s), spec);
        return c > 0 || (c === 0 && r.order > rule.order);
      }),
  );
}

describe('forced-colors focus', () => {
  it('every outline: none has a visible :focus-visible replacement or a forced-colors pair', () => {
    const offenders: string[] = [];
    for (const rule of plain.filter(removesOutline)) {
      for (const sel of rule.selectors) {
        const replaced = !/:focus/.test(sel) && counterpart(sel, rule, plain, /outline/);
        const paired = counterpart(sel, rule, forced, HIGHLIGHT);
        if (!replaced && !paired) offenders.push(sel);
      }
    }
    expect(offenders).toEqual([]);
  });

  it.each(['.context-menu-item', '.input', 'textarea', '.context-menu', '.select-menu-list'])(
    '%s has a forced-colors focus outline in Highlight',
    (target) => {
      const hit = forced.some((r) => r.selectors.some((s) => base(s) === target && /:focus-visible/.test(s)) && HIGHLIGHT.test(r.body));
      expect(hit, target).toBe(true);
    },
  );

  it('the active option of a select menu (aria-activedescendant) is outlined in forced colors', () => {
    expect(forced.some((r) => r.selectors.includes('.select-menu-list [role="option"][data-active]') && HIGHLIGHT.test(r.body))).toBe(true);
  });

  it('a returned focus ring ([data-focus-ring]) draws a visible outline', () => {
    const ring = plain.find((r) => r.selectors.includes('[data-focus-ring]:focus'));
    expect(!!ring && drawsOutline(ring)).toBe(true);
  });

  it('self-check: catches an outline: none without a pair and accepts one with a pair', () => {
    const bad = parseRules('.a:focus { outline: none; } @media (forced-colors: active) { .b:focus-visible { outline: 2px solid Highlight; } }');
    expect(counterpart('.a:focus', bad[0], bad.filter(inForced), HIGHLIGHT)).toBeUndefined();
    const ok = parseRules('.a:focus { outline: none; } @media (forced-colors: active) { .a:focus-visible { outline: 2px solid Highlight; } }');
    expect(counterpart('.a:focus', ok[0], ok.filter(inForced), HIGHLIGHT)).toBeTruthy();
    // 짝이 앞에 있고 특이도가 같으면 진다
    const early = parseRules('@media (forced-colors: active) { .a:focus-visible { outline: 2px solid Highlight; } } .a:focus { outline: none; }');
    expect(counterpart('.a:focus', early[1], early.filter(inForced), HIGHLIGHT)).toBeUndefined();
  });
});
