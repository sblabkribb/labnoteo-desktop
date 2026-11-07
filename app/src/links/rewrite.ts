/**
 * Pure link rewriting for renames (plan SP4 Task 22, decisions D3, D12, D13).
 * Raw text in, raw text out: the input goes through `parseRaw` and the result through `toRaw`, so a BOM and
 * the line endings survive byte for byte. Only the path part of each link is replaced; aliases, `#subpaths`,
 * the table pipe escape, `!`, angle brackets and every other byte stay as they were. Every replacement is checked to resolve
 * back to its intended target (the post-condition) and to still parse as the same kind of link; a link that
 * cannot be written safely is left unchanged and counted in `unsafe`.
 */
import { parseRaw, toRaw } from '../editor/documentIo';
import { extractLinks, type LinkKind } from './extract';
import { createResolver, hasUnlinkableChars, linkKey, splitLinktext, stripLabnote, type Resolver } from './resolve';

export interface Move {
  from: string;
  to: string;
}

export interface RewriteContext {
  before: Resolver;
  after: Resolver;
  /** The path a moved file has after the rename, or undefined when it did not move. */
  moved(oldPath: string): string | undefined;
}

export interface RewriteResult {
  text: string;
  changed: number;
  unsafe: number;
}

function moveMap(moves: readonly Move[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of moves) map.set(linkKey(m.from), m.to);
  return map;
}

/** The file universe after the moves. */
export function applyMoves(files: readonly string[], moves: readonly Move[]): string[] {
  const map = moveMap(moves);
  return files.map((f) => map.get(linkKey(f)) ?? f);
}

/** to -> from, in the same order. */
export function invertMoves(moves: readonly Move[]): Move[] {
  return moves.map((m) => ({ from: m.to, to: m.from }));
}

/** A file: one pair. A folder: one pair per known file under it, in key order. */
export function movesFor(path: string, to: string, isDir: boolean, files: readonly string[]): Move[] {
  if (!isDir) return [{ from: path, to }];
  const prefix = `${linkKey(path)}/`;
  const depth = path.split('/').length;
  return files
    .filter((f) => linkKey(f).startsWith(prefix))
    // Slice by segments, not characters: `path` and `f` may differ in Unicode normalisation (NFD vs NFC).
    .map((f) => ({ key: linkKey(f), move: { from: f, to: [to, ...f.split('/').slice(depth)].join('/') } }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((x) => x.move);
}

export function rewriteContext(files: readonly string[], moves: readonly Move[]): RewriteContext {
  const map = moveMap(moves);
  return {
    before: createResolver(files),
    after: createResolver(applyMoves(files, moves)),
    moved: (oldPath) => map.get(linkKey(oldPath)),
  };
}

function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

function hasMd(s: string): boolean {
  return /\.md$/i.test(s);
}

function stripMd(s: string): string {
  return hasMd(s) ? s.slice(0, -3) : s;
}

/** The relative path from folder `fromDir` to the vault path `to`. */
function relativePath(fromDir: string, to: string): string {
  const a = fromDir === '' ? [] : fromDir.split('/');
  const b = to.split('/');
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/');
}

const hex = (c: string): string => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`;

/** D13 Markdown path encoding. `orig` is the old path slice (the part inside `<…>` when `angled`). */
function encodeMdPath(path: string, orig: string, angled: boolean): string {
  if (/%[0-9A-Fa-f]{2}/.test(orig)) {
    return path
      .split('/')
      .map((seg) => encodeURIComponent(seg).replace(/[()]/g, hex))
      .join('/');
  }
  // Inside <…> the path is raw; '%' and '#' are encoded too, because resolution percent-decodes and cuts at '#'.
  if (angled) return path.replace(/[<>%#]/g, hex);
  return path.replace(/[ ()<>#%]/g, hex);
}

const same = (a: string | null, b: string): boolean => a !== null && linkKey(a) === linkKey(b);

/**
 * The new path text for a wikilink in its original style (D13), or null when no safe text exists.
 * A link that resolved only through the `.labnote` fallback (resolve.ts: `[[x]]` -> x.labnote.md) is written in its
 * short form (`[[y]]`) when that still resolves to the target, else in the Obsidian form (`[[y.labnote]]`). Every
 * other link keeps the Obsidian form.
 */
function wikiText(oldPath: string, want: string, sourceAfter: string, ctx: RewriteContext, viaFallback: boolean): string | null {
  const keepMd = hasMd(oldPath);
  const withMd = (s: string): string => (keepMd && !hasMd(s) ? `${s}.md` : s);
  let first: string | null;
  if (!oldPath.includes('/')) {
    const t = ctx.after.linktextFor(want, sourceAfter);
    if (t === null) return null; // D3: no wikilink can name this target from here
    first = withMd(t);
  } else if (oldPath.startsWith('./') || oldPath.startsWith('../')) {
    let rel = relativePath(dirOf(sourceAfter), stripMd(want));
    // Stays relative: a path that goes down from the source folder gets './' (D2 4a), whichever prefix it had.
    if (!rel.startsWith('../')) rel = `./${rel}`;
    first = withMd(rel);
  } else if (oldPath.startsWith('/')) {
    first = withMd(`/${stripMd(want)}`);
  } else {
    first = withMd(stripMd(want));
  }
  // Post-condition, then the rooted form as the fallback; a fallback link tries its short forms first.
  const rooted = withMd(`/${stripMd(want)}`);
  const forms = viaFallback && !keepMd ? [stripLabnote(first), first, stripLabnote(rooted), rooted] : [first, rooted];
  for (const c of forms) {
    if (hasUnlinkableChars(c)) continue;
    if (same(ctx.after.resolveWiki(c, sourceAfter), want)) return c;
  }
  return null;
}

/** The new path text for a Markdown link in its original style (D13), or null when no safe text exists. */
function mdText(oldPath: string, angled: boolean, want: string, sourceAfter: string, ctx: RewriteContext, viaFallback: boolean): string | null {
  const styled = (target: string): string[] => {
    if (oldPath.startsWith('/')) return [`/${target}`];
    let path = relativePath(dirOf(sourceAfter), target);
    if (oldPath.startsWith('./') && !path.startsWith('../')) path = `./${path}`;
    return [path, `/${target}`];
  };
  // Keep '.md' only when the original had it; the post-condition decides whether the bare form still resolves.
  const bare = hasMd(want) && !hasMd(oldPath) ? styled(stripMd(want)) : [];
  // A link that resolved only through the `.labnote` fallback tries its short form first (see `wikiText`).
  const short = viaFallback && !hasMd(oldPath) && /\.labnote\.md$/i.test(want) ? styled(stripLabnote(stripMd(want))) : [];
  const full = styled(want);
  // A fallback link: each style (relative, then rooted) from its short form to its full form, so a rooted short form
  // never wins over the relative Obsidian form.
  const forms =
    short.length > 0
      ? full.flatMap((_, i) => [short[i], bare[i], full[i]]).filter((p): p is string => p !== undefined)
      : [...bare, ...full];
  for (const p of forms) {
    const encoded = encodeMdPath(p, oldPath, angled);
    if (same(ctx.after.resolveMd(encoded, sourceAfter), want)) return encoded;
  }
  return null;
}

export function rewriteLinks(raw: string, sourceBefore: string, sourceAfter: string, ctx: RewriteContext): RewriteResult {
  const { text, changed, unsafe } = rewriteLinksDetailed(raw, sourceBefore, sourceAfter, ctx);
  return { text, changed, unsafe };
}

export interface DetailedRewriteResult extends RewriteResult {
  /** Wikilinks and embeds among the changed and the unsafe links (D11: a bad new name refuses only these). */
  wiki: number;
  /**
   * Changed links whose target did not move but would be taken over by the new name (the hijack guard pins them).
   * Only these make a second pass over already rewritten text harmful: a rewritten link that names the moved note
   * reads, in the before-universe, as a link to the note it would hijack, and would be pinned there.
   */
  pinned: number;
}

/** `rewriteLinks`, also counting the wikilinks and embeds it changed or could not write. */
export function rewriteLinksDetailed(raw: string, sourceBefore: string, sourceAfter: string, ctx: RewriteContext): DetailedRewriteResult {
  const doc = parseRaw(sourceBefore, raw);
  const text = doc.text;
  let edits: { from: number; to: number; insert: string; kind: LinkKind; pin: boolean }[] = [];
  let unsafe = 0;
  let wikiUnsafe = 0;
  const isWikiKind = (k: LinkKind): boolean => k === 'wiki' || k === 'embed';

  const links = extractLinks(text);
  for (const link of links) {
    const isWiki = link.kind === 'wiki' || link.kind === 'embed';
    const linkpath = isWiki ? splitLinktext(link.target).path : link.target;
    // A same-note link ([[#heading]], [[#^block]]) names no file: it follows its note wherever it goes.
    if (isWiki && linkpath === '') continue;
    const resolveAs = (r: Resolver, source: string): string | null =>
      isWiki ? r.resolveWiki(linkpath, source) : r.resolveMd(link.target, source);
    const before = resolveAs(ctx.before, sourceBefore);
    if (before === null) continue; // unresolved links are never touched
    // Resolved only through the `.labnote` fallback (resolve.ts): the rewrite keeps its short form when it can.
    const viaFallback =
      (isWiki ? ctx.before.resolveWikiStrict(linkpath, sourceBefore) : ctx.before.resolveMdStrict(link.target, sourceBefore)) === null;
    const movedTo = ctx.moved(before);
    const want = movedTo ?? before;
    // Not moved and still resolving to the same file: leave it. Otherwise rewrite or pin it (the hijack guard).
    if (movedTo === undefined && same(resolveAs(ctx.after, sourceAfter), want)) continue;

    const oldSlice = text.slice(link.pathFrom, link.pathTo);
    let insert: string | null;
    if (isWiki) {
      const quote = link.inFrontmatter ? text[link.from - 1] : '';
      // In a single-quoted YAML scalar ' is written ''; the resolver sees the unescaped path.
      const oldPath = quote === "'" ? oldSlice.replace(/''/g, "'") : oldSlice;
      insert = wikiText(oldPath, want, sourceAfter, ctx, viaFallback);
      // A '"' or '\' would change a double-quoted YAML scalar: never write one there.
      if (insert !== null && quote === '"' && /["\\]/.test(insert)) insert = null;
      if (insert !== null && quote === "'") insert = insert.replace(/'/g, "''");
      // Not directly quote-delimited: the link may sit inside a quoted or plain YAML scalar whose style is unknown
      // here. Never introduce a quote, a backslash or a comma (flow sequences) there.
      if (insert !== null && link.inFrontmatter && quote !== "'" && quote !== '"') {
        const risky = [...insert].some((c) => `'"\\,{}`.includes(c) && !oldSlice.includes(c));
        if (risky) insert = null;
      }
    } else {
      insert = mdText(oldSlice, text[link.pathFrom - 1] === '<', want, sourceAfter, ctx, viaFallback);
    }
    if (insert === null) {
      unsafe++;
      if (isWiki) wikiUnsafe++;
      continue;
    }
    if (insert !== oldSlice) edits.push({ from: link.pathFrom, to: link.pathTo, insert, kind: link.kind, pin: movedTo === undefined });
  }

  // Parse check: every edited range must still be a link of the same kind (a '`' can open a code span, for
  // example). The first edit that fails is dropped and counted unsafe, since it may be what broke the later ones;
  // then the rest is checked again.
  edits.sort((x, y) => x.from - y.from);
  for (;;) {
    if (edits.length === 0) return { text: raw, changed: 0, unsafe, wiki: wikiUnsafe, pinned: 0 };
    const out = applyEdits(text, edits);
    const found = new Set(extractLinks(out).map((l) => `${l.kind}:${l.pathFrom}:${l.pathTo}`));
    let shift = 0;
    const bad = edits.findIndex((e) => {
      const from = e.from + shift;
      shift += e.insert.length - (e.to - e.from);
      return !found.has(`${e.kind}:${from}:${from + e.insert.length}`);
    });
    if (bad < 0) {
      // Backstop: an edit must never make an untouched link disappear. If one did, write nothing.
      const wikiEdits = edits.filter((e) => isWikiKind(e.kind)).length;
      if (found.size !== links.length) return { text: raw, changed: 0, unsafe: unsafe + edits.length, wiki: wikiUnsafe + wikiEdits, pinned: 0 };
      const pinned = edits.filter((e) => e.pin).length;
      return { text: toRaw(doc, out), changed: edits.length, unsafe, wiki: wikiUnsafe + wikiEdits, pinned };
    }
    unsafe++;
    if (isWikiKind(edits[bad].kind)) wikiUnsafe++;
    edits = edits.filter((_, i) => i !== bad);
  }
}

function applyEdits(text: string, edits: readonly { from: number; to: number; insert: string }[]): string {
  let out = text;
  for (const e of [...edits].sort((a, b) => b.from - a.from)) out = out.slice(0, e.from) + e.insert + out.slice(e.to);
  return out;
}
