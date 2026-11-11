import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { declarations, parseRules, STYLE_FILES } from './css';

/** 떠 있는 도우미(assistant spec §4.2, plan Task 5)의 CSS 지킴이. 색 글자·불러오는 순서는 styles.test.ts 가 본다. */
const css = readFileSync('src/styles/assistant.css', 'utf-8');
const rules = parseRules(css);
const decl = (pred: (r: (typeof rules)[number]) => boolean, selector: string, prop: string) =>
  rules
    .filter((r) => pred(r) && r.selectors.includes(selector))
    .flatMap((r) => declarations(r.body))
    .filter((d) => d.prop === prop)
    .map((d) => d.value);
const top = (r: (typeof rules)[number]) => !r.atRule;

describe('styles/assistant.css', () => {
  it('is the last style file', () => {
    expect(STYLE_FILES[STYLE_FILES.length - 1]).toBe('assistant');
  });

  it('the sprite plays its sheet in steps of the skin frame count, pixelated, sized by the CSSOM variables', () => {
    const animation = decl(top, '.pet-sprite', 'animation');
    expect(animation).toEqual(['pet-play var(--pet-dur) steps(var(--pet-frames)) infinite']);
    expect(decl(top, '.pet-sprite', 'image-rendering')).toEqual(['pixelated']);
    expect(decl(top, '.pet-sprite', 'background-image')).toEqual(['var(--pet-sheet)']);
    expect(decl(top, '.pet-sprite', 'width')).toEqual(['calc(var(--pet-w) * var(--pet-scale))']);
    expect(decl(top, '.pet-sprite', 'height')).toEqual(['calc(var(--pet-h) * var(--pet-scale))']);
    const frames = rules.filter((r) => r.atRule === '@keyframes pet-play');
    expect(frames.map((r) => r.selectors[0])).toEqual(['from', 'to']);
    expect(declarations(frames[1].body)).toEqual([
      { prop: 'background-position-x', value: 'calc(var(--pet-w) * var(--pet-frames) * var(--pet-scale) * -1)', important: false },
    ]);
  });

  it('dark themes give the sprite a light, unblurred rim so its dark outline shows on near-black (visual QA)', () => {
    const [filter] = decl(top, '.pet-sprite', 'filter');
    const shadows = filter.match(/drop-shadow\((?:[^()]|\([^()]*\))*\)/g) ?? [];
    expect(shadows).toHaveLength(4);
    // no blur radius: the pixel art stays crisp
    for (const sh of shadows) expect(sh).toMatch(/^drop-shadow\(-?\d+(?:px)? -?\d+(?:px)? 0 var\(--pet-rim\)\)$/);
    const tokens = parseRules(readFileSync('src/styles/tokens.css', 'utf-8'));
    const rim = (sel: string, at?: string) =>
      tokens
        .filter((r) => r.selectors.includes(sel) && r.atRule === at)
        .flatMap((r) => declarations(r.body))
        .filter((d) => d.prop === '--pet-rim')
        .map((d) => d.value);
    expect(rim(':root')).toEqual(['rgba(255, 255, 255, 0)']);
    expect(rim(':root[data-theme="dark"]')).toEqual(['rgba(255, 255, 255, 0.72)']);
    expect(rim(':root:not([data-theme])', '@media (prefers-color-scheme: dark)')).toEqual(['rgba(255, 255, 255, 0.72)']);
  });

  it('the chips sit in rows that they fill evenly (3 + 2, visual QA)', () => {
    expect(decl(top, '.pet-chips', 'flex-direction')).toEqual(['column']);
    expect(decl(top, '.pet-chips-row', 'display')).toEqual(['flex']);
    expect(decl(top, '.pet-chip', 'flex')).toEqual(['1 1 auto']);
  });

  it('the pet sits at the CSSOM offsets from the right and bottom edges', () => {
    expect(decl(top, '.pet-wrap', 'position')).toEqual(['fixed']);
    expect(decl(top, '.pet-wrap', 'right')).toEqual(['var(--pet-x)']);
    expect(decl(top, '.pet-wrap', 'bottom')).toEqual(['var(--pet-y)']);
  });

  it('the bubble is placed by the CSSOM variables (flipped below when there is no room above) and capped to the room left', () => {
    expect(decl(top, '.pet-bubble', 'position')).toEqual(['fixed']);
    expect(decl(top, '.pet-bubble', 'left')).toEqual(['var(--bubble-left, auto)']);
    expect(decl(top, '.pet-bubble', 'bottom')).toEqual(['var(--bubble-bottom, auto)']);
    expect(decl(top, '.pet-bubble[data-side="below"]', 'top')).toEqual(['var(--bubble-top, auto)']);
    expect(decl(top, '.pet-bubble[data-side="below"]', 'bottom')).toEqual(['auto']);
    expect(decl(top, '.pet-bubble', 'max-height')).toEqual(['min(32rem, var(--bubble-max-h, calc(100vh - 8rem)))']);
  });

  it('Korean text in the bubble does not break inside words', () => {
    expect(decl(top, '.pet-bubble', 'word-break')).toEqual(['keep-all']);
  });

  it('reduced motion (media query and html[data-reduced-motion]) stops the sprite: frame 0 of the state stays', () => {
    expect(decl((r) => r.atRule === '@media (prefers-reduced-motion: reduce)', '.pet-sprite', 'animation')).toEqual(['none']);
    expect(decl(top, 'html[data-reduced-motion] .pet-sprite', 'animation')).toEqual(['none']);
  });

  it('forced colors: the pet keeps a visible focus outline and the bubble a border', () => {
    const fc = (r: (typeof rules)[number]) => r.atRule === '@media (forced-colors: active)';
    expect(decl(fc, '.pet:focus-visible', 'outline')).toEqual(['2px solid Highlight']);
    expect(decl(fc, '.pet-bubble', 'border')).toEqual(['1px solid CanvasText']);
  });

  it('citations and source links use the accent colour, not the text-on-accent colour (white on the grey bubble, Task 22)', () => {
    expect(decl(top, '.pet-cite', 'color')).toEqual(['var(--accent)']);
    expect(decl(top, '.pet-source-link', 'color')).toEqual(['var(--accent)']);
  });

  it('a long source title is cut with an ellipsis inside its link, so the link never vanishes into "…" (Task 22)', () => {
    expect(decl(top, '.pet-source', 'display')).toEqual(['flex']);
    expect(decl(top, '.pet-source', 'min-width')).toEqual(['0']);
    expect(decl(top, '.pet-source-link', 'min-width')).toEqual(['0']);
    expect(decl(top, '.pet-source-link', 'overflow')).toEqual(['hidden']);
    expect(decl(top, '.pet-source-link', 'text-overflow')).toEqual(['ellipsis']);
    expect(decl(top, '.pet-source-link', 'white-space')).toEqual(['nowrap']);
  });

  it('only pet selectors (and the layer) live here', () => {
    for (const r of rules.filter((x) => !x.atRule?.startsWith('@keyframes')))
      for (const s of r.selectors) expect(s, s).toMatch(/^(?:html\[data-reduced-motion\] )?(?:#pet-layer|\.pet)/);
  });
});

describe('assistant TSX is CSP-safe', () => {
  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) return name === '__tests__' ? [] : files(p);
      return /\.tsx?$/.test(name) ? [p] : [];
    });
  }
  it('no style prop, style attribute or <style> in src/assistant and the Assistant pane', () => {
    for (const f of [...files('src/assistant'), 'src/ui/settings/AssistantPage.tsx']) {
      const code = readFileSync(f, 'utf-8');
      expect(code, f).not.toMatch(/style=\{|style="|<style|dangerouslySetInnerHTML/);
    }
  });
});
