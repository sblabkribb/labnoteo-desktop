import { imageTargets, renderNoteBlocks, resolveNoteImages, type NoteImages } from '../noteBlocks';

const none: NoteImages = { src: () => undefined };

describe('renderNoteBlocks', () => {
  it('headings, lists, tables, code and callouts become one block each', () => {
    const b = renderNoteBlocks('---\ntitle: x\n---\n## Method\n- a\n- b\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```\ncode\n```\n> [!note] T\n> body\n', none);
    expect(b).toEqual([
      expect.stringMatching(/^<h2>Method<\/h2>$/),
      expect.stringMatching(/^<ul class="bul">/),
      expect.stringMatching(/^<table class="grid">/),
      expect.stringMatching(/^<pre class="code">/),
      expect.stringMatching(/^<div class="callout">/),
    ]);
  });

  it('a unit-op h3 keeps its readable text', () => {
    expect(renderNoteBlocks('### [UHW010 PCR] alias\n', none)[0]).toBe('<h3>[UHW010 PCR] alias</h3>');
  });

  it('raw HTML in a note renders escaped, and an image src is only blob: or data:image', () => {
    const b = renderNoteBlocks('<img src=x onerror=alert(1)>\n\n![[a.png]]\n\n![](javascript:alert(1))\n', {
      src: (t) => (t === 'a.png' ? 'blob:tauri://localhost/1' : 'javascript:alert(1)'),
    }).join('');
    expect(b).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(b).toContain('src="blob:tauri://localhost/1"');
    expect(b).not.toContain('javascript:');
  });

  it('math prints through texToHtml', () => {
    expect(renderNoteBlocks('Heat to $37^\\circ C$.\n', none).join('')).toContain('37°');
  });

  it('a note embed and an image inside text print as their names (E2)', () => {
    const b = renderNoteBlocks('![[Protocol]]\n\nSee ![[a.png]] here.\n', { src: () => 'blob:tauri://localhost/1' }).join('');
    expect(b).toContain('Protocol');
    expect(b).not.toContain('<img');
    expect(b).toContain('a.png');
  });

  it('an image-only paragraph prints one img per embed, and an embed without a src prints [name]', () => {
    const b = renderNoteBlocks('![[a.png|200]] ![gel](imgs/b.jpg)\n![[missing.png]]\n', {
      src: (t, kind) => (t === 'a.png' && kind === 'wiki' ? 'blob:1' : t === 'imgs/b.jpg' && kind === 'md' ? 'data:image/jpeg;base64,AA==' : undefined),
    });
    expect(b).toEqual(['<p class="img"><img alt="a.png" src="blob:1"><img alt="gel" src="data:image/jpeg;base64,AA=="><span>[missing.png]</span></p>']);
  });

  it('an attribute quote in an image name or src is escaped', () => {
    const b = renderNoteBlocks('![x" onerror="y](a.png)\n', { src: () => 'blob:1" onload="z' }).join('');
    expect(b).toContain('alt="x&quot; onerror=&quot;y"');
    expect(b).toContain('src="blob:1&quot; onload=&quot;z"');
  });

  it('a rule line outside a fence is <hr>; heading and rule lines inside a fence stay code', () => {
    const b = renderNoteBlocks('a\n\n---\n\n```\n# not a heading\n---\n```\n***\n', none);
    expect(b).toEqual(['<p>a</p>', '<hr>', '<pre class="code"># not a heading\n---</pre>', '<hr>']);
  });

  it('a #tag line is not a heading, and a heading closing sequence is dropped', () => {
    expect(renderNoteBlocks('#tag\n\n## Title ##\n', none)).toEqual(['<p>#tag</p>', '<h2>Title</h2>']);
  });

  it('CRLF notes render the same as LF ones', () => {
    expect(renderNoteBlocks('---\r\ntitle: x\r\n---\r\n## A\r\n- a\r\n', none)).toEqual(renderNoteBlocks('---\ntitle: x\n---\n## A\n- a\n', none));
  });
});

describe('imageTargets', () => {
  it('lists the image embeds of image-only paragraphs, once each, and not note embeds or embeds inside text', () => {
    expect(imageTargets('![[a.png]]\n\n![[a.png|100]] ![](b%20c.png)\n\n![[Protocol]]\n\nSee ![[d.png]].\n\n```\n![[e.png]]\n```\n')).toEqual([
      { target: 'a.png', kind: 'wiki' },
      { target: 'b%20c.png', kind: 'md' },
    ]);
  });
});

describe('resolveNoteImages', () => {
  it('resolveNoteImages finds a bare-name wiki embed under images/scans', async () => {
    const loaded: string[] = [];
    const images = await resolveNoteImages(
      '![[s.jpg]]\n',
      'e/01_x.labnote.md',
      async (p) => {
        loaded.push(p);
        return p === 'e/images/scans/s.jpg' ? 'blob:1' : undefined;
      },
      async () => ['e/images/scans/s.jpg'],
    );
    expect(images.src('s.jpg', 'wiki')).toBe('blob:1');
    expect(loaded).toEqual(['e/images/scans/s.jpg']);
  });

  it('a Markdown path tries the note-relative candidate, then the vault-relative one', async () => {
    const images = await resolveNoteImages(
      '![](img/a.png)\n',
      'e/n.md',
      async (p) => (p === 'img/a.png' ? 'blob:2' : undefined),
      async () => [],
    );
    expect(images.src('img/a.png', 'md')).toBe('blob:2');
  });

  it('a target that does not resolve, a failing load and a src that is not blob: or data:image have no src', async () => {
    const images = await resolveNoteImages(
      '![[gone.png]] ![](../../out.png) ![[bad.png]] ![[x.png]]\n',
      'n.md',
      async (p) => {
        if (p === 'bad.png') throw new Error('nope');
        return p === 'x.png' ? 'https://evil/x.png' : 'blob:3';
      },
      async () => ['bad.png', 'x.png'],
    );
    expect(images.src('gone.png', 'wiki')).toBeUndefined();
    expect(images.src('../../out.png', 'md')).toBeUndefined();
    expect(images.src('bad.png', 'wiki')).toBeUndefined();
    expect(images.src('x.png', 'wiki')).toBeUndefined();
  });

  it('lists the vault images at most once', async () => {
    const list = vi.fn(async () => ['a.png', 'b.png']);
    await resolveNoteImages('![[a.png]] ![[b.png]]\n', 'n.md', async () => 'blob:1', list);
    expect(list).toHaveBeenCalledTimes(1);
  });
});
