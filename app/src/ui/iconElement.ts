import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Icon, type IconName, type IconSize } from './Icon';

/**
 * The same Lucide icon as <Icon>, as a plain DOM node for the editor's CodeMirror widgets (date chips, UO status
 * chips), which are not React. The markup is rendered once per name and size and cloned; it carries no style
 * attribute (Icon never sets one), so CSP style-src 'self' holds. It is parsed as SVG with DOMParser (no innerHTML).
 * Always decorative (aria-hidden): the widget that holds it carries the label.
 */
const cache = new Map<string, Element>();

export function iconElement(doc: Document, name: IconName, size: IconSize = 14): Element {
  const key = `${name}:${size}`;
  let svg = cache.get(key);
  if (svg === undefined) {
    const markup = renderToStaticMarkup(createElement(Icon, { name, size }));
    svg = new DOMParser().parseFromString(markup, 'image/svg+xml').documentElement;
    cache.set(key, svg);
  }
  return doc.importNode(svg, true);
}
