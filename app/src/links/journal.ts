/**
 * The link-update journal (plan SP4 Task 24, decision D15): what a rename with link updates planned and did, kept
 * outside the vault (`journalIpc.ts`) so a crash can be finished and the last rename undone.
 * - The header is small and rewritten only when its status (or `undoable`) changes.
 * - Each planned note has its own record file, written once at `'writing'` and once at the end.
 * - Above `JOURNAL_TEXT_CAP` (the before and after texts summed over the records) later records drop their texts
 *   and the header becomes `undoable:false`. Retry and recovery still work: they re-plan from the moves.
 */
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { clearLinkJournal, readLinkJournal, writeLinkJournalHeader, writeLinkJournalNote } from './journalIpc';
import { linkKey } from './resolve';
import { applyMoves, invertMoves, type Move } from './rewrite';
import type { RenamePlan } from './planRename';
import type { FailReason } from './renameWithLinks';

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

export const JOURNAL_TEXT_CAP = 32 * 1024 * 1024;

export interface JournalHeader {
  id: string;
  from: string;
  to: string;
  isDir: boolean;
  moves: Move[];
  status: 'planned' | 'renamed' | 'done';
  planned: { before: string; after: string }[];
  undoable: boolean;
}

/** `path` is the post-rename path. */
export interface JournalNote {
  n: number;
  path: string;
  before?: string;
  after?: string;
  status: 'writing' | 'ok' | 'failed';
  reason?: FailReason;
}

export interface LinkJournal {
  header: JournalHeader;
  notes: JournalNote[];
}

export interface JournalStore {
  load(): Promise<LinkJournal | null>;
  /** Clears, then writes the header. */
  begin(header: JournalHeader): Promise<void>;
  setStatus(status: JournalHeader['status']): Promise<void>;
  /** One record file; above the cap the texts are dropped and the header becomes undoable:false. */
  note(rec: JournalNote): Promise<void>;
  clear(): Promise<void>;
  current(): LinkJournal | null;
}

const textSize = (rec: JournalNote): number => (rec.before?.length ?? 0) + (rec.after?.length ?? 0);

/** The record as written: only the defined fields, in a fixed order. */
function cleanRecord(rec: JournalNote): JournalNote {
  // Built in this key order so the record files read n, path, texts, status, reason.
  const out = { n: rec.n, path: rec.path } as JournalNote;
  if (rec.before !== undefined) out.before = rec.before;
  if (rec.after !== undefined) out.after = rec.after;
  out.status = rec.status;
  if (rec.reason !== undefined) out.reason = rec.reason;
  return out;
}

export function createJournalStore(invoke: InvokeFn = tauriInvoke): JournalStore {
  let cur: LinkJournal | null = null;
  /** n -> characters of text that record holds now (a rewritten record replaces its own share). */
  let sizes = new Map<number, number>();
  const total = () => [...sizes.values()].reduce((a, b) => a + b, 0);

  const writeHeader = async () => {
    if (cur) await writeLinkJournalHeader(JSON.stringify(cur.header), invoke);
  };

  return {
    async load() {
      const files = await readLinkJournal(invoke);
      if (!files) {
        cur = null;
        sizes = new Map();
        return null;
      }
      const header = JSON.parse(files.header) as JournalHeader;
      const notes = files.notes.map((s) => JSON.parse(s) as JournalNote).sort((a, b) => a.n - b.n);
      cur = { header, notes };
      sizes = new Map(notes.map((r) => [r.n, textSize(r)]));
      return { header: { ...header }, notes: [...notes] };
    },
    async begin(header) {
      await clearLinkJournal(invoke);
      cur = { header: { ...header }, notes: [] };
      sizes = new Map();
      await writeHeader();
    },
    async setStatus(status) {
      if (!cur || cur.header.status === status) return;
      cur.header = { ...cur.header, status };
      await writeHeader();
    },
    async note(rec) {
      if (!cur) throw new Error('the link journal has no header');
      let out = cleanRecord(rec);
      const others = total() - (sizes.get(rec.n) ?? 0);
      if (!cur.header.undoable || others + textSize(out) > JOURNAL_TEXT_CAP) {
        out = cleanRecord({ n: rec.n, path: rec.path, status: rec.status, reason: rec.reason });
        if (cur.header.undoable) {
          cur.header = { ...cur.header, undoable: false };
          await writeHeader();
        }
      }
      sizes.set(out.n, textSize(out));
      await writeLinkJournalNote(out.n, JSON.stringify(out), invoke);
      const i = cur.notes.findIndex((r) => r.n === out.n);
      if (i >= 0) cur.notes[i] = out;
      else cur.notes.push(out);
      cur.notes.sort((a, b) => a.n - b.n);
    },
    async clear() {
      cur = null;
      sizes = new Map();
      await clearLinkJournal(invoke);
    },
    current() {
      return cur;
    },
  };
}

/** The store the App context and the app commands share. */
export const linkJournal: JournalStore = createJournalStore();

/**
 * The plan a journal describes, against the files as they are now. Once the rename happened (`'renamed'` or
 * `'done'`), the before-universe is the current one with the inverse moves applied.
 */
export function planFromJournal(j: LinkJournal, currentFiles: readonly string[]): RenamePlan {
  const { header } = j;
  const files = header.status === 'planned' ? [...currentFiles] : applyMoves(currentFiles, invertMoves(header.moves));
  return {
    from: header.from,
    to: header.to,
    isDir: header.isDir,
    caseOnly: linkKey(header.from) === linkKey(header.to),
    moves: header.moves.map((m) => ({ ...m })),
    files,
    notes: header.planned.map((p) => ({ before: p.before, after: p.after, changed: 0, unsafe: 0 })),
    linkCount: 0,
    hasWikiRewrites: false,
  };
}
