/**
 * Subpath targeting (plan SP4 Task 3, D5 and D9).
 * Finds the editor line a link's `#subpath` (wikilink) or `#anchor` (Markdown link) points at:
 * a block id `^id`, a heading by loose text match, or a GitHub heading anchor.
 * Lines are numbered as the editor numbers them: the raw disk text goes through `parseRaw` and is split
 * by `lineSeparatorOf`, so a BOM or mixed line endings never shift the result.
 */
import { resolveGithubAnchor } from '@labnoteo/core';
import { lineSeparatorOf, parseRaw } from '../editor/documentIo';
import { bodyLineMask, extractOutline } from '../editor/outline/extract';

/**
 * Lowercase, turn every run of other characters into a space, collapse spaces, trim (D5).
 * Punctuation reads as a space so `sanitizeHeading` output (`Step 1:PCR` -> `Step 1 PCR`) keys the same as its heading.
 */
export function looseHeadingKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Heading text as a link may carry it (D9): `#`, `|`, `^`, `:`, `%%`, `[[`, `]]`, `[`, `]` become a space. */
export function sanitizeHeading(s: string): string {
  return s
    .replace(/%%|\[\[|\]\]|[#|^:[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function editorLines(raw: string): string[] {
  const d = parseRaw('', raw);
  // Each editor line, without the line ending; a CR or LF left inside a line (mixed files) reads as a space,
  // so line-based scanners that split on `\n` see exactly the editor's lines.
  return d.text.split(lineSeparatorOf(d)).map((l) => l.replace(/\r$/, '').replace(/[\r\n]/g, ' '));
}

function headingLine(lines: string[], text: string): number | undefined {
  const key = looseHeadingKey(text);
  if (!key) return undefined;
  const items = extractOutline(lines);
  // A heading as written wins: a coded heading `## [WB030 Western] blot` (listed as code + label) is written as
  // `WB030 Western blot`. Only when nothing matches that way does a coded heading match on its label alone.
  const written = items.find((item) => looseHeadingKey(item.code ? `${item.code} ${item.text}` : item.text) === key);
  const found = written ?? items.find((item) => item.code && looseHeadingKey(item.text) === key);
  return found ? found.line - 1 : undefined;
}

function blockLine(lines: string[], id: string): number | undefined {
  if (!id) return undefined;
  const escaped = id.replace(/[.*+?^$()|[\]{}\\]/g, '\\$&');
  const re = new RegExp('(?:^|\\s)\\^' + escaped + '\\s*$');
  // Obsidian does not index block ids inside front matter or fenced code.
  const body = bodyLineMask(lines);
  const i = lines.findIndex((l, n) => body[n] && re.test(l));
  return i === -1 ? undefined : i;
}

const anchorLine = (lines: string[], anchor: string): number | undefined => resolveGithubAnchor(lines.join('\n'), anchor);

/** 0-based editor line of the target, or undefined when nothing matches. Raw disk text is fine. */
export function subpathLine(raw: string, sub: { subpath?: string; anchor?: string }): number | undefined {
  if (sub.subpath) {
    const seg = sub.subpath.slice(sub.subpath.lastIndexOf('#') + 1).trim();
    if (!seg) return undefined;
    const lines = editorLines(raw);
    if (seg.startsWith('^')) return blockLine(lines, seg.slice(1));
    return headingLine(lines, seg) ?? anchorLine(lines, seg);
  }
  if (sub.anchor) {
    const anchor = sub.anchor.replace(/^#/, '');
    if (!anchor) return undefined;
    const lines = editorLines(raw);
    return anchorLine(lines, anchor) ?? headingLine(lines, anchor);
  }
  return undefined;
}
