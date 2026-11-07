/**
 * The rename planner (plan SP4 Task 23, decisions D11, D12): computes every link edit a rename needs before
 * anything is written.
 * - It never plans on an index that is not ready (`IndexNotReadyError`), so no caller can mistake a partial index
 *   for "no links".
 * - Candidates are the backlink sources of every moved path, the hijack candidates (notes linking a moved file's
 *   new basename), the moved notes, the active note and the FTS hits for the old name. Each is read fresh and run
 *   through the pure `rewriteLinks`, so an extra candidate costs one read and changes nothing.
 * - The plan runs before the rename: every candidate is read at its old path; `after` is where it will be.
 */
import { hasErrorKind } from '../fs/errorKinds';
import { LinkIndex } from './linkIndex';
import { MENTION_LIMIT, MENTION_MIN } from './mentions';
import { basenameKey, linkKey, stripLabnote } from './resolve';
import { movesFor, rewriteContext, rewriteLinksDetailed, type Move } from './rewrite';

export class IndexNotReadyError extends Error {
  constructor() {
    super('The link index is not ready');
    this.name = 'IndexNotReadyError';
  }
}

export interface PlannedNote {
  before: string;
  after: string;
  changed: number;
  unsafe: number;
}

export interface RenamePlan {
  from: string;
  to: string;
  isDir: boolean;
  caseOnly: boolean;
  moves: Move[];
  /** The before-universe the plan was computed against. */
  files: string[];
  /** Notes with at least one changed or unsafe link, sorted by key. */
  notes: PlannedNote[];
  /** Links to change, summed over the notes. */
  linkCount: number;
  /** Some wikilink or embed is changed or unsafe (D11: a name no wikilink can express refuses the rename). */
  hasWikiRewrites: boolean;
}

export interface PlanArgs {
  from: string;
  to: string;
  isDir: boolean;
  index: LinkIndex;
  images(): Promise<string[]>;
  /** Raw text; host.fs.read returns the buffer for an open note. */
  read(path: string): Promise<string>;
  /** The safety net (D12). */
  search?(q: string, limit: number): Promise<{ hits: { path: string }[] }>;
  activePath?: string;
  /** The before-universe; default index.files() with images() merged in. */
  files?: readonly string[];
}

const cmpKey = (a: string, b: string): number => {
  const ka = linkKey(a);
  const kb = linkKey(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
};

const isNote = (p: string): boolean => /\.md$/i.test(p);

/** Adds `paths` to `into` (keyed by linkKey), keeping the first spelling seen. */
function addAll(into: Map<string, string>, paths: Iterable<string>): void {
  for (const p of paths) {
    const k = linkKey(p);
    if (!into.has(k)) into.set(k, p);
  }
}

/**
 * Backlink sources of every moved path, the notes linking `basenameKey(m.to)` (and, for a `.labnote.md`, its short
 * name) for every move, and the moved notes, sorted by key.
 */
export function candidates(index: LinkIndex, moves: readonly Move[]): string[] {
  const out = new Map<string, string>();
  for (const m of moves) {
    addAll(out, index.backlinks(m.from).map((b) => b.source));
    const key = basenameKey(m.to);
    addAll(out, index.sourcesLinkingBasename(key));
    // The `.labnote` fallback (resolve.ts): `[[y]]` can name y.labnote.md, so a new y.labnote.md may take it over too.
    const short = stripLabnote(key);
    if (short !== key) addAll(out, index.sourcesLinkingBasename(short));
    if (isNote(m.from)) addAll(out, [m.from]);
  }
  return [...out.values()].sort(cmpKey);
}

/** The name the safety-net search looks for: the last segment without `.labnote.md` or `.md`. */
function searchName(path: string): string {
  const seg = path.replace(/\/+$/, '').split('/').pop() ?? '';
  return seg.replace(/\.labnote\.md$/i, '').replace(/\.md$/i, '');
}

export async function planRename(args: PlanArgs): Promise<RenamePlan> {
  const { from, to, isDir, index } = args;
  if (!index.ready()) throw new IndexNotReadyError();
  await index.settled();
  // A rebuild may have started while the queue drained: never plan on what is left of the old index.
  if (!index.ready()) throw new IndexNotReadyError();

  let files: string[];
  if (args.files) {
    files = [...args.files];
  } else {
    const all = new Map<string, string>();
    addAll(all, index.files());
    addAll(all, await args.images());
    files = [...all.values()];
  }
  const moves = movesFor(from, to, isDir, files);
  const caseOnly = linkKey(from) === linkKey(to);
  const plan: RenamePlan = { from, to, isDir, caseOnly, moves, files, notes: [], linkCount: 0, hasWikiRewrites: false };
  if (caseOnly) return plan; // same key: every link still resolves (D11)

  const sources = new Map<string, string>();
  addAll(sources, candidates(index, moves));
  if (args.activePath !== undefined && isNote(args.activePath)) addAll(sources, [args.activePath]);
  const name = searchName(from);
  if (args.search && [...name].length >= MENTION_MIN) {
    try {
      const r = await args.search(name, MENTION_LIMIT);
      addAll(sources, r.hits.map((h) => h.path).filter(isNote));
    } catch {
      // The search is only a safety net over the backlinks; a failed search adds no candidates.
    }
  }

  const ctx = rewriteContext(files, moves);
  for (const before of [...sources.values()].sort(cmpKey)) {
    let raw: string;
    try {
      raw = await args.read(before);
    } catch (e) {
      if (hasErrorKind(e, 'notFound')) continue; // deleted since it was indexed: nothing to rewrite
      throw e;
    }
    const after = ctx.moved(before) ?? before;
    const r = rewriteLinksDetailed(raw, before, after, ctx);
    if (r.changed === 0 && r.unsafe === 0) continue;
    plan.notes.push({ before, after, changed: r.changed, unsafe: r.unsafe });
    plan.linkCount += r.changed;
    if (r.wiki > 0) plan.hasWikiRewrites = true;
  }
  return plan;
}
