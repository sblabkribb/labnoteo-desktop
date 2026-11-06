// 타입만 가져온다(런타임에는 지워진다): @lezer/common 은 @codemirror/language 가 이미 싣고 오는 그 트리다.
import type { SyntaxNode } from '@lezer/common';
import { labnoteParser } from '../markdownSyntax';

/**
 * 표 셀 글자(원문 마크다운)를 읽기 전용 DOM 으로 그린다. innerHTML 은 쓰지 않는다: 글자는 늘 텍스트 노드가 되고,
 * 요소는 정해진 몇 가지(code, strong, em, s, br, span)만 만든다. 사용자가 쓴 HTML 태그는 `<br>` 말고는 글자로 보인다.
 *
 * 파싱은 Lezer 가 표 셀을 읽는 방식 그대로다: 셀 글자를 한 칸짜리 표의 본문 행에 넣어 파싱하고 그 TableCell 의 인라인 노드를 쓴다.
 * 그래서 `# x`, `- x` 같은 줄 머리도 블록이 아니라 글자이고, escape 한 파이프·코드 스팬·강조 규칙이 편집기의 강조와 같다.
 */

/** 한 칸짜리 표의 머리 행과 구분 행. 본문 행은 `| ` + 글자 + ` |`. */
const PREFIX = '| |\n| - |\n| ';
const SUFFIX = ' |';

/**
 * 화면에 보일 셀 글자. 홀수 개의 백슬래시 뒤 공백 하나로 끝나면(원문의 C 드라이브 경로 끝 백슬래시 뒤 공백처럼), 그 공백은 모델(Task 2)이 끝 백슬래시가 닫는 파이프를
 * escape 하지 못하게 넣은 것이므로 정확히 하나만 뗀다.
 */
export function displayText(text: string): string {
  return /(?:^|[^\\])(?:\\\\)*\\ $/.test(text) ? text.slice(0, -1) : text;
}

const SKIP = new Set(['EmphasisMark', 'StrikethroughMark', 'CodeMark']);
const WRAP: Record<string, string> = { StrongEmphasis: 'strong', Emphasis: 'em', Strikethrough: 's' };
const BR = /^<br\s*\/?>$/i;

/** text 를 parent 에 인라인 DOM 으로 덧붙인다. */
export function renderInline(text: string, parent: HTMLElement): void {
  const shown = displayText(text);
  const src = PREFIX + shown + SUFFIX;
  const tree = labnoteParser.parse(src);
  const doc = parent.ownerDocument;
  const add = (to: HTMLElement, s: string) => {
    if (s) to.appendChild(doc.createTextNode(s));
  };

  /** node 의 [from, to) 를 그린다. 자식 사이의 빈틈은 글자다. */
  const children = (node: SyntaxNode, into: HTMLElement, from = node.from, to = node.to) => {
    let pos = from;
    for (let c = node.firstChild; c; c = c.nextSibling) {
      if (c.to <= from || c.from >= to) continue;
      if (c.from > pos) add(into, src.slice(pos, c.from));
      one(c, into);
      pos = c.to;
    }
    if (pos < to) add(into, src.slice(pos, to));
  };

  /** 링크·이미지의 이름표: 첫 LinkMark(`[` 또는 `![`) 뒤부터 둘째 LinkMark(`]`) 앞까지. */
  const label = (node: SyntaxNode, into: HTMLElement) => {
    const marks = node.getChildren('LinkMark');
    if (marks.length >= 2) children(node, into, marks[0].to, marks[1].from);
    else children(node, into);
  };

  const one = (node: SyntaxNode, into: HTMLElement) => {
    const name = node.name;
    if (SKIP.has(name)) return;
    if (name in WRAP) {
      const el = doc.createElement(WRAP[name]);
      children(node, el);
      into.appendChild(el);
    } else if (name === 'Escape') {
      add(into, src.slice(node.from + 1, node.to));
    } else if (name === 'InlineCode') {
      const marks = node.getChildren('CodeMark');
      const from = marks.length ? marks[0].to : node.from;
      const to = marks.length > 1 ? marks[marks.length - 1].from : node.to;
      const el = doc.createElement('code');
      // GFM: 표 안에서는 코드 스팬 안의 백슬래시+파이프도 파이프다
      add(el, src.slice(from, to).replace(/\\\|/g, '|'));
      into.appendChild(el);
    } else if (name === 'Link' || name === 'Image') {
      const el = doc.createElement('span');
      el.className = name === 'Link' ? 'lno-table-link' : 'lno-table-image';
      const url = node.getChild('URL');
      if (url) el.title = src.slice(url.from, url.to);
      label(node, el);
      into.appendChild(el);
    } else if (name === 'Autolink' || name === 'URL') {
      const url = name === 'URL' ? node : node.getChild('URL');
      const el = doc.createElement('span');
      el.className = 'lno-table-link';
      const s = url ? src.slice(url.from, url.to) : src.slice(node.from, node.to);
      el.title = s;
      add(el, s);
      into.appendChild(el);
    } else if (name === 'HTMLTag' && BR.test(src.slice(node.from, node.to))) {
      into.appendChild(doc.createElement('br'));
    } else if (node.firstChild) {
      children(node, into);
    } else {
      add(into, src.slice(node.from, node.to));
    }
  };

  // 셋째 줄(본문 행)의 셀들. 셀 글자에 escape 안 된 파이프는 없지만(모델이 거기서 나눈다), 있다면 글자로 잇는다.
  // 보일 글자의 끝에서 자른다: 끝 백슬래시 뒤에 붙인 SUFFIX 의 공백을 Lezer 는 escape 된 글자로 보고 셀에 넣는다.
  const end = PREFIX.length + shown.length;
  const row = tree.topNode.getChild('Table')?.getChildren('TableRow')[0];
  const cells = row?.getChildren('TableCell') ?? [];
  cells.forEach((cell, i) => {
    if (i > 0) add(parent, src.slice(cells[i - 1].to, cell.from).replace(/^\s+|\s+$/g, ''));
    children(cell, parent, cell.from, Math.min(cell.to, end));
  });
  // 파서가 표로 읽지 못하면(일어나지 않아야 한다) 원문을 글자로 둔다
  if (!row) add(parent, shown);
}
