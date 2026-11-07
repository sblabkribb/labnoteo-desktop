// Ported from app/vendor/labnoteo/src/sampleIdIndex.ts:13-194 sha256:46ae174b880183b1
// labnoteO 0.138.0, Apache-2.0.
// Changes: none (imports only).
/**
 * The sample IDs each lab note can resolve, for marking a reference to a
 * sample the registry does not have (#210): one deleted, moved away, or
 * typed by hand without registering it.
 *
 * A note sees its own Local folder and the Global one ({@link
 * noteLabsamplesFolder}): their `{Type}.json` registries and, for catalog
 * types, the `{Type}_*.json` product catalogs, whose references the sample
 * sync registers only on save. Only `*.labnote.md` notes are covered, since
 * the sync runs for them alone; elsewhere an ID is never registered from the
 * note, and the installed guides quote example IDs.
 */
import type { LabnoteFs } from '@labnoteo/core';
import {
  isSameSampleFolder,
  loadReferenceIdsByFolder,
  loadSampleMarks,
  noteLabsamplesFolder,
  type SampleMark,
} from '@labnoteo/core/lib/sampleStorage';
import * as posix from '@labnoteo/core/posix';

const LABNOTE_SUFFIX = '.labnote.md';

/** The IDs a note can resolve, lower-cased. */
export interface KnownSampleIds {
  ids: ReadonlySet<string>;
  /**
   * Registry aliases by lower-cased ID ('' without one), the Local registry's
   * first (#239). Catalog products are not in it.
   */
  aliases: ReadonlyMap<string, string>;
  /**
   * Discard dates by lower-cased ID, from the same registry as the alias: a
   * Local record in use hides a discarded Global one (#330).
   */
  discarded: ReadonlyMap<string, string>;
  /** Changes whenever `ids` may have. */
  version: number;
}

/** A folder's registry IDs with their aliases and discard dates, and its catalog IDs. */
interface FolderSamples {
  marks: ReadonlyMap<string, SampleMark>;
  catalog: ReadonlySet<string>;
}

export interface SampleIdIndexOptions {
  globalFolder: () => string;
  types: () => readonly string[];
  /** Runs after registries were (re)read. */
  onChange: () => void;
  /** How long changes are gathered before the registries are read again. */
  delayMs?: number;
}

export class SampleIdIndex {
  /** Folder → its samples, or null when one of its registries could not be read. */
  private readonly folders = new Map<string, FolderSamples | null>();
  private readonly loading = new Set<string>();
  private readonly stale = new Set<string>();
  private readonly cache = new Map<string, KnownSampleIds>();
  private version = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly fs: LabnoteFs,
    private readonly opts: SampleIdIndexOptions
  ) {}

  /**
   * The IDs `path` can resolve. Called on every editor update, so it only
   * looks things up: a folder not read yet starts reading and the answer is
   * undefined until it is, as it is when a registry cannot be read. Either
   * way nothing is marked missing.
   */
  knownFor(path: string | undefined): KnownSampleIds | undefined {
    if (!path?.endsWith(LABNOTE_SUFFIX)) return undefined;
    const folders = this.foldersOf(path);
    let ready = true;
    for (const folder of folders) {
      if (!this.folders.has(folder)) {
        void this.load(folder);
        ready = false;
      } else if (this.folders.get(folder) === null) {
        return undefined;
      }
    }
    if (!ready) return undefined;
    const key = folders.join('\u0000');
    const cached = this.cache.get(key);
    if (cached?.version === this.version) return cached;
    const ids = new Set<string>();
    const aliases = new Map<string, string>();
    const discarded = new Map<string, string>();
    for (const folder of folders) {
      const samples = this.folders.get(folder);
      if (!samples) continue;
      for (const [id, mark] of samples.marks) {
        ids.add(id);
        if (aliases.has(id)) continue;
        aliases.set(id, mark.alias);
        if (mark.discarded) discarded.set(id, mark.discarded);
      }
      for (const id of samples.catalog) ids.add(id);
    }
    const entry = { ids, aliases, discarded, version: this.version };
    this.cache.set(key, entry);
    return entry;
  }

  /** Read every registry again soon: samples were written, or the settings changed. */
  invalidate(): void {
    for (const folder of this.folders.keys()) this.stale.add(folder);
    this.schedule();
  }

  /** A vault file changed; registries of a folder already read are read again soon. */
  fileChanged(path: string): void {
    if (!path.toLowerCase().endsWith('.json')) return;
    const dir = posix.dirname(path);
    for (const folder of this.folders.keys()) {
      if (isSameSampleFolder(folder, dir)) this.stale.add(folder);
    }
    if (this.stale.size > 0) this.schedule();
  }

  private foldersOf(path: string): string[] {
    const global = this.opts.globalFolder();
    const local = noteLabsamplesFolder(path, global);
    return !global || isSameSampleFolder(local, global) ? [local] : [local, global];
  }

  private schedule(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.reloadStale();
    }, this.opts.delayMs ?? 200);
  }

  private async reloadStale(): Promise<void> {
    const folders = [...this.stale].filter(f => !this.loading.has(f));
    if (folders.length === 0) return;
    for (const f of folders) this.stale.delete(f);
    await Promise.all(folders.map(f => this.read(f)));
    this.bump();
  }

  private async load(folder: string): Promise<void> {
    if (this.loading.has(folder)) return;
    await this.read(folder);
    this.bump();
  }

  private async read(folder: string): Promise<void> {
    this.loading.add(folder);
    try {
      const marks = new Map<string, SampleMark>();
      const catalog = new Set<string>();
      const types = this.opts.types();
      let readable = true;
      for (const type of types) {
        const own = await loadSampleMarks(this.fs, folder, type);
        if (!own) {
          readable = false;
          break;
        }
        for (const [id, mark] of own) marks.set(id, mark);
      }
      if (readable) {
        // One directory listing for every type: any type may have a catalog
        // now, and this runs on each refresh.
        for (const ids of (await loadReferenceIdsByFolder(this.fs, folder, types)).values()) {
          for (const id of ids) catalog.add(id.toLowerCase());
        }
      }
      this.folders.set(folder, readable ? { marks, catalog } : null);
    } catch (err) {
      console.warn('[labnoteo] reading sample IDs failed:', err);
      // Not retried on every keystroke; the next sample write reads it again.
      this.folders.set(folder, null);
    } finally {
      this.loading.delete(folder);
    }
    // Changed while it was being read: read it once more.
    if (this.stale.has(folder)) this.schedule();
  }

  private bump(): void {
    this.version++;
    this.opts.onChange();
  }
}
