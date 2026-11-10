/**
 * Obsidian-style link resolution (plan SP4 Task 1, decisions D1-D3, D12).
 * Pure: a resolver is built once from the file universe (vault-relative paths with '/'),
 * and answers which file a wikilink or Markdown link names from a given source note.
 * Every key comparison uses `linkKey` (NFC + lower case).
 *
 * The `.labnote` fallback (a deliberate departure from Obsidian): the app names its notes `x.labnote.md`, whose
 * Obsidian basename is `x.labnote`, so a hand-typed `[[x]]` would be unresolved under Obsidian's rules and a click
 * would create a duplicate `x.md`. When a wikilink, or a Markdown link, does not resolve under the normal rules and
 * the last segment of its path neither ends in `.labnote` or `.md` nor names an image or attachment
 * (`labnoteFallback`), the same lookup runs again with `.labnote` appended, with the same tie-break rules. An exact
 * match therefore always wins (`[[a]]` with both a.md and a.labnote.md is a.md). `linktextFor` still writes the
 * Obsidian-compatible `x.labnote`, so every link the app writes keeps resolving in Obsidian and in the plugin.
 * `resolveWikiStrict` and `resolveMdStrict` answer by Obsidian's rules alone (the rename rewriter uses them to tell
 * a link that resolves only through the fallback apart, and keeps it in its short form).
 */
import { IMAGE_EXTS as IMAGE_EXT_LIST } from '../editor/live/imagePath';

export interface Linktext {
  path: string;
  /** Without the leading '#', '' if none. */
  subpath: string;
}

/** Image extensions (the same set as `editor/live/imagePath.ts`). */
export const IMAGE_EXTS: ReadonlySet<string> = new Set(IMAGE_EXT_LIST);

/** Attachment extensions: links to these are "unknown", never drawn unresolved (D1). */
export const ATTACHMENT_EXTS: ReadonlySet<string> = new Set([
  'pdf', 'docx', 'doc', 'xlsx', 'xls', 'pptx', 'csv', 'tsv', 'zip', 'mp4', 'mov', 'mp3', 'wav', 'txt', 'json',
]);

export function linkKey(s: string): string {
  return s.normalize('NFC').toLowerCase();
}

/** The first '#' splits path and subpath; the path is trimmed and NFC-normalised. */
export function splitLinktext(target: string): Linktext {
  const i = target.indexOf('#');
  const path = (i < 0 ? target : target.slice(0, i)).trim().normalize('NFC');
  const subpath = i < 0 ? '' : target.slice(i + 1);
  return { path, subpath };
}

function lastSegment(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}

function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

function stripMd(s: string): string {
  return /\.md$/i.test(s) ? s.slice(0, -3) : s;
}

function extOf(name: string): string {
  const seg = lastSegment(name);
  const i = seg.lastIndexOf('.');
  return i < 0 ? '' : seg.slice(i + 1).toLowerCase();
}

/** 'x/y.labnote.md' -> 'y.labnote', 'images/a.png' -> 'a.png'. */
export function wikiBasename(path: string): string {
  return stripMd(lastSegment(path));
}

/** D12: linkKey(last segment with one trailing '.md' stripped). */
export function basenameKey(path: string): string {
  return linkKey(wikiBasename(path));
}

const LABNOTE_SUFFIX = /\.labnote$/i;

/**
 * The link path with `.labnote` appended, or null when the fallback does not apply: an empty last segment, one that
 * already ends in `.labnote` or `.md`, or one with an image or attachment extension.
 */
export function labnoteFallback(linkpath: string): string | null {
  const seg = lastSegment(linkpath);
  if (seg.trim() === '' || seg === '.' || seg === '..' || LABNOTE_SUFFIX.test(seg) || /\.md$/i.test(seg)) return null;
  const ext = extOf(seg);
  if (IMAGE_EXTS.has(ext) || ATTACHMENT_EXTS.has(ext)) return null;
  return `${linkpath}.labnote`;
}

/** `x.labnote` -> `x` (case-insensitive); anything else unchanged. For display and for the short link form. */
export function stripLabnote(name: string): string {
  return LABNOTE_SUFFIX.test(name) ? name.slice(0, -'.labnote'.length) : name;
}

/**
 * True when a folderless link path names the note at `notePath` itself: its basename, or its basename through the
 * `.labnote` fallback. For self links before the note is in the file list.
 */
export function isSelfLinkName(linkpath: string, notePath: string): boolean {
  if (notePath === '' || linkpath.includes('/')) return false;
  const key = basenameKey(notePath);
  if (linkKey(linkpath) === key) return true;
  const fb = labnoteFallback(linkpath);
  return fb !== null && linkKey(fb) === key;
}

/** Characters Obsidian forbids in linkable names. */
export function hasUnlinkableChars(name: string): boolean {
  return /[#|^[\]]/.test(name);
}

export interface Resolver {
  readonly files: readonly string[];
  has(path: string): boolean;
  canonical(path: string): string | undefined;
  /** Obsidian's rules, then the `.labnote` fallback. */
  resolveWiki(linkpath: string, sourcePath: string): string | null;
  /** Obsidian's rules, then the `.labnote` fallback. */
  resolveMd(href: string, sourcePath: string): string | null;
  /** Obsidian's rules only. */
  resolveWikiStrict(linkpath: string, sourcePath: string): string | null;
  /** Obsidian's rules only. */
  resolveMdStrict(href: string, sourcePath: string): string | null;
  linktextFor(target: string, sourcePath: string): string | null;
  isUnknownTarget(linkpath: string): boolean;
}

/** Joins `rel` to `dir` and folds '.' and '..'; null when it climbs out of the vault. */
function joinPath(dir: string, rel: string): string | null {
  const out = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(seg);
  }
  return out.join('/');
}

function segments(path: string): number {
  return path.split('/').length;
}

export function createResolver(files: readonly string[]): Resolver {
  const list = [...files];
  /** key(path) -> stored path (first spelling wins). */
  const byKey = new Map<string, string>();
  /** key(last segment, extension included) -> paths. */
  const byName = new Map<string, string[]>();
  for (const f of list) {
    const k = linkKey(f);
    if (byKey.has(k)) continue;
    byKey.set(k, f);
    const n = linkKey(lastSegment(f));
    const arr = byName.get(n);
    if (arr) arr.push(f);
    else byName.set(n, [f]);
  }

  /** D2 step 6: same folder as the source, then fewer segments, shorter path, key order. */
  const pick = (matches: readonly string[], sourcePath: string): string | null => {
    if (matches.length === 0) return null;
    if (matches.length === 1) return matches[0];
    const srcDir = linkKey(dirOf(sourcePath));
    const sorted = [...matches].sort((a, b) => {
      const sa = linkKey(dirOf(a)) === srcDir ? 0 : 1;
      const sb = linkKey(dirOf(b)) === srcDir ? 0 : 1;
      if (sa !== sb) return sa - sb;
      const ga = segments(a) - segments(b);
      if (ga !== 0) return ga;
      if (a.length !== b.length) return a.length - b.length;
      const ka = linkKey(a);
      const kb = linkKey(b);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    return sorted[0];
  };

  const candidatesOf = (name: string): string[] => (/\.md$/i.test(name) ? [name] : [name, `${name}.md`]);

  const exact = (path: string): string | null => {
    for (const c of candidatesOf(path)) {
      const hit = byKey.get(linkKey(c));
      if (hit !== undefined) return hit;
    }
    return null;
  };

  /** D2 step 5: by last segment (extension included). */
  const byBasename = (name: string, sourcePath: string): string | null => {
    for (const c of candidatesOf(name)) {
      const hit = pick(byName.get(linkKey(c)) ?? [], sourcePath);
      if (hit !== null) return hit;
    }
    return null;
  };

  const bySuffix = (name: string, sourcePath: string): string | null => {
    for (const c of candidatesOf(name)) {
      const suffix = `/${linkKey(c)}`;
      const hits: string[] = [];
      for (const [k, f] of byKey) if (k.endsWith(suffix)) hits.push(f);
      const hit = pick(hits, sourcePath);
      if (hit !== null) return hit;
    }
    return null;
  };

  const resolveWikiStrict = (linkpath: string, sourcePath: string): string | null => {
    const lp = linkpath.trim().normalize('NFC');
    if (lp === '') return byKey.get(linkKey(sourcePath)) ?? null;
    if (lp.includes('\\') || lp.includes(':')) return null;
    if (lp.includes('/')) {
      if (lp.startsWith('./') || lp.startsWith('../')) {
        const joined = joinPath(dirOf(sourcePath), lp);
        return joined === null || joined === '' ? null : exact(joined);
      }
      if (lp.startsWith('/')) {
        const rooted = lp.replace(/^\/+/, '');
        return rooted === '' ? null : exact(rooted);
      }
      return exact(lp) ?? bySuffix(lp, sourcePath);
    }
    return byBasename(lp, sourcePath);
  };

  const resolveWiki = (linkpath: string, sourcePath: string): string | null => {
    const hit = resolveWikiStrict(linkpath, sourcePath);
    if (hit !== null) return hit;
    const fb = labnoteFallback(linkpath.trim());
    return fb === null ? null : resolveWikiStrict(fb, sourcePath);
  };

  /** The decoded, NFC-normalised path of a Markdown href (no '#…', no '<>'), or null when it names no file. */
  const mdPath = (href: string): string | null => {
    let h = href.trim();
    if (h.startsWith('<') && h.endsWith('>')) h = h.slice(1, -1).trim();
    if (h === '' || h.startsWith('#')) return null;
    if (/^[a-z][a-z0-9+.-]*:/i.test(h)) return null;
    const hash = h.indexOf('#');
    if (hash >= 0) h = h.slice(0, hash);
    let decoded: string;
    try {
      decoded = decodeURIComponent(h);
    } catch {
      return null;
    }
    decoded = decoded.normalize('NFC');
    if (decoded === '' || decoded.includes('\\')) return null;
    return decoded;
  };

  const resolveDecoded = (decoded: string, sourcePath: string): string | null => {
    const joined = decoded.startsWith('/')
      ? joinPath('', decoded)
      : joinPath(dirOf(sourcePath), decoded);
    if (joined !== null && joined !== '') {
      const hit = exact(joined);
      if (hit !== null) return hit;
    }
    if (!decoded.includes('/')) return byBasename(decoded, sourcePath);
    return null;
  };

  const resolveMdStrict = (href: string, sourcePath: string): string | null => {
    const decoded = mdPath(href);
    return decoded === null ? null : resolveDecoded(decoded, sourcePath);
  };

  const resolveMd = (href: string, sourcePath: string): string | null => {
    const decoded = mdPath(href);
    if (decoded === null) return null;
    const hit = resolveDecoded(decoded, sourcePath);
    if (hit !== null) return hit;
    const fb = labnoteFallback(decoded);
    return fb === null ? null : resolveDecoded(fb, sourcePath);
  };

  const linktextFor = (target: string, sourcePath: string): string | null => {
    const t = byKey.get(linkKey(target));
    if (t === undefined) return null;
    const base = wikiBasename(t);
    if (hasUnlinkableChars(base)) return null;
    const noMd = stripMd(t);
    // D3 candidates: basename, vault path, rooted path, rooted path with its extension.
    for (const c of [base, noMd, `/${noMd}`, `/${t}`]) {
      if (hasUnlinkableChars(c)) continue;
      if (resolveWiki(c, sourcePath) === t) return c;
    }
    return null;
  };

  const isUnknownTarget = (linkpath: string): boolean => {
    const { path } = splitLinktext(linkpath);
    return ATTACHMENT_EXTS.has(extOf(path));
  };

  return {
    files: list,
    has: (path) => byKey.has(linkKey(path)),
    canonical: (path) => byKey.get(linkKey(path)),
    resolveWiki,
    resolveMd,
    resolveWikiStrict,
    resolveMdStrict,
    linktextFor,
    isUnknownTarget,
  };
}
