// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { labnoteMarkdown } from '../../markdownSyntax';
import { tableExtension } from '../../table/field';
import { livePreview } from '../index';
import { setMode } from '../mode';
import { propertiesActions } from '../properties';
import { imageLoader } from '../imageWidget';
import { vaultImages } from '../vaultImages';
import { linkResolution, type LinkResolution } from '../linkResolution';
import type { OpenTarget } from '../links';
import { createResolver } from '../../../links/resolve';

// jsdom has no layout: fill in the measuring APIs CodeMirror uses with empty values.
const emptyRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
Range.prototype.getClientRects ??= emptyRects;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();
document.execCommand ??= () => false;

const views: EditorView[] = [];
const slots = new WeakMap<EditorView, Compartment>();
let opened: OpenTarget[] = [];
let version = 1;

const res = (files: string[], v = 1): LinkResolution => {
  const r = createResolver(files);
  return { version: v, resolveWiki: r.resolveWiki, resolveMd: r.resolveMd, isUnknownTarget: r.isUnknownTarget };
};

/** A live-preview editor with the Properties grid, a resolution slot and a note path. */
function gridView(doc: string, opts: { files: string[]; notePath: string }): EditorView {
  const slot = new Compartment();
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const v = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: [
        labnoteMarkdown(),
        livePreview(),
        tableExtension({ save: () => {}, root: document }),
        slot.of(linkResolution.of(res(opts.files, version))),
        imageLoader.of({ notePath: opts.notePath, images: vaultImages }),
        propertiesActions.of({ onOpenLink: (target) => opened.push(target) }),
      ],
    }),
  });
  slots.set(v, slot);
  views.push(v);
  return v;
}

/** Reconfigures the slot with a new resolution (the next version). */
function setResolution(v: EditorView, files: string[]): void {
  version += 1;
  v.dispatch({ effects: slots.get(v)!.reconfigure(linkResolution.of(res(files, version))) });
}

const press = (el: Element, key: string, init: KeyboardEventInit = {}) =>
  el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
const mousedown = (el: Element) => el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
/** The value input of the grid (each row's key is an input too). */
const valueInput = (v: EditorView) => v.dom.querySelector<HTMLInputElement>('.lno-props input.lno-props-value');

beforeEach(() => {
  opened = [];
  version = 1;
  setMode('live');
});
afterEach(() => {
  while (views.length) views.pop()!.destroy();
  document.body.innerHTML = '';
});

describe('wikilinks in the Properties grid (SP4 Task 13)', () => {
  it('renders property links with resolution and opens them', () => {
    const v = gridView('---\nauthor: "[[이서연]]"\nretry_of: "[[labnote/061_a/README.labnote|061]]"\n---\nx', {
      files: ['labnote/061_a/README.labnote.md'],
      notePath: 'labnote/062_b/README.labnote.md',
    });
    const spans = [...v.dom.querySelectorAll('.lno-props .lno-wikilink')];
    expect(spans.map((s) => [s.textContent, s.classList.contains('lno-unresolved')])).toEqual([
      ['이서연', true],
      ['061', false],
    ]);
    mousedown(spans[1]);
    mousedown(spans[0]);
    expect(opened).toEqual([
      { kind: 'note', path: 'labnote/061_a/README.labnote.md' },
      { kind: 'create', linkpath: '이서연' },
    ]);
  });

  it('restyles after a resolution change without re-mounting, and links stay clickable', () => {
    const v = gridView('---\nauthor: "[[이서연]]"\n---\nx', { files: [], notePath: 'n.md' });
    const container = v.dom.querySelector('.lno-prop-links')!;
    expect(container).not.toBeNull();
    setResolution(v, ['people/이서연.md']); // reconfigures the slot with version 2
    expect(v.dom.querySelector('.lno-prop-links')).toBe(container);
    const span = v.dom.querySelector('.lno-props .lno-wikilink')!;
    expect(span.classList.contains('lno-unresolved')).toBe(false);
    mousedown(span);
    expect(opened).toEqual([{ kind: 'note', path: 'people/이서연.md' }]);
  });

  it('edits a wikilink cell through the input and returns to links', () => {
    const v = gridView('---\nauthor: [[이서연]]\n---\nx', { files: [], notePath: 'n.md' });
    const container = v.dom.querySelector<HTMLElement>('.lno-prop-links')!;
    expect(container.getAttribute('aria-label')).toBe('이서연');
    press(container, 'Enter');
    const input = valueInput(v)!;
    expect(input.value).toBe('이서연'); // cellText: names only, as today
    input.value = '새이름';
    press(input, 'Enter');
    // the existing serialisation (properties.test.ts 'a list and a wikilink value are edited as comma-separated text')
    expect(v.state.doc.toString()).toBe('---\nauthor: [[새이름]]\n---\nx');
    expect([...v.dom.querySelectorAll('.lno-props .lno-wikilink')].map((s) => s.textContent)).toEqual(['새이름']);
    expect(valueInput(v)).toBeNull();
  });

  it('F2 and a click beside the links open the edit state; Escape returns to links', () => {
    const v = gridView('---\nauthor: "[[이서연]]"\n---\nx', { files: [], notePath: 'n.md' });
    press(v.dom.querySelector('.lno-prop-links')!, 'F2');
    const input = valueInput(v)!;
    expect(input).not.toBeNull();
    press(input, 'Escape');
    expect(valueInput(v)).toBeNull();
    const container = v.dom.querySelector<HTMLElement>('.lno-prop-links')!;
    container.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    expect(valueInput(v)).not.toBeNull();
    expect(opened).toEqual([]);
    expect(v.state.doc.toString()).toBe('---\nauthor: "[[이서연]]"\n---\nx');
  });

  it('a click on a link does not also open the edit state', () => {
    const v = gridView('---\nauthor: "[[이서연]]"\n---\nx', { files: [], notePath: 'n.md' });
    const span = v.dom.querySelector('.lno-props .lno-wikilink')!;
    mousedown(span);
    span.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    expect(opened).toEqual([{ kind: 'create', linkpath: '이서연' }]);
    expect(valueInput(v)).toBeNull();
  });

  it('a quoted link keeps its quotes, and an aliased link keeps its path in the edit input', () => {
    const v = gridView("---\nauthor: '[[이서연]]'\nretry_of: \"[[labnote/061_a/README.labnote|061]]\"\n---\nx", { files: [], notePath: 'n.md' });
    const [author, retry] = [...v.dom.querySelectorAll<HTMLElement>('.lno-prop-links')];
    press(author, 'Enter');
    const a = valueInput(v)!;
    expect(a.value).toBe('이서연');
    a.value = "오'정";
    press(a, 'Enter');
    expect(v.state.doc.toString()).toBe("---\nauthor: '[[오''정]]'\nretry_of: \"[[labnote/061_a/README.labnote|061]]\"\n---\nx");
    press(v.dom.querySelectorAll<HTMLElement>('.lno-prop-links')[1] ?? retry, 'Enter');
    const r = valueInput(v)!;
    expect(r.value).toBe('[[labnote/061_a/README.labnote|061]]');
    r.value = '[[labnote/061_a/README.labnote|61]]';
    press(r, 'Enter');
    expect(v.state.doc.toString()).toBe("---\nauthor: '[[오''정]]'\nretry_of: \"[[labnote/061_a/README.labnote|61]]\"\n---\nx");
    expect([...v.dom.querySelectorAll('.lno-props .lno-wikilink')].map((s) => s.textContent)).toEqual(["오'정", '61']);
  });

  it('a composing edit in a wikilink cell is not committed or redrawn', () => {
    const v = gridView('---\nauthor: "[[이서연]]"\n---\nx', { files: [], notePath: 'n.md' });
    press(v.dom.querySelector('.lno-prop-links')!, 'Enter');
    const input = valueInput(v)!;
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    input.value = '[[이서';
    press(input, 'Enter', { isComposing: true });
    setResolution(v, ['people/이서연.md']);
    expect(valueInput(v)).toBe(input);
    expect(input.value).toBe('[[이서');
    expect(v.state.doc.toString()).toContain('author: "[[이서연]]"');
  });
});
