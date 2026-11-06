// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { labnoteMarkdown } from '../../markdownSyntax';
import { livePlugin } from '../inline';
import { imageLoader } from '../imageWidget';
import { vaultImages } from '../vaultImages';
import { linkResolution, linkStateOf, resolutionFlusher, scheduleResolution, type LinkResolution } from '../linkResolution';
import { createResolver } from '../../../links/resolve';
import { setComposing } from '../../__tests__/composing';
import { t } from '../../../i18n/t';

// jsdom has no layout: fill in the measuring APIs CodeMirror uses with empty values.
const emptyRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
Range.prototype.getClientRects ??= emptyRects;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();

const views: EditorView[] = [];
afterEach(() => {
  while (views.length) views.pop()!.destroy();
  document.body.innerHTML = '';
});

const res = (files: string[]): LinkResolution => {
  const r = createResolver(files);
  return { version: 1, resolveWiki: r.resolveWiki, resolveMd: r.resolveMd, isUnknownTarget: r.isUnknownTarget };
};

function liveView(doc: string, opts: { notePath: string; resolution: LinkResolution | null; slot?: Compartment }, pos: number): EditorView {
  const slot = opts.slot ?? new Compartment();
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const v = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor: Math.min(pos, doc.length) },
      extensions: [
        labnoteMarkdown(),
        livePlugin,
        slot.of(linkResolution.of(opts.resolution)),
        imageLoader.of({ notePath: opts.notePath, images: vaultImages }),
        resolutionFlusher,
      ],
    }),
  });
  views.push(v);
  return v;
}

describe('linkStateOf', () => {
  const r = res(['Home.md', 'n.md', 'images/gel.png']);
  it('is unknown without a resolution', () => expect(linkStateOf(null, 'wiki', 'Nope', 'n.md')).toBe('unknown'));
  it('wikilinks', () => {
    expect(linkStateOf(r, 'wiki', 'Home', 'n.md')).toBe('resolved');
    expect(linkStateOf(r, 'wiki', 'Home#Intro', 'n.md')).toBe('resolved');
    expect(linkStateOf(r, 'wiki', 'Nope', 'n.md')).toBe('unresolved');
    expect(linkStateOf(r, 'wiki', 'spec.pdf', 'n.md')).toBe('unknown');
    expect(linkStateOf(r, 'wiki', '#Intro', 'n.md')).toBe('resolved');
    expect(linkStateOf(r, 'wiki', 'gel.png', 'n.md')).toBe('resolved');
  });
  it('a self link is resolved even when the note is not listed yet', () => {
    expect(linkStateOf(res(['Home.md']), 'wiki', 'new', 'dir/new.md')).toBe('resolved');
  });
  it('markdown links', () => {
    expect(linkStateOf(r, 'md', './Home.md', 'n.md')).toBe('resolved');
    expect(linkStateOf(r, 'md', '<Home.md>', 'n.md')).toBe('resolved');
    expect(linkStateOf(r, 'md', 'https://a.b', 'n.md')).toBe('resolved');
    expect(linkStateOf(r, 'md', 'mailto:x@y.z', 'n.md')).toBe('resolved');
    expect(linkStateOf(r, 'md', '#step-1', 'n.md')).toBe('resolved');
    expect(linkStateOf(r, 'md', './gone.md', 'n.md')).toBe('unresolved');
    expect(linkStateOf(r, 'md', './spec.pdf', 'n.md')).toBe('unknown');
  });
});

describe('live preview: link resolution', () => {
  it('draws resolved and unresolved wikilinks', () => {
    const v = liveView('[[Home]] [[Nope]] [[spec.pdf]]\nx', { notePath: 'n.md', resolution: res(['Home.md', 'n.md']) }, 40);
    const els = [...v.contentDOM.querySelectorAll('.lno-wikilink')];
    expect(els.map((e) => [e.textContent, e.classList.contains('lno-unresolved')])).toEqual([
      ['Home', false],
      ['Nope', true],
      ['spec.pdf', false],
    ]);
    expect(els[1].getAttribute('title')).toBe(t('links.create.title'));
    expect(els[0].getAttribute('title')).toBeNull();
  });

  it('a revealed unresolved wikilink keeps the unresolved style', () => {
    const v = liveView('[[Nope|n]]\nx', { notePath: 'n.md', resolution: res(['n.md']) }, 3);
    const el = v.contentDOM.querySelector('.lno-wikilink')!;
    expect(el.textContent).toBe('Nope|n');
    expect(el.classList.contains('lno-unresolved')).toBe(true);
  });

  it('a non-image embed gets the wikilink classes', () => {
    const v = liveView('![[Nope]] ![[Home]]\nx', { notePath: 'n.md', resolution: res(['Home.md', 'n.md']) }, 25);
    const els = [...v.contentDOM.querySelectorAll('.lno-wikilink')];
    expect(els.map((e) => [e.textContent, e.classList.contains('lno-unresolved')])).toEqual([
      ['Nope', true],
      ['Home', false],
    ]);
  });

  it('draws nothing unresolved before the index is ready', () => {
    const v = liveView('[[Nope]]\nx', { notePath: 'n.md', resolution: null }, 9);
    expect(v.contentDOM.querySelector('.lno-wikilink')).not.toBeNull();
    expect(v.contentDOM.querySelector('.lno-unresolved')).toBeNull();
  });

  it('reconfiguring the slot redraws', () => {
    const slot = new Compartment();
    const v = liveView('[[Home]]\nx', { notePath: 'n.md', resolution: res([]), slot }, 9);
    expect(v.contentDOM.querySelector('.lno-unresolved')).not.toBeNull();
    scheduleResolution(v, slot, res(['Home.md']));
    expect(v.contentDOM.querySelector('.lno-unresolved')).toBeNull();
  });

  it('does not reconfigure resolution while composing and applies it after compositionend', () => {
    const slot = new Compartment();
    const v = liveView('[[Home]]\nx', { notePath: 'n.md', resolution: res([]), slot }, 9);
    expect(v.contentDOM.querySelector('.lno-unresolved')).not.toBeNull();
    setComposing(v, true);
    const spy = vi.spyOn(v, 'dispatch');
    scheduleResolution(v, slot, res(['Home.md']));
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    // an update while still composing does not flush either
    v.dispatch({});
    expect(v.contentDOM.querySelector('.lno-unresolved')).not.toBeNull();
    setComposing(v, false);
    v.dispatch({}); // the first non-composing update flushes
    expect(v.contentDOM.querySelector('.lno-unresolved')).toBeNull();
  });

  it('a later value replaces a deferred one', () => {
    const slot = new Compartment();
    const v = liveView('[[Home]]\nx', { notePath: 'n.md', resolution: res(['Home.md']), slot }, 9);
    setComposing(v, true);
    scheduleResolution(v, slot, res([]));
    setComposing(v, false);
    const latest = res(['Home.md']);
    scheduleResolution(v, slot, latest);
    expect(v.state.facet(linkResolution)).toBe(latest);
    v.dispatch({});
    expect(v.state.facet(linkResolution)).toBe(latest);
    expect(v.contentDOM.querySelector('.lno-unresolved')).toBeNull();
  });

  it('marks bare URLs and autolinks as links', () => {
    const v = liveView('see https://doi.org/10.1038/x and <https://a.b/c>\nq', { notePath: 'n.md', resolution: res(['n.md']) }, 52);
    const els = [...v.contentDOM.querySelectorAll('.lno-link')];
    expect(els.map((e) => e.textContent)).toEqual(['https://doi.org/10.1038/x', 'https://a.b/c']);
    expect(els.every((e) => e.getAttribute('title') === t('live.link.title'))).toBe(true);
  });

  it('marks a markdown link to a missing note', () => {
    const v = liveView('[x](./gone.md) [y](https://a.b)\nq', { notePath: 'n.md', resolution: res(['n.md']) }, 33);
    expect([...v.contentDOM.querySelectorAll('.lno-link')].map((e) => e.classList.contains('lno-unresolved'))).toEqual([true, false]);
  });

  it('a link reference definition URL is not a bare link', () => {
    const v = liveView('[a]: https://a.b\n\nq', { notePath: 'n.md', resolution: res(['n.md']) }, 18);
    expect(v.contentDOM.querySelector('.lno-link')).toBeNull();
  });
});
