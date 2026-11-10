// Experiment scope for the AI context builder and its tools (spec §4.1, §13).
// One experiment folder at a time; another only when the user (or the MCP
// arguments) names it. Every path a scoped tool touches goes through
// assertInScope.
import { getExperimentDir } from '@labnoteo/core/lib/labnoteStructure';
import { normalizeVaultPath } from '../../fs/tauriLabnoteFs';
import { pathKey } from '../paths';

/** The experiment folder a request may read, plus other folders the user named explicitly. */
export interface Scope {
  /** Vault-relative experiment folder, `labnote/NNN_X`. */
  folder: string;
  /** True when the folder came from an explicit name or folder rather than the active note. */
  explicit: boolean;
  /** Other experiment folders the user named (see {@link scopeGate}). */
  named: string[];
}

export type ScopeErrorCode = 'noExperiment' | 'unknownExperiment' | 'ambiguousExperiment' | 'outOfScope' | 'scopeRequired';

/**
 * A scope that cannot be resolved or a path outside it. `params`:
 * - `noExperiment`: `[activePath]` (`''` without one);
 * - `unknownExperiment`: `[name]`;
 * - `ambiguousExperiment`: `[name, ...candidateFolders]`;
 * - `outOfScope`: `[attemptedPath, allowedFolder]`;
 * - `scopeRequired`: set by callers that need a scope and got none.
 */
export class ScopeError extends Error {
  constructor(
    readonly code: ScopeErrorCode,
    readonly params: string[] = []
  ) {
    super(params.length ? `${code}: ${params.join(', ')}` : code);
    this.name = 'ScopeError';
  }
}

/** An experiment folder and its README title: the shape of `experimentReadmes()` in `port/experiments.ts`. */
export interface ExperimentRef {
  folder: string;
  title: string;
}

/** Comparison key: NFC, slashes, no `.`/empty segments, lower case. */
function keyOf(path: string): string {
  return pathKey(path.normalize('NFC').replace(/\\/g, '/')).replace(/\/+$/, '');
}

/** A name as typed, for comparison: trimmed, NFC, `/` separators, no trailing `/`, lower case. */
function nameKey(name: string): string {
  return name.trim().normalize('NFC').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function basenameOf(folder: string): string {
  const parts = folder.split('/');
  return parts[parts.length - 1];
}

const TOP_LEVEL_EXPERIMENT = /^labnote\/\d{3}_[^/]+$/;

function uniqueFolders(refs: readonly ExperimentRef[]): ExperimentRef[] {
  const seen = new Set<string>();
  return refs.filter(r => {
    const k = keyOf(r.folder);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function pickOne(name: string, matches: readonly ExperimentRef[]): ExperimentRef {
  const found = uniqueFolders(matches);
  if (found.length === 0) throw new ScopeError('unknownExperiment', [name]);
  if (found.length > 1) throw new ScopeError('ambiguousExperiment', [name, ...found.map(r => r.folder)]);
  return found[0];
}

/**
 * The experiment `name` means: its `NNN`, its folder name (`001_A`), its
 * folder path (`labnote/001_A`) or its README title. Case-insensitive and
 * NFC-normalised. Throws `unknownExperiment` or `ambiguousExperiment`.
 */
export function findExperiment(name: string, experiments: readonly ExperimentRef[]): ExperimentRef {
  const wanted = nameKey(name);
  if (!wanted) throw new ScopeError('unknownExperiment', [name]);
  if (/^\d{3}$/.test(wanted)) {
    return pickOne(
      name,
      experiments.filter(e => nameKey(basenameOf(e.folder)).startsWith(`${wanted}_`))
    );
  }
  return pickOne(
    name,
    experiments.filter(
      e => keyOf(e.folder) === wanted || nameKey(basenameOf(e.folder)) === wanted || nameKey(e.title) === wanted
    )
  );
}

function findFolder(folder: string, experiments: readonly ExperimentRef[]): ExperimentRef {
  let wanted: string;
  try {
    wanted = keyOf(normalizeVaultPath(folder.replace(/\\/g, '/')));
  } catch {
    throw new ScopeError('unknownExperiment', [folder]);
  }
  return pickOne(
    folder,
    experiments.filter(e => keyOf(e.folder) === wanted)
  );
}

/**
 * The scope of a request (spec §4.1). An explicit `folder` or `experiment`
 * wins over the active note; both given must agree. Without them the active
 * note's `labnote/NNN_*` folder is used; there is no guessing beyond that.
 * `named` starts empty: callers add folders the user named.
 */
export function resolveScope(
  input: { activePath?: string; folder?: string; experiment?: string },
  experiments: readonly ExperimentRef[]
): Scope {
  const byFolder = input.folder?.trim() ? findFolder(input.folder, experiments) : undefined;
  const byName = input.experiment?.trim() ? findExperiment(input.experiment, experiments) : undefined;
  if (byFolder && byName && keyOf(byFolder.folder) !== keyOf(byName.folder)) {
    throw new ScopeError('ambiguousExperiment', [input.experiment ?? '', byFolder.folder, byName.folder]);
  }
  const chosen = byFolder ?? byName;
  if (chosen) return { folder: chosen.folder, explicit: true, named: [] };

  const active = input.activePath ?? '';
  let dir: string | undefined;
  try {
    dir = getExperimentDir(normalizeVaultPath(active.normalize('NFC')));
  } catch {
    dir = undefined;
  }
  if (!active || !dir || !TOP_LEVEL_EXPERIMENT.test(dir)) throw new ScopeError('noExperiment', [active]);
  const listed = experiments.find(e => keyOf(e.folder) === keyOf(dir));
  return { folder: listed ? listed.folder : dir, explicit: false, named: [] };
}

/**
 * `path` normalised (`/` separators, no `.` or empty segments), when it is a
 * `.md` note inside `scope.folder` or one of `scope.named`. Rejects `..`,
 * absolute and drive paths, `:` (drive letters and NTFS streams),
 * dot-folders and non-`.md` files. Folders are compared with a trailing `/`,
 * case-insensitively and NFC-normalised, so `labnote/001_A` never admits
 * `labnote/001_AB/...`. Otherwise throws `outOfScope` with
 * `[path, scope.folder]`.
 */
export function assertInScope(scope: Scope, path: string): string {
  const fail = (): ScopeError => new ScopeError('outOfScope', [path, scope.folder]);
  if (!path || /[\0:]/.test(path)) throw fail();
  const slashed = path.replace(/\\/g, '/');
  if (slashed.startsWith('/')) throw fail();
  let normalised: string;
  try {
    normalised = normalizeVaultPath(slashed);
  } catch {
    throw fail();
  }
  if (!normalised || normalised.split('/').some(s => s.startsWith('.'))) throw fail();
  if (!/\.md$/i.test(normalised)) throw fail();
  const key = keyOf(normalised);
  for (const folder of [scope.folder, ...scope.named]) {
    const folderKey = keyOf(folder);
    if (folderKey && key.startsWith(`${folderKey}/`)) return normalised;
  }
  throw fail();
}

const WORD_CHAR = /[\p{L}\p{N}\p{M}_]/u;
const ASCII_WORD_CHAR = /[A-Za-z0-9_]/;

/**
 * An experiment number in prose: three digits not inside a longer number, a
 * decimal, a version, an ID (`DNA-002`) or a folder name (`002_X`, matched by name).
 */
const NUMBER_RE = /(?<![\p{L}\p{N}\p{M}_.\-])(\d{3})(?![\p{N}_])(?![.,]\d)/gu;

interface Mention {
  start: number;
  end: number;
  folder: string;
}

/** Occurrences of `needle` in `text` that are whole words where the needle starts or ends with an ASCII word character. */
function occurrences(text: string, needle: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  if (!needle) return out;
  const checkStart = ASCII_WORD_CHAR.test(needle[0]);
  const checkEnd = ASCII_WORD_CHAR.test(needle[needle.length - 1]);
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + 1)) {
    const end = i + needle.length;
    if (checkStart && i > 0 && WORD_CHAR.test(text[i - 1])) continue;
    if (checkEnd && end < text.length && WORD_CHAR.test(text[end])) continue;
    out.push([i, end]);
  }
  return out;
}

/** A title long enough to name an experiment in prose: 3+ characters, or 2+ with a non-ASCII one (Korean). */
function usableTitle(title: string): boolean {
  const chars = [...title];
  return chars.length >= 3 || (chars.length >= 2 && /[^\x00-\x7f]/.test(title));
}

/**
 * The experiment folders `userText` names (spec §9, §13): by `NNN` (only when
 * one folder has that number), by folder name or by README title,
 * case-insensitively and NFC-normalised. A match inside a longer match is
 * dropped, so "Alpha Beta" names only that experiment and not "Alpha".
 */
export function scopeGate(userText: string, experiments: readonly ExperimentRef[]): Set<string> {
  const text = userText.normalize('NFC').toLowerCase();
  const mentions: Mention[] = [];
  for (const m of text.matchAll(NUMBER_RE)) {
    const owners = uniqueFolders(experiments.filter(e => nameKey(basenameOf(e.folder)).startsWith(`${m[1]}_`)));
    if (owners.length === 1) mentions.push({ start: m.index ?? 0, end: (m.index ?? 0) + 3, folder: owners[0].folder });
  }
  for (const e of experiments) {
    for (const [start, end] of occurrences(text, nameKey(basenameOf(e.folder)))) mentions.push({ start, end, folder: e.folder });
    const title = nameKey(e.title);
    if (usableTitle(title)) for (const [start, end] of occurrences(text, title)) mentions.push({ start, end, folder: e.folder });
  }
  const kept = mentions.filter(
    m => !mentions.some(o => o !== m && o.start <= m.start && o.end >= m.end && o.end - o.start > m.end - m.start)
  );
  return new Set(kept.map(m => m.folder));
}
