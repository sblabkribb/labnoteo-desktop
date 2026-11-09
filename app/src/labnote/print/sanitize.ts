/**
 * 인쇄 페이지의 허용 목록 정화기. 페이지 HTML 은 이미 escapeHtml 을 거친 글로 만들어지지만, 그 위에 이 정화기가
 * 한 번 더 돈다: 허용 목록 밖의 요소와 속성(on* 포함)은 남지 않는다. DOMParser 가 만든(스크립트도 이미지도 돌지 않는)
 * 문서 위에서 돌린 다음에야 본 문서로 옮긴다(printRoot.ts mountPages).
 */

/** 남겨 두는 요소(소문자 localName). */
export const PRINT_TAGS: ReadonlySet<string> = new Set(
  (
    'section header main footer div span p br hr h1 h2 h3 h4 h5 h6 ul ol li table thead tbody tr th td pre code ' +
    'blockquote b i s em strong mark sub sup img svg path rect title'
  ).split(' '),
);

/** 요소마다 남겨 두는 속성. `'*'` 는 허용된 모든 요소에 붙는다. */
export const PRINT_ATTRS: Readonly<Record<string, readonly string[]>> = {
  '*': ['class'],
  svg: ['xmlns', 'viewBox', 'width', 'height', 'role', 'shape-rendering', 'aria-hidden'],
  path: ['d', 'fill'],
  rect: ['x', 'y', 'width', 'height', 'fill'],
  img: ['src', 'alt'],
  th: ['colspan', 'rowspan'],
  td: ['colspan', 'rowspan'],
  ol: ['start'],
};

/** 내용과 함께 지우는 요소. 다른 허용 밖 요소는 자식만 남기고 벗긴다. */
const DROP_WITH_CONTENT: ReadonlySet<string> = new Set(['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'template', 'noscript']);

const SVG_NS = 'http://www.w3.org/2000/svg';
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

function allowedSrc(src: string | null): boolean {
  return src !== null && (src.startsWith('blob:') || src.startsWith('data:image/'));
}

/**
 * `root` 아래를 허용 목록대로 정리한다(root 자신은 건드리지 않는다). 지운 요소·속성 수를 돌려준다:
 * 이미 정화된 나무에서는 0. 주석 같은 요소·글 외의 노드는 세지 않고 지운다.
 */
export function sanitizePrintTree(root: ParentNode): number {
  let removed = 0;
  const walk = (parent: ParentNode): void => {
    for (const node of Array.from(parent.childNodes)) {
      if (node.nodeType === TEXT_NODE) continue;
      if (node.nodeType !== ELEMENT_NODE) {
        node.parentNode?.removeChild(node);
        continue;
      }
      const el = node as Element;
      const svg = el.namespaceURI === SVG_NS;
      const tag = svg ? el.localName : el.localName.toLowerCase();
      if (DROP_WITH_CONTENT.has(tag.toLowerCase())) {
        el.remove();
        removed++;
        continue;
      }
      if (!PRINT_TAGS.has(tag)) {
        walk(el);
        el.replaceWith(...Array.from(el.childNodes));
        removed++;
        continue;
      }
      if (tag === 'img' && !allowedSrc(el.getAttribute('src'))) {
        el.remove();
        removed++;
        continue;
      }
      const allowed = [...PRINT_ATTRS['*'], ...(PRINT_ATTRS[tag] ?? [])];
      for (const attr of Array.from(el.attributes)) {
        const name = svg ? attr.name : attr.name.toLowerCase();
        if (!allowed.includes(name)) {
          el.removeAttributeNode(attr);
          removed++;
        }
      }
      walk(el);
    }
  };
  walk(root);
  return removed;
}
