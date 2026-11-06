/**
 * The in-memory link index (plan SP4 Task 5, decisions D1 and D12).
 * Holds every note's extracted links, an editor-buffer overlay per open note, and a reverse
 * (backlink) map. Resolution depends only on the file universe, so the resolver and the reverse
 * map follow `filesVersion`; text changes (`setNote`, `setOverlay`) bump `linksVersion` and update
 * the reverse map for that one source.
 */
import { extractLinks, extractMeta, hasLinkSyntax, type ExtractedLink, type NoteMeta } from './extract';
import { basenameKey, createResolver, linkKey, splitLinktext, type Resolver } from './resolve';

export interface Backlink {
  source: string;
  links: ExtractedLink[];
}

/** `target` null = unresolved; `unknown` = an attachment the app does not list (D1). */
export interface ResolvedLink {
  link: ExtractedLink;
  target: string | null;
  unknown: boolean;
}

interface NoteEntry {
  path: string;
  links: ExtractedLink[];
  meta: NoteMeta;
}

/** What one source contributed to the reverse map. */
interface Contribution {
  resolved: ResolvedLink[];
  targets: Set<string>;
}

const BOM = '﻿';

function cmpKey(a: string, b: string): number {
  const ka = linkKey(a);
  const kb = linkKey(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

/** The path a link names: the wiki path before '#', or the decoded Markdown href before '#'. */
function linkPathOf(link: ExtractedLink): string {
  if (link.kind === 'wiki' || link.kind === 'embed') return splitLinktext(link.target).path;
  const hash = link.target.indexOf('#');
  const raw = hash < 0 ? link.target : link.target.slice(0, hash);
  try {
    return decodeURIComponent(raw).trim().normalize('NFC');
  } catch {
    return raw.trim().normalize('NFC');
  }
}

/** Links (skipped when the prefilter says there are none) and front-matter meta. */
function parseNote(path: string, text: string): NoteEntry {
  const links = hasLinkSyntax(text) ? extractLinks(text) : [];
  const body = text.startsWith(BOM) ? text.slice(1) : text;
  const meta: NoteMeta = body.startsWith('---') ? extractMeta(text) : { aliases: [] };
  return { path, links, meta };
}

function underKey(key: string, prefix: string): boolean {
  return key === prefix || key.startsWith(`${prefix}/`);
}

export class LinkIndex {
  private _filesVersion = 0;
  private _linksVersion = 0;
  private fileList: string[] = [];
  private fileKeys = new Set<string>();
  /** Keyed by linkKey(path). */
  private notes = new Map<string, NoteEntry>();
  private overlays = new Map<string, NoteEntry>();
  private memoResolver: { version: number; resolver: Resolver } | null = null;

  /** target key -> source key -> links. */
  private reverse = new Map<string, Map<string, ExtractedLink[]>>();
  /** source key -> what it contributed to `reverse`. */
  private forward = new Map<string, Contribution>();
  /** The filesVersion the reverse map was built for; -1 = stale, rebuilt in full on the next read. */
  private reverseVersion = -1;
  /** basename key (D12) -> source keys, kept per source. */
  private byBasename = new Map<string, Set<string>>();
  private basenamesOf = new Map<string, Set<string>>();

  private isReady = false;
  private readyResolve: (() => void) | null = null;
  private readyPromise: Promise<void>;
  private listeners = new Set<() => void>();
  private notifyQueued = false;
  private pending = new Set<Promise<unknown>>();

  constructor() {
    this.readyPromise = this.newReadyPromise();
  }

  /** Bumps on setFiles, addFiles, removeTree and clear. */
  get filesVersion(): number {
    return this._filesVersion;
  }

  /** Bumps on setNote and setOverlay (and clear). */
  get linksVersion(): number {
    return this._linksVersion;
  }

  private newReadyPromise(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.readyResolve = resolve;
    });
  }

  ready(): boolean {
    return this.isReady;
  }

  markReady(): void {
    if (this.isReady) return;
    this.isReady = true;
    this.readyResolve?.();
    this.readyResolve = null;
    this.notify();
  }

  /** Resolves at markReady(); after clear() a new pending promise (an unresolved one is kept for its waiters). */
  whenReady(): Promise<void> {
    return this.readyPromise;
  }

  // ---- the file universe ----

  /** The whole universe (notes and images). */
  setFiles(files: readonly string[]): void {
    this.fileList = [];
    this.fileKeys.clear();
    this.pushFiles(files);
    this.filesChanged();
  }

  addFiles(paths: readonly string[]): void {
    if (this.pushFiles(paths)) this.filesChanged();
  }

  /** A file or a folder prefix: drops the files, notes and overlays under it. */
  removeTree(path: string): void {
    const prefix = linkKey(path.replace(/\/+$/, ''));
    if (prefix === '') return;
    let changed = false;
    const kept = this.fileList.filter((f) => !underKey(linkKey(f), prefix));
    if (kept.length !== this.fileList.length) {
      this.fileList = kept;
      this.fileKeys = new Set(kept.map(linkKey));
      changed = true;
    }
    for (const map of [this.notes, this.overlays]) {
      for (const key of [...map.keys()]) {
        if (!underKey(key, prefix)) continue;
        map.delete(key);
        changed = true;
      }
    }
    if (changed) {
      for (const key of [...this.basenamesOf.keys()]) if (underKey(key, prefix)) this.dropBasenames(key);
      this.filesChanged();
    }
  }

  files(): readonly string[] {
    return this.fileList;
  }

  /** Memoised per filesVersion. */
  resolver(): Resolver {
    if (this.memoResolver === null || this.memoResolver.version !== this._filesVersion) {
      this.memoResolver = { version: this._filesVersion, resolver: createResolver(this.fileList) };
    }
    return this.memoResolver.resolver;
  }

  private pushFiles(paths: readonly string[]): boolean {
    let added = false;
    for (const p of paths) {
      const k = linkKey(p);
      if (this.fileKeys.has(k)) continue;
      this.fileKeys.add(k);
      this.fileList.push(p);
      added = true;
    }
    return added;
  }

  private filesChanged(): void {
    this._filesVersion++;
    this.reverseVersion = -1;
    this.notify();
  }

  // ---- note text ----

  /** `text` is editor text (`parseRaw`'d by the caller). */
  setNote(path: string, text: string): void {
    const key = linkKey(path);
    this.notes.set(key, parseNote(path, text));
    this.sourceChanged(key);
  }

  /** The open editor's buffer; wins over `setNote` while set. `null` falls back to the disk text. */
  setOverlay(path: string, text: string | null): void {
    const key = linkKey(path);
    if (text === null) {
      if (!this.overlays.delete(key)) return;
    } else {
      this.overlays.set(key, parseNote(path, text));
    }
    this.sourceChanged(key);
  }

  private entry(key: string): NoteEntry | undefined {
    return this.overlays.get(key) ?? this.notes.get(key);
  }

  private sourceChanged(key: string): void {
    this._linksVersion++;
    this.updateBasenames(key);
    if (this.reverseVersion === this._filesVersion) {
      this.dropContribution(key);
      this.addContribution(key);
    }
    this.notify();
  }

  links(path: string): ExtractedLink[] {
    return this.entry(linkKey(path))?.links ?? [];
  }

  resolved(path: string): ResolvedLink[] {
    this.ensureReverse();
    return this.forward.get(linkKey(path))?.resolved ?? [];
  }

  aliases(): readonly { path: string; alias: string }[] {
    const out: { path: string; alias: string }[] = [];
    for (const key of this.sourceKeys()) {
      const e = this.entry(key);
      if (!e) continue;
      for (const alias of e.meta.aliases) out.push({ path: e.path, alias });
    }
    return out;
  }

  /** The front-matter title of a `.labnote.md` note. */
  title(path: string): string | undefined {
    if (!/\.labnote\.md$/i.test(path)) return undefined;
    return this.entry(linkKey(path))?.meta.title;
  }

  /** Sources sorted by key; self links excluded. */
  backlinks(target: string): Backlink[] {
    this.ensureReverse();
    const tk = linkKey(target);
    const sources = this.reverse.get(tk);
    if (!sources) return [];
    const out: Backlink[] = [];
    for (const [sk, links] of sources) {
      if (sk === tk) continue;
      out.push({ source: this.displayPath(sk), links });
    }
    return out.sort((a, b) => cmpKey(a.source, b.source));
  }

  /** Notes holding a link whose basename key (D12) equals `key`, sorted by key. */
  sourcesLinkingBasename(key: string): string[] {
    const set = this.byBasename.get(key);
    if (!set) return [];
    return [...set].map((k) => this.displayPath(k)).sort(cmpKey);
  }

  // ---- reverse map ----

  private sourceKeys(): Set<string> {
    return new Set([...this.notes.keys(), ...this.overlays.keys()]);
  }

  private displayPath(key: string): string {
    return this.entry(key)?.path ?? key;
  }

  private ensureReverse(): void {
    if (this.reverseVersion === this._filesVersion) return;
    this.reverse.clear();
    this.forward.clear();
    this.reverseVersion = this._filesVersion;
    for (const key of this.sourceKeys()) this.addContribution(key);
  }

  private addContribution(key: string): void {
    const e = this.entry(key);
    if (!e) return;
    const r = this.resolver();
    const resolved: ResolvedLink[] = [];
    const targets = new Set<string>();
    for (const link of e.links) {
      const wiki = link.kind === 'wiki' || link.kind === 'embed';
      const target = wiki
        ? r.resolveWiki(splitLinktext(link.target).path, e.path)
        : r.resolveMd(link.target, e.path);
      const unknown = target === null && r.isUnknownTarget(linkPathOf(link));
      resolved.push({ link, target, unknown });
      if (target === null) continue;
      const tk = linkKey(target);
      targets.add(tk);
      let sources = this.reverse.get(tk);
      if (!sources) {
        sources = new Map();
        this.reverse.set(tk, sources);
      }
      const list = sources.get(key);
      if (list) list.push(link);
      else sources.set(key, [link]);
    }
    this.forward.set(key, { resolved, targets });
  }

  private dropContribution(key: string): void {
    const prev = this.forward.get(key);
    if (!prev) return;
    for (const tk of prev.targets) {
      const sources = this.reverse.get(tk);
      if (!sources) continue;
      sources.delete(key);
      if (sources.size === 0) this.reverse.delete(tk);
    }
    this.forward.delete(key);
  }

  private dropBasenames(key: string): void {
    const prev = this.basenamesOf.get(key);
    if (!prev) return;
    for (const b of prev) {
      const set = this.byBasename.get(b);
      if (!set) continue;
      set.delete(key);
      if (set.size === 0) this.byBasename.delete(b);
    }
    this.basenamesOf.delete(key);
  }

  private updateBasenames(key: string): void {
    this.dropBasenames(key);
    const e = this.entry(key);
    if (!e || e.links.length === 0) return;
    const keys = new Set<string>();
    for (const link of e.links) {
      const p = linkPathOf(link);
      if (p !== '') keys.add(basenameKey(p));
    }
    if (keys.size === 0) return;
    for (const b of keys) {
      let set = this.byBasename.get(b);
      if (!set) {
        set = new Set();
        this.byBasename.set(b, set);
      }
      set.add(key);
    }
    this.basenamesOf.set(key, keys);
  }

  // ---- notifications and async work ----

  /** Coalesced: at most one call per microtask. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private notify(): void {
    if (this.notifyQueued) return;
    this.notifyQueued = true;
    queueMicrotask(() => {
      this.notifyQueued = false;
      for (const fn of [...this.listeners]) {
        try {
          fn();
        } catch (e) {
          console.error('[linkIndex] listener failed', e);
        }
      }
    });
  }

  /** Registers `p` with settled(). */
  track<T>(p: Promise<T>): Promise<T> {
    this.pending.add(p);
    const done = (): void => {
      this.pending.delete(p);
    };
    p.then(done, done);
    return p;
  }

  /** Resolves when no tracked async work is pending (work tracked meanwhile is waited for too). */
  async settled(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending]);
    }
  }

  clear(): void {
    this.fileList = [];
    this.fileKeys.clear();
    this.notes.clear();
    this.overlays.clear();
    this.reverse.clear();
    this.forward.clear();
    this.byBasename.clear();
    this.basenamesOf.clear();
    this.memoResolver = null;
    this._filesVersion++;
    this._linksVersion++;
    this.reverseVersion = -1;
    if (this.isReady) {
      this.isReady = false;
      this.readyPromise = this.newReadyPromise();
    }
    this.notify();
  }
}

export const linkIndex = new LinkIndex();
