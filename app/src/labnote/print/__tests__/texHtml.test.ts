import { describe, expect, it } from 'vitest';
import { texToHtml } from '../../port/texHtml';

// Mirrors vendor tests/plugin/texHtml.test.ts (#434): a printed worksheet has no
// math renderer, so what texToHtml reads is printed and what it does not, it refuses.
describe('texToHtml', () => {
  it('reads the spacing a number and its unit are written with', () => {
    expect(texToHtml('3\\,mL')).toBe('3 mL');
    expect(texToHtml('3\\;mL')).toBe('3 mL');
    expect(texToHtml('3\\!mL')).toBe('3mL');
  });

  it('reads the operators and Greek letters a lab note writes', () => {
    expect(texToHtml('2 \\times 10^6')).toBe('2 × 10<sup>6</sup>');
    expect(texToHtml('1.5 \\cdot 10^{-3}')).toBe('1.5 · 10<sup>-3</sup>');
    expect(texToHtml('5 \\pm 0.2')).toBe('5 ± 0.2');
    expect(texToHtml('\\mu L')).toBe('μL');
    expect(texToHtml('\\Delta G \\approx -30')).toBe('ΔG ≈ -30');
  });

  it('reads super- and subscripts, braced or single', () => {
    expect(texToHtml('OD_{600}')).toBe('OD<sub>600</sub>');
    expect(texToHtml('x^2')).toBe('x<sup>2</sup>');
    expect(texToHtml('a_i^{n+1}')).toBe('a<sub>i</sub><sup>n+1</sup>');
  });

  it('reads a raised degree sign as the sign itself', () => {
    expect(texToHtml('37^\\circ C')).toBe('37°C');
    expect(texToHtml('37^{\\circ}C')).toBe('37°C');
  });

  it('reads a fraction as the slash it is read aloud as', () => {
    expect(texToHtml('\\frac{1}{2}')).toBe('1/2');
    expect(texToHtml('\\frac{A_{260}}{A_{280}}')).toBe('A<sub>260</sub>/A<sub>280</sub>');
  });

  it('reads text commands as the plain text inside them', () => {
    expect(texToHtml('V_\\text{final}')).toBe('V<sub>final</sub>');
    expect(texToHtml('\\mathrm{4 ^oC}')).toBe('4 ^oC');
  });

  it('escapes what the HTML would otherwise read as markup', () => {
    expect(texToHtml('a < b')).toBe('a &lt; b');
    expect(texToHtml('\\text{<b>}')).toBe('&lt;b&gt;');
  });

  it('refuses TeX it does not read, so the formula prints as written', () => {
    expect(texToHtml('\\sqrt{2}')).toBeUndefined();
    expect(texToHtml('\\begin{matrix} a \\end{matrix}')).toBeUndefined();
    expect(texToHtml('\\frac{1}')).toBeUndefined();
    expect(texToHtml('{unclosed')).toBeUndefined();
    expect(texToHtml('x^')).toBeUndefined();
  });

  // Extra cases (plan Task 2).
  it('escapes text inside \\text', () => {
    expect(texToHtml('\\text{<b>}')).toBe('&lt;b&gt;');
  });
  it('reads ^\\circ as a degree sign', () => {
    expect(texToHtml('37^\\circ C')).toContain('37°');
  });
  it('returns undefined for unsupported commands', () => {
    expect(texToHtml('\\int_0^1 x')).toBeUndefined();
  });
});
