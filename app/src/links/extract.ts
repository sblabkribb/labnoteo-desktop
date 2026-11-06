/**
 * Link extraction from note text (plan SP4 Task 2).
 * One parser for the index, the rename rewriter and the Properties grid: the editor's own `labnoteParser`,
 * so a link the editor draws is exactly a link the index sees. Code (inline, fenced, indented), HTML blocks
 * and comments are skipped. Front-matter links (`retry_of`, `author`, ...) are found by a regex over the
 * `Frontmatter` node, because the parser does not look inside YAML.
 * Callers pass editor text (`parseRaw(path, raw).text`); a leading BOM is still skipped defensively and
 * every offset stays an offset into the text that was passed in.
 */
import type { SyntaxNode } from '@lezer/common';
import { parseFrontMatterYaml } from '@labnoteo/core';
import { labnoteParser } from '../editor/markdownSyntax';

export type LinkKind = 'wiki' | 'embed' | 'md' | 'image';

export interface ExtractedLink {
  kind: LinkKind;
  /** wiki/embed: the WikiTarget text incl. '#subpath' (front matter: YAML '' unescaped to '); md/image: href, angles stripped, incl. '#fragment'. */
  target: string;
  /** wiki/embed alias text. */
  alias?: string;
  /** The whole link node. */
  from: number;
  to: number;
  /** The rewritable path part (no '#…', no '<>'). */
  pathFrom: number;
  pathTo: number;
  /** 0-based line of `from`. */
  line: number;
  inFrontmatter: boolean;
  /** The line, cut to CONTEXT_MAX around the link. */
  context: string;
  /** The link's position inside `context`. */
  contextFrom: number;
  contextTo: number;
}

export const CONTEXT_MAX = 240;
/** How much of the line before the link a cut context keeps. */
const CONTEXT_LEAD = 80;

export interface NoteMeta {
  aliases: string[];
  title?: string;
}

type Found = Omit<ExtractedLink, 'line' | 'context' | 'contextFrom' | 'contextTo'>;

const BOM = '﻿';
const SKIP = new Set(['InlineCode', 'FencedCode', 'CodeBlock', 'HTMLBlock', 'Comment', 'CommentBlock']);
const FRONT_WIKI = /!?\[\[([^[\]\n\r]+)\]\]/g;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** A cheap prefilter: false means the text certainly has no link `extractLinks` would return. */
export function hasLinkSyntax(text: string): boolean {
  return text.includes('[[') || text.includes('](') || text.includes(']:');
}

/** Start offset of every line of `text`. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return starts;
}

/** The 0-based line that holds `pos` (binary search over the line starts). */
function lineOf(starts: number[], pos: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Every link in `text`, in document order. Scheme links (`https:` …) and `#…`-only links are left out. */
export function extractLinks(text: string): ExtractedLink[] {
  const shift = text.startsWith(BOM) ? 1 : 0;
  const src = shift ? text.slice(1) : text;
  const starts = lineStarts(text);
  const out: ExtractedLink[] = [];

  const push = (link: Found): void => {
    const line = lineOf(starts, link.from);
    let lineFrom = starts[line];
    if (line === 0) lineFrom += shift;
    let lineTo = line + 1 < starts.length ? starts[line + 1] - 1 : text.length;
    if (lineTo > lineFrom && text[lineTo - 1] === '\r') lineTo--;
    const full = text.slice(lineFrom, lineTo);
    const at = link.from - lineFrom;
    const long = full.length > CONTEXT_MAX;
    const cut = long ? Math.max(0, at - CONTEXT_LEAD) : 0;
    const context = long ? full.slice(cut, cut + CONTEXT_MAX) : full;
    const contextFrom = at - cut;
    const contextTo = Math.min(link.to - lineFrom - cut, context.length);
    out.push({ ...link, line, context, contextFrom, contextTo });
  };

  const frontmatter = (from: number, to: number): void => {
    const body = src.slice(from, to);
    FRONT_WIKI.lastIndex = 0;
    for (let m = FRONT_WIKI.exec(body); m; m = FRONT_WIKI.exec(body)) {
      const embed = m[0].startsWith('!');
      const start = from + m.index;
      const open = start + (embed ? 3 : 2);
      const inner = m[1];
      const bar = inner.indexOf('|');
      const rawTarget = bar < 0 ? inner : inner.slice(0, bar);
      if (rawTarget.trim() === '') continue;
      const rawAlias = bar < 0 ? '' : inner.slice(bar + 1);
      // Inside a single-quoted YAML scalar a quote is written ''. The path range stays on the raw bytes.
      const quoted = start > 0 && src[start - 1] === "'";
      const unquote = (s: string): string => (quoted ? s.replace(/''/g, "'") : s);
      const hash = rawTarget.indexOf('#');
      const link: Found = {
        kind: embed ? 'embed' : 'wiki',
        target: unquote(rawTarget),
        from: start + shift,
        to: start + m[0].length + shift,
        pathFrom: open + shift,
        pathTo: open + (hash < 0 ? rawTarget.length : hash) + shift,
        inFrontmatter: true,
      };
      if (rawAlias !== '') link.alias = unquote(rawAlias);
      push(link);
    }
  };

  const wiki = (node: SyntaxNode, embed: boolean): void => {
    const target = node.getChild('WikiTarget');
    if (!target) return;
    const targetText = src.slice(target.from, target.to);
    const hash = targetText.indexOf('#');
    const alias = node.getChild('WikiAlias');
    const link: Found = {
      kind: embed ? 'embed' : 'wiki',
      target: targetText,
      from: node.from + shift,
      to: node.to + shift,
      pathFrom: target.from + shift,
      pathTo: (hash < 0 ? target.to : target.from + hash) + shift,
      inFrontmatter: false,
    };
    if (alias) link.alias = src.slice(alias.from, alias.to);
    push(link);
  };

  const markdownLink = (node: SyntaxNode, kind: 'md' | 'image'): void => {
    const url = node.getChild('URL');
    if (!url) return;
    let from = url.from;
    let to = url.to;
    if (to - from >= 2 && src[from] === '<' && src[to - 1] === '>') {
      from++;
      to--;
    }
    const href = src.slice(from, to);
    if (href === '' || href.startsWith('#') || SCHEME.test(href)) return;
    const hash = href.indexOf('#');
    push({
      kind,
      target: href,
      from: node.from + shift,
      to: node.to + shift,
      pathFrom: from + shift,
      pathTo: (hash < 0 ? to : from + hash) + shift,
      inFrontmatter: false,
    });
  };

  labnoteParser.parse(src).iterate({
    enter(ref) {
      const name = ref.name;
      if (SKIP.has(name)) return false;
      switch (name) {
        case 'Frontmatter':
          frontmatter(ref.from, ref.to);
          return false;
        case 'WikiLink':
          wiki(ref.node, false);
          return false;
        case 'Embed':
          wiki(ref.node, true);
          return false;
        case 'Link':
          markdownLink(ref.node, 'md');
          return undefined; // the link text may hold an image
        case 'LinkReference':
          markdownLink(ref.node, 'md');
          return false;
        case 'Image':
          markdownLink(ref.node, 'image');
          return false;
        default:
          return undefined;
      }
    },
  });
  return out;
}

/** Aliases (`aliases` or `alias`, a string or a list; trimmed, non-empty) and a string `title`, from one front-matter parse. */
export function extractMeta(text: string): NoteMeta {
  const src = (text.startsWith(BOM) ? text.slice(1) : text).replace(/\r\n?/g, '\n');
  const { frontMatter } = parseFrontMatterYaml(src);
  const raw = frontMatter.aliases ?? frontMatter.alias;
  const list: unknown[] = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  const aliases: string[] = [];
  for (const a of list) {
    if (typeof a !== 'string' && typeof a !== 'number') continue;
    const s = String(a).trim();
    if (s !== '') aliases.push(s);
  }
  const meta: NoteMeta = { aliases };
  const title = frontMatter.title;
  if (typeof title === 'string' && title.trim() !== '') meta.title = title.trim();
  return meta;
}
