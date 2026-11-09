import { bodyBox, escapeHtml, MIN_SCALE, PAPER_MM, pagesHtml } from '../../port/printPages';
import { page } from './pageFixture';

// vendor tests/plugin/print.test.ts:12-63 (buildPrintHtml), applied to pagesHtml
describe('pagesHtml', () => {
  it('puts the same QR code in two corners of every page', () => {
    const html = pagesHtml([page(), page({ label: 'second' })], 'letter');
    expect(html.match(/<section class="page letter">/g)).toHaveLength(2);
    expect(html.match(/<div class="qr tr"><svg/g)).toHaveLength(2);
    expect(html.match(/<div class="qr bl"><svg/g)).toHaveLength(2);
    expect(html).toContain('<header class="head"><h1>T</h1></header>');
    expect(html).toContain('<main class="body"><p>x</p></main>');
    expect(html).toContain('<footer class="foot">F</footer>');
    expect(html).not.toContain('<style');
    expect(html).not.toContain('<script');
  });

  it('escapes the label under each QR', () => {
    const html = pagesHtml([page({ label: 'a <b> & "c"' })], 'a4');
    expect(html.match(/<div class="label">a &lt;b&gt; &amp; &quot;c&quot;<\/div>/g)).toHaveLength(2);
  });

  it('pagesHtml marks each page with its paper class', () => {
    expect(pagesHtml([page()], 'letter')).toContain('<section class="page letter">');
    expect(pagesHtml([page()], 'a4')).toContain('<section class="page a4">');
  });

  it('escapes note text', () => {
    expect(escapeHtml(`<img src=x onerror="a('b')">&`)).toBe('&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;');
  });

  it('bodyBox reserves both QR corners', () => {
    expect(bodyBox('a4')).toEqual({ width: 182, height: 297 - 44 - 42, top: 44, left: 14 });
    expect(bodyBox('letter').width).toBeCloseTo(PAPER_MM.letter.width - 28);
    expect(MIN_SCALE).toBe(0.7);
  });
});
