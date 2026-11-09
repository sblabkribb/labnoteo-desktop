// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { escapeHtml, fitBodies, pagesHtml } from '../../port/printPages';
import { PRINT_ATTRS, PRINT_TAGS, sanitizePrintTree } from '../sanitize';
import { mountPages, printPages, printRoot } from '../printRoot';
import { page } from './pageFixture';

afterEach(() => {
  vi.restoreAllMocks();
  window.dispatchEvent(new Event('afterprint'));
  document.body.classList.remove('printing-pages');
  printRoot().replaceChildren();
});

describe('fitBodies', () => {
  it('fitBodies shrinks by class in 0.05 steps down to 0.7', () => {
    const proto = CSSStyleDeclaration.prototype;
    const spies = [
      vi.spyOn(proto, 'setProperty'),
      ...(['fontSize', 'top', 'height', 'cssText'] as const).map((p) => vi.spyOn(proto, p, 'set')),
    ];
    const root = document.createElement('div');
    const stuck = document.createElement('main');
    const fits = document.createElement('main');
    stuck.className = 'body';
    fits.className = 'body';
    for (const el of [stuck, fits]) Object.defineProperty(el, 'clientHeight', { get: () => 100 });
    Object.defineProperty(stuck, 'scrollHeight', { get: () => 500 });
    Object.defineProperty(fits, 'scrollHeight', { get: () => (fits.classList.contains('fit-90') ? 100 : 500) });
    root.append(stuck, fits);
    fitBodies(root, 0.7);
    expect([...stuck.classList]).toEqual(['body', 'fit-70']);
    expect([...fits.classList]).toEqual(['body', 'fit-90']);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });

  it('a body that fits loses an earlier fit class', () => {
    const root = document.createElement('div');
    const body = document.createElement('main');
    body.className = 'body fit-80';
    Object.defineProperty(body, 'clientHeight', { get: () => 100 });
    Object.defineProperty(body, 'scrollHeight', { get: () => 90 });
    root.append(body);
    fitBodies(root, 0.7);
    expect([...body.classList]).toEqual(['body']);
  });
});

describe('sanitizePrintTree', () => {
  it('has exactly the planned allow-list', () => {
    expect([...PRINT_TAGS].sort()).toEqual(
      'section header main footer div span p br hr h1 h2 h3 h4 h5 h6 ul ol li table thead tbody tr th td pre code blockquote b i s em strong mark sub sup img svg path rect title'
        .split(' ')
        .sort(),
    );
    expect(PRINT_ATTRS).toEqual({
      '*': ['class'],
      svg: ['xmlns', 'viewBox', 'width', 'height', 'role', 'shape-rendering', 'aria-hidden'],
      path: ['d', 'fill'],
      rect: ['x', 'y', 'width', 'height', 'fill'],
      img: ['src', 'alt'],
      th: ['colspan', 'rowspan'],
      td: ['colspan', 'rowspan'],
      ol: ['start'],
    });
  });

  it('the sanitizer keeps the page model and the QR intact', () => {
    const root = mountPages(pagesHtml([page()], 'a4'));
    const svg = root.querySelector('svg')!;
    expect(svg.getAttribute('viewBox')).toMatch(/^0 0 \d+ \d+$/);
    expect(svg.getAttribute('shape-rendering')).toBe('crispEdges');
    expect(svg.querySelector('path')!.getAttribute('d')).toMatch(/^M\d/);
    expect(root.querySelector('.qr.tr')).not.toBeNull();
    expect(root.querySelector('.qr.bl .label')!.textContent).toBe('L');
    expect(root.querySelector('section.page.a4 .body')).not.toBeNull();
    expect(root.querySelector('section.page.a4 header.head h1')!.textContent).toBe('T');
    const again = root.cloneNode(true) as HTMLElement;
    expect(sanitizePrintTree(again)).toBe(0);
  });

  it('hostile note text prints as text: no element outside the allow-list and no on* attribute', () => {
    const root = mountPages(
      pagesHtml(
        [page({ body: '<img src=x onerror="alert(1)"><script>x()</script><style>*{}</style><a href="javascript:x">l</a>' + escapeHtml('<b onclick=1>') })],
        'a4',
      ),
    );
    expect(root.querySelector('script,style,iframe,a')).toBeNull();
    expect([...root.querySelectorAll('*')].flatMap((e) => [...e.attributes].map((a) => a.name)).filter((n) => n.startsWith('on'))).toEqual([]);
    expect(root.querySelector('img')).toBeNull(); // src=x is neither blob: nor data:image
    expect(root.textContent).toContain('<b onclick=1>');
    expect(root.textContent).toContain('l');
    for (const el of root.querySelectorAll('*')) expect(PRINT_TAGS.has(el.localName), el.localName).toBe(true);
  });

  it('drops dangerous containers with their content, unwraps the rest and keeps only allowed attributes', () => {
    const doc = new DOMParser().parseFromString(
      '<div class="a" id="i" style="color:red" onclick="x()"><iframe src="x"></iframe><object>obj</object><noscript>nos</noscript>' +
        '<template>tpl</template><font color="red">kept</font><img src="blob:abc" alt="ok" width="9"><img src="data:image/png;base64,AA" alt="d">' +
        '<img src="javascript:x" alt="bad"><img src="data:text/html,x" alt="bad2"><table><tr><td colspan="2" style="x">c</td></tr></table>' +
        '<ol start="3" type="a"><li>i</li></ol><svg viewBox="0 0 1 1" onload="x()"><foreignObject><p>fo</p></foreignObject>' +
        '<use href="#a"></use><a href="javascript:x"><rect x="1" y="1" width="1" height="1" fill="#000" style="x"></rect></a></svg><!-- c --></div>',
      'text/html',
    );
    const removed = sanitizePrintTree(doc.body);
    expect(removed).toBeGreaterThan(10);
    const div = doc.body.querySelector('div')!;
    expect([...div.attributes].map((a) => a.name)).toEqual(['class']);
    expect(doc.body.querySelector('iframe,object,noscript,template,font,use,a,foreignObject')).toBeNull();
    for (const gone of ['obj', 'nos', 'tpl']) expect(doc.body.textContent).not.toContain(gone);
    expect(doc.body.textContent).toContain('kept');
    expect(doc.body.textContent).toContain('fo');
    expect([...doc.body.querySelectorAll('img')].map((i) => i.getAttribute('alt'))).toEqual(['ok', 'd']);
    expect(doc.body.querySelector('img')!.hasAttribute('width')).toBe(false);
    expect(doc.body.querySelector('td')!.getAttribute('colspan')).toBe('2');
    expect(doc.body.querySelector('td')!.hasAttribute('style')).toBe(false);
    expect(doc.body.querySelector('ol')!.getAttribute('start')).toBe('3');
    expect(doc.body.querySelector('ol')!.hasAttribute('type')).toBe(false);
    const svg = doc.body.querySelector('svg')!;
    expect([...svg.attributes].map((a) => a.name)).toEqual(['viewBox']);
    expect(svg.querySelector('rect')!.hasAttribute('style')).toBe(false);
    expect(svg.querySelector('rect')!.getAttribute('fill')).toBe('#000');
    expect([...div.childNodes].some((n) => n.nodeType === Node.COMMENT_NODE)).toBe(false);
    expect(sanitizePrintTree(doc.body)).toBe(0);
  });
});

describe('printPages', () => {
  it('printRoot is one div under body, made once', () => {
    const a = printRoot();
    expect(a.id).toBe('labnote-print-root');
    expect(a.className).toBe('print-root');
    expect(a.parentElement).toBe(document.body);
    expect(printRoot()).toBe(a);
    expect(document.querySelectorAll('#labnote-print-root')).toHaveLength(1);
  });

  it('printPages hides the app, fits, prints and cleans up on afterprint', async () => {
    let during: { printing: boolean; pages: number } | undefined;
    const print = vi.fn(() => {
      during = { printing: document.body.classList.contains('printing-pages'), pages: printRoot().querySelectorAll('section.page.a4').length };
      window.dispatchEvent(new Event('afterprint'));
    });
    await printPages([page()], 'a4', { print, waitMs: 10 });
    expect(print).toHaveBeenCalledOnce();
    expect(during).toEqual({ printing: true, pages: 1 });
    expect(document.body.classList.contains('printing-pages')).toBe(false);
    expect(printRoot().childElementCount).toBe(0);
  });

  it('a throwing print cleans up and rethrows', async () => {
    const print = vi.fn(() => {
      throw new Error('no printer');
    });
    await expect(printPages([page()], 'a4', { print, waitMs: 10 })).rejects.toThrow('no printer');
    expect(document.body.classList.contains('printing-pages')).toBe(false);
    expect(printRoot().childElementCount).toBe(0);
  });

  it('a new job replaces the previous one, and the earlier job leaves the new one alone', async () => {
    await printPages([page()], 'a4', { print: () => {}, waitMs: 10 }); // no afterprint yet
    expect(document.body.classList.contains('printing-pages')).toBe(true);
    let pagesWhilePrinting = -1;
    await printPages([page(), page()], 'letter', {
      print: () => {
        pagesWhilePrinting = printRoot().querySelectorAll('section.page.letter').length;
      },
      waitMs: 10,
    });
    expect(pagesWhilePrinting).toBe(2);
    expect(printRoot().querySelectorAll('section.page.letter')).toHaveLength(2);
    window.dispatchEvent(new Event('afterprint'));
    expect(printRoot().childElementCount).toBe(0);
    expect(document.body.classList.contains('printing-pages')).toBe(false);
  });

  it('an image that never loads does not hold the job past the wait', async () => {
    vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(false);
    const print = vi.fn(() => window.dispatchEvent(new Event('afterprint')));
    await printPages([page({ body: '<p class="img"><img alt="a.png" src="blob:nothing"></p>' })], 'a4', { print, waitMs: 10 });
    expect(print).toHaveBeenCalledOnce();
  });
});

describe('print.css', () => {
  it('print.css shows the root in print and uses named pages', () => {
    const css = readFileSync('src/labnote/print/print.css', 'utf-8');
    expect(css).toMatch(/@page a4 \{[^}]*size: 210mm 297mm/);
    expect(css).toMatch(/@page letter \{[^}]*size: 215\.9mm 279\.4mm/);
    expect(css).toMatch(/body\.printing-pages > :not\(\.print-root\)/);
    expect(css).toMatch(/@media print[^]*body\.printing-pages \.print-root \{[^}]*position: static/);
    expect(css).toMatch(/\.print-root \{[^}]*left: -100000px/);
    expect(css).not.toMatch(/iframe/);
    for (const s of [95, 90, 85, 80, 75, 70]) expect(css).toContain(`.body.fit-${s}`);
    expect(css).toMatch(/\.page\.a4 \{[^}]*page: a4/);
    expect(css).toMatch(/\.page\.letter \{[^}]*page: letter/);
    expect(css).toMatch(/grid-template-rows: auto 1fr auto/);
  });

  it('every rule but @page and the body rules is scoped under .print-root', () => {
    const css = readFileSync('src/labnote/print/print.css', 'utf-8').replace(/\/\*[^]*?\*\//g, '');
    const selectors = [...css.matchAll(/([^{}]+)\{[^{}]*\}/g)]
      .map((m) => m[1].trim())
      .filter((s) => !s.startsWith('@page'))
      .flatMap((s) => s.replace(/^@media [^{]*\{\s*/, '').split(','))
      .map((s) => s.trim())
      .filter(Boolean);
    expect(selectors.length).toBeGreaterThan(30);
    const unscoped = selectors.filter((s) => !/^(body(\.|:not)|#labnote-print-root\.print-root|\.print-root)/.test(s));
    expect(unscoped).toEqual([]);
  });
});
