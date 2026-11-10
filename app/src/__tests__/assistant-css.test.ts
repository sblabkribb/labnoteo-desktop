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

  it('the pet sits at the CSSOM offsets from the right and bottom edges', () => {
    expect(decl(top, '.pet-wrap', 'position')).toEqual(['fixed']);
    expect(decl(top, '.pet-wrap', 'right')).toEqual(['var(--pet-x)']);
    expect(decl(top, '.pet-wrap', 'bottom')).toEqual(['var(--pet-y)']);
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
