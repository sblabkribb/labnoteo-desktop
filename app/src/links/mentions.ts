/**
 * Unlinked mentions (plan SP4 Task 19, D10): plain-text mentions of a note's names in other notes,
 * and the Link action that turns one mention into a wikilink.
 * - A note's names are its basename without `.labnote.md`/`.md` (a `README.labnote.md` uses its front-matter
 *   title instead), then its aliases; names shorter than MENTION_MIN characters are skipped.
 * - A mention needs the line start or a character that is neither a letter nor a digit before it. The right side
 *   is free, so Korean particles (`PCR 조건을`) still match. Matching ignores case.
 * - Mentions inside links, URLs, code, HTML, comments and front matter are skipped. The text is parsed with the
 *   editor's own `labnoteParser`, so "inside a link" means exactly what the editor draws as a link.
 */
import { labnoteParser } from '../editor/markdownSyntax';
import { parseRaw, toRaw } from '../editor/documentIo';
import { NoteChangedError } from '../labnote/noteErrors';
import { CONTEXT_MAX } from './extract';
import { linkKey } from './resolve';

export const MENTION_MIN = 2;
/** The search limit per name; equal to Rust `MAX_LIMIT`. */
export const MENTION_LIMIT = 200;

export interface Mention {
  /** 0-based line. */
  line: number;
  /** Offsets into the text that was searched. */
  from: number;
  to: number;
  /** The matched text, in the spelling the note uses. */
  text: string;
  /** Index among the mentions with exactly this text on this line (what `linkMention` re-finds). */
  nth: number;
  /** Under a GFM table: the alias separator must be written as a backslash and a pipe. */
  inTable: boolean;
  /** The line, cut to CONTEXT_MAX around the mention. */
  context: string;
  contextFrom: number;
  contextTo: number;
}

export interface MentionResult {
  groups: { source: string; mentions: Mention[] }[];
  /** A search returned fewer notes than matched. */
  truncated: boolean;
}

const BOM = '﻿';
/** Nodes whose text is never a plain mention. */
const SKIP = new Set([
  'Frontmatter',
  'WikiLink',
  'Embed',
  'Link',
  'Image',
  'LinkReference',
  'URL',
  'Autolink',
  'InlineCode',
  'FencedCode',
  'CodeBlock',
  'HTMLBlock',
  'HTMLTag',
  'Comment',
  'CommentBlock',
]);
/** How much of the line before the mention a cut context keeps (as in extract.ts). */
const CONTEXT_LEAD = 80;
/** Characters a name may not hold: they would break the wikilink the Link action writes. */
const BAD_NAME = /[[\]|\r\n]/;

function stripExt(base: string): string {
  return base.replace(/\.labnote\.md$/i, '').replace(/\.md$/i, '');
}

/** The names a note is mentioned by, deduplicated by link key, in order: basename (or README title), aliases. */
export function mentionNames(path: string, meta: { aliases: readonly string[]; title?: string }): string[] {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const first = /^readme\.labnote\.md$/i.test(base) ? meta.title?.trim() : stripExt(base);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of [first, ...meta.aliases]) {
    const name = raw?.trim() ?? '';
    if ([...name].length < MENTION_MIN || BAD_NAME.test(name)) continue;
    const key = linkKey(name);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

interface Scanned {
  skips: Array<[number, number]>;
  tables: Array<[number, number]>;
  lineStarts: number[];
}

function scanStructure(text: string): Scanned {
  const shift = text.startsWith(BOM) ? 1 : 0;
  const src = shift ? text.slice(1) : text;
  const skips: Array<[number, number]> = [];
  const tables: Array<[number, number]> = [];
  labnoteParser.parse(src).iterate({
    enter(ref) {
      if (SKIP.has(ref.name)) {
        skips.push([ref.from + shift, ref.to + shift]);
        return false;
      }
      if (ref.name === 'Table') tables.push([ref.from + shift, ref.to + shift]);
      return undefined;
    },
  });
  const lineStarts = [0];
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) lineStarts.push(i + 1);
  return { skips, tables, lineStarts };
}

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

function overlaps(ranges: ReadonlyArray<[number, number]>, from: number, to: number): boolean {
  return ranges.some(([a, b]) => from < b && to > a);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface Raw {
  from: number;
  to: number;
  text: string;
  line: number;
  nth: number;
}

/** Every unskipped match of one name, with `nth` counted among equal spellings on the same line. */
function scanName(text: string, name: string, s: Scanned): Raw[] {
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(name)}`, 'giu');
  const out: Raw[] = [];
  const counts = new Map<string, number>();
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const from = m.index;
    const to = from + m[0].length;
    if (to === from) {
      re.lastIndex++;
      continue;
    }
    if (overlaps(s.skips, from, to)) continue;
    const line = lineOf(s.lineStarts, from);
    const k = `${line}\u0000${m[0]}`;
    const nth = counts.get(k) ?? 0;
    counts.set(k, nth + 1);
    out.push({ from, to, text: m[0], line, nth });
  }
  return out;
}

function contextOf(text: string, s: Scanned, r: Raw): Pick<Mention, 'context' | 'contextFrom' | 'contextTo'> {
  let lineFrom = s.lineStarts[r.line];
  if (r.line === 0 && text.startsWith(BOM)) lineFrom += 1;
  let lineTo = r.line + 1 < s.lineStarts.length ? s.lineStarts[r.line + 1] - 1 : text.length;
  if (lineTo > lineFrom && text[lineTo - 1] === '\r') lineTo--;
  const full = text.slice(lineFrom, lineTo);
  const at = r.from - lineFrom;
  const long = full.length > CONTEXT_MAX;
  const cut = long ? Math.max(0, at - CONTEXT_LEAD) : 0;
  const context = long ? full.slice(cut, cut + CONTEXT_MAX) : full;
  return { context, contextFrom: at - cut, contextTo: Math.min(r.to - lineFrom - cut, context.length) };
}

/** Plain-text mentions of any of `names` in editor text, in document order; overlapping matches keep the longer. */
export function findMentions(text: string, names: readonly string[]): Mention[] {
  const usable = names.filter((n) => n !== '' && !BAD_NAME.test(n));
  if (usable.length === 0) return [];
  const s = scanStructure(text);
  const all = usable.flatMap((n) => scanName(text, n, s));
  all.sort((a, b) => a.from - b.from || b.to - a.to);
  const out: Mention[] = [];
  let end = -1;
  for (const r of all) {
    if (r.from < end) continue;
    end = r.to;
    out.push({
      line: r.line,
      from: r.from,
      to: r.to,
      text: r.text,
      nth: r.nth,
      inTable: overlaps(s.tables, r.from, r.to),
      ...contextOf(text, s, r),
    });
  }
  return out;
}

/**
 * Turns the `nth` mention spelled `m.text` on line `m.line` into a wikilink to `linktext`: `[[linktext]]` when the
 * spelling equals the link text, else `[[linktext|spelling]]` (a backslash before the pipe inside a table). Takes disk text or editor text
 * and keeps its BOM and line endings. Throws NoteChangedError when that mention is no longer there.
 */
export function linkMention(raw: string, m: { line: number; text: string; nth: number }, linktext: string): string {
  const doc = parseRaw('', raw);
  const text = doc.text;
  const found = findMentions(text, [m.text]).filter((x) => x.line === m.line && x.text === m.text)[m.nth];
  if (!found) throw new NoteChangedError('');
  const link =
    found.text === linktext ? `[[${linktext}]]` : `[[${linktext}${found.inTable ? '\\|' : '|'}${found.text}]]`;
  return toRaw(doc, text.slice(0, found.from) + link + text.slice(found.to));
}

/**
 * Searches the full-text index for each of the target's names, re-reads every hit (except the target itself)
 * and finds its plain-text mentions. A note that cannot be read (deleted since it was indexed) is left out.
 */
export async function unlinkedMentions(
  target: string,
  deps: {
    search(q: string, limit: number): Promise<{ hits: { path: string }[]; truncated: boolean }>;
    read(p: string): Promise<string>;
    meta: { aliases: readonly string[]; title?: string };
  },
): Promise<MentionResult> {
  const names = mentionNames(target, deps.meta);
  if (names.length === 0) return { groups: [], truncated: false };
  const targetKey = linkKey(target);
  const sources = new Map<string, string>();
  let truncated = false;
  for (const name of names) {
    const r = await deps.search(name, MENTION_LIMIT);
    truncated ||= r.truncated;
    for (const hit of r.hits) {
      const key = linkKey(hit.path);
      if (key !== targetKey && !sources.has(key)) sources.set(key, hit.path);
    }
  }
  const groups: MentionResult['groups'] = [];
  for (const key of [...sources.keys()].sort()) {
    const source = sources.get(key)!;
    let raw: string;
    try {
      raw = await deps.read(source);
    } catch {
      continue;
    }
    const mentions = findMentions(parseRaw(source, raw).text, names);
    if (mentions.length > 0) groups.push({ source, mentions });
  }
  return { groups, truncated };
}
