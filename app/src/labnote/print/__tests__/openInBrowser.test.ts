// @vitest-environment jsdom
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { buildStandaloneHtml, FIT_SCRIPT, FIT_SCRIPT_SHA256, MIN_SCALE } from '../../port/printPages';
import { inlineImages, openInBrowser, standaloneFromPages } from '../openInBrowser';
import { printRoot } from '../printRoot';
import { page } from './pageFixture';

const pageWithImg = (src: string, alt = 'a.png') => page({ body: `<p class="img"><img alt="${alt}" src="${src}"></p>` });

describe('the standalone print file', () => {
  it('the standalone file carries the CSS, the hashed fit script, and no blob: URL', async () => {
    const html = await standaloneFromPages('T', 'a4', [pageWithImg('blob:x')], async () => new Blob(['ab'], { type: 'image/png' }));
    expect(html).toContain('data:image/png;base64,YWI=');
    expect(html).not.toContain('blob:');
    expect(html).toContain(`script-src 'sha256-${FIT_SCRIPT_SHA256}'`);
    expect(html).toContain(`<script>${FIT_SCRIPT}</script>`);
    expect(html).toContain(readFileSync('src/labnote/print/print.css', 'utf-8').trim().slice(0, 200));
    expect(html.startsWith('<!doctype html><html><head><meta charset="utf-8">')).toBe(true);
    expect(html).toContain('<body class="printing-pages"><div class="print-root"><section class="page a4">');
  });

  it('FIT_SCRIPT_SHA256 is the SHA-256 of FIT_SCRIPT', () => {
    expect(createHash('sha256').update(FIT_SCRIPT, 'utf8').digest('base64')).toBe(FIT_SCRIPT_SHA256);
  });

  it('the standalone file is built from the sanitized tree: no on* attribute, no script but the hashed fit script, no src outside data:image/', async () => {
    const hostile = page({
      body: '<img src=x onerror="alert(1)"><script>x()</script><svg onload="x()"><path d="M0 0"/></svg><img alt="&quot; onerror=&quot;y" src="blob:z">',
    });
    const html = await standaloneFromPages('<T>', 'a4', [hostile], async () => new Blob(['ab'], { type: 'text/html' }));
    const doc = new DOMParser().parseFromString(html, 'text/html');
    expect(doc.querySelectorAll('script')).toHaveLength(1);
    expect(doc.querySelector('script')!.textContent).toBe(FIT_SCRIPT);
    expect([...doc.querySelectorAll('*')].flatMap((e) => [...e.attributes].map((a) => a.name)).filter((n) => n.startsWith('on'))).toEqual([]);
    expect([...doc.querySelectorAll('[src]')].map((e) => e.getAttribute('src')).filter((s) => !s!.startsWith('data:image/'))).toEqual([]);
    expect(doc.title).toBe('<T>');
  });

  it('images past the cap print as their name', async () => {
    const big = () => new Blob([new Uint8Array(20 * 1024 * 1024)], { type: 'image/png' });
    const html = await standaloneFromPages(
      'T',
      'a4',
      [page({ body: '<p class="img"><img alt="a.png" src="blob:a"></p><p class="img"><img alt="b.png" src="blob:b"></p>' })],
      async () => big(),
    );
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const imgs = [...doc.querySelectorAll('img')];
    expect(imgs).toHaveLength(1);
    expect(imgs[0].getAttribute('src')!.startsWith('data:image/png;base64,')).toBe(true);
    expect(imgs[0].getAttribute('alt')).toBe('a.png');
    expect(doc.querySelectorAll('p.img')[1].textContent).toBe('b.png');
  });

  it('a failed read or a non-image blob prints the image name', async () => {
    const root = document.createElement('div');
    const p = document.createElement('p');
    for (const [src, alt] of [['blob:fail', 'f.png'], ['blob:none', 'n.png'], ['blob:html', 'h.png']]) {
      const img = document.createElement('img');
      img.setAttribute('src', src);
      img.setAttribute('alt', alt);
      p.append(img);
    }
    root.append(p);
    await inlineImages(root, async (src) => {
      if (src === 'blob:fail') throw new Error('gone');
      if (src === 'blob:none') return undefined;
      return new Blob(['<p>'], { type: 'text/html' });
    });
    expect(root.querySelector('img')).toBeNull();
    expect(p.textContent).toBe('f.pngn.pngh.png');
  });

  it('the app print root is left untouched', async () => {
    printRoot().replaceChildren();
    await standaloneFromPages('T', 'a4', [page()], async () => undefined);
    expect(printRoot().childElementCount).toBe(0);
  });

  it('buildStandaloneHtml escapes the title and reads the given root', () => {
    const root = document.createElement('div');
    root.append(document.createElement('p'));
    const html = buildStandaloneHtml('a</title><script>x()</script>', 'letter', root, '.x{}');
    expect(html).toContain('<title>a&lt;/title&gt;&lt;script&gt;x()&lt;/script&gt;</title>');
    expect(html).toContain('<style>.x{}</style>');
    expect(html).toContain('<div class="print-root"><p></p></div>');
  });

  it('the fit script shrinks a body by class like fitBodies', () => {
    expect(FIT_SCRIPT).toContain(String(MIN_SCALE));
    const body = document.createElement('main');
    body.className = 'body fit-95';
    Object.defineProperty(body, 'clientHeight', { get: () => 100 });
    Object.defineProperty(body, 'scrollHeight', { get: () => (body.classList.contains('fit-80') ? 100 : 500) });
    document.body.append(body);
    try {
      new Function(FIT_SCRIPT)();
      window.dispatchEvent(new Event('load'));
      expect([...body.classList]).toEqual(['body', 'fit-80']);
    } finally {
      body.remove();
    }
  });
});

describe('openInBrowser', () => {
  it('openInBrowser sends kind, noteId and html', async () => {
    const calls: unknown[] = [];
    const name = await openInBrowser('note', 'LN-7K3M9QX2', '<p>', async (cmd, args) => {
      calls.push([cmd, args]);
      return 'LN-7K3M9QX2_note.html' as never;
    });
    expect(calls).toEqual([['print_open_in_browser', { kind: 'note', noteId: 'LN-7K3M9QX2', html: '<p>' }]]);
    expect(name).toBe('LN-7K3M9QX2_note.html');
  });
});
