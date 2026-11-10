// Ported from app/vendor/labnoteo/src/lastUpdatedTracker.ts:1-109 sha256:d5f272f95deef5ed
// Ported from app/vendor/labnoteo/src/lastUpdatedStamp.ts:22-32 sha256:9e7731b9bfb70fdb
// Ported from app/vendor/labnoteo/src/unitOpReorderFilter.ts:33-117 sha256:c05e01d2bebc276b
// Ported from app/vendor/labnoteo/src/unitOpReorderFilter.ts:120-186 sha256:590911ec16ecfc27
// Ported from app/vendor/labnoteo/src/main.ts:2653-2670 sha256:cce7725341955e97
// Ported from app/vendor/labnoteo/src/main.ts:2707-2758 sha256:492d19325690832d
// Ported from app/vendor/labnoteo/src/main.ts:2627-2639 sha256:92b4005177071fe0
// labnoteO 0.140.2, Apache-2.0.
// Changes: one file for the writing upkeep (UI redesign Task 20). LastUpdatedTracker is the vendor class unchanged. isLabNotePath and experimentReadmeOf are the vendor helpers. classifyChange is the vendor classify() of unitOpReorderFilter: a user edit is a transaction whose userEvent is input.*, delete.* or move.* (the app's checkbox tick is 'input.toggle', so the vendor's isTaskToggle shape test is dropped); undo/redo is fromHistory; and an edit made by an app command ('input.labnote', which may set the date itself, as readmeStamp does) counts as a user edit but never as a date set by hand. stampLastUpdated (vendor plugin.stampLastUpdated) and LastUpdatedScheduler (vendor scheduleLastUpdatedStamp and markUserEdit) take their settings, notify and the note writer as deps instead of the plugin: window.setTimeout → setTimeout with a delay that defaults to the vendor's 2000 ms, console.warn on a failed write is kept, Notices → deps.notify('info') with the vendor strings through coreT. syncTocOnSave is the body of the vendor's debounced registerUnitOpTocAutoSync, run when a workflow note is saved instead of 1.5 s after an edit; it returns the new text, or null when nothing changes, when the caret sits in the span the rewrite would replace (shouldDeferTocSync), or right after an undo/redo. With the setting off it applies only refreshUnitOpTocEntries, as the vendor timer does: the order is left as the researcher arranged it and no entry is dropped on save. pruneOnUnitOpDelete is the sorting-off branch of the vendor reorder filter (deletesWholeUnitOpHeading, #406): a user deletion that takes a whole `### [` heading line drops that block's entry in the same transaction, but a cut ('delete.cut') does not, since the block is usually pasted back elsewhere. The filter skips composition, file reloads and undo/redo as the vendor's does; with sorting on it does nothing here, since the save rebuilds the list.

import type { Transaction, Text } from '@codemirror/state';
import { minimalReplacement, pruneUnitOpTocEntries, rebuildUnitOpToc, refreshUnitOpTocEntries, shouldDeferTocSync } from '@labnoteo/core';
import * as posix from '@labnoteo/core/posix';
import { getSeoulDateString, readLastUpdatedDate, touchLastUpdatedDate } from '@labnoteo/core/lib/dateUtils';
import { getExperimentDir } from '@labnoteo/core/lib/labnoteStructure';
import { isValidWorkflowPath } from '@labnoteo/core/lib/workflowStructure';
import { coreT } from '../i18n';

// ---------------------------------------------------------------------------
// lastUpdatedStamp.ts

/** A `.labnote.md` inside a `labnote/###_*` experiment folder. */
export function isLabNotePath(path: string): boolean {
  return path.toLowerCase().endsWith('.labnote.md') && getExperimentDir(path) !== undefined;
}

/** The experiment README to stamp alongside a workflow note, if `path` is one. */
export function experimentReadmeOf(path: string): string | undefined {
  if (!isValidWorkflowPath(path)) return undefined;
  const dir = getExperimentDir(path);
  return dir ? posix.join(dir, 'README.labnote.md') : undefined;
}

// ---------------------------------------------------------------------------
// unitOpReorderFilter.ts: what kind of change a transaction is

export interface DocChangeKind {
  /** Typed, pasted, dropped, deleted, ticked or written by an app command. File reloads, undo/redo and the upkeep's own edits are not. */
  userEdit: boolean;
  /** A user edit that changed the front matter `last_updated_date` value. */
  dateEdited: boolean;
  /** A user edit that took the `last_updated_date` line out of a front matter that still reads (#466). */
  dateRemoved?: boolean;
  /** A user edit that left the `last_updated_date` key with an empty value (#466): an invitation to stamp it. */
  dateCleared?: boolean;
}

export interface DocChange extends DocChangeKind {
  fromHistory: boolean;
}

/** Front matter scan stops here; real notes close theirs long before. */
const FRONT_MATTER_MAX_LINES = 200;

/** End offset of the leading front matter's closing `---` line, or -1. */
function frontMatterEnd(doc: Text): number {
  if (doc.lines < 2 || doc.line(1).text.trim() !== '---') return -1;
  const last = Math.min(doc.lines, FRONT_MATTER_MAX_LINES);
  for (let n = 2; n <= last; n++) {
    const line = doc.line(n);
    if (line.text.trim() === '---') return line.to;
  }
  return -1;
}

function lastUpdatedOf(doc: Text): string | undefined {
  const end = frontMatterEnd(doc);
  return end === -1 ? undefined : readLastUpdatedDate(doc.sliceString(0, end));
}

/** The userEvent of edits the app's own commands make (labnote/openNotes.ts). */
const COMMAND_EVENT = 'input.labnote';

export function classifyChange(tr: Transaction): DocChange {
  const fromHistory = tr.isUserEvent('undo') || tr.isUserEvent('redo');
  const userEdit = tr.isUserEvent('input') || tr.isUserEvent('delete') || tr.isUserEvent('move');
  if (!userEdit || tr.isUserEvent(COMMAND_EVENT)) return { userEdit, dateEdited: false, fromHistory };
  const fmEnd = frontMatterEnd(tr.startState.doc);
  let inFrontMatter = false;
  tr.changes.iterChangedRanges((fromA) => {
    if (fromA <= fmEnd) inFrontMatter = true;
  });
  // A front matter the edit broke has no date to read; that is no date edit.
  if (!inFrontMatter || frontMatterEnd(tr.newDoc) === -1) return { userEdit, dateEdited: false, fromHistory };
  const before = lastUpdatedOf(tr.startState.doc);
  const after = lastUpdatedOf(tr.newDoc);
  if (before === after) return { userEdit, dateEdited: false, fromHistory };
  if (after === undefined) return { userEdit, dateEdited: false, dateRemoved: true, fromHistory };
  // An emptied value is a date to be stamped again, not one set by hand (#466).
  if (after === '') return { userEdit, dateEdited: false, dateCleared: true, fromHistory };
  return { userEdit, dateEdited: true, fromHistory };
}

// ---------------------------------------------------------------------------
// lastUpdatedTracker.ts

interface Pending {
  userEdit: boolean;
  lastFromHistory: boolean;
}

/**
 * - `stamp`: write today's date.
 * - `handSet`: skipped because the user set the date by hand today; reported once per hand-set date (#202).
 * - `removed`: the user deleted the `last_updated_date` line, which the stamp never adds back; reported once (#466).
 * - `skip`: nothing to do.
 */
export type StampDecision = 'stamp' | 'handSet' | 'removed' | 'skip';

export class LastUpdatedTracker {
  private readonly pending = new Map<string, Pending>();
  /** Notes whose date the user set by hand, with the (Seoul) day it was set. Left alone for that day only. */
  private readonly manual = new Map<string, { day: string; reported: boolean }>();
  /** Notes whose `last_updated_date` line the user deleted, and whether that was reported. */
  private readonly removed = new Map<string, boolean>();

  constructor(private readonly today: () => string = getSeoulDateString) {}

  record(path: string, change: DocChange): void {
    if (change.dateEdited) {
      this.manual.set(path, { day: this.today(), reported: false });
      this.removed.delete(path);
    }
    if (change.dateRemoved && !this.removed.has(path)) this.removed.set(path, false);
    // An emptied value asks for the date back (#466).
    if (change.dateCleared) {
      this.manual.delete(path);
      this.removed.delete(path);
    }
    const prev = this.pending.get(path);
    this.pending.set(path, {
      userEdit: (prev?.userEdit ?? false) || change.userEdit,
      lastFromHistory: change.fromHistory,
    });
  }

  /** Whether to stamp `path` now, clearing what was recorded for it. Never right after undo/redo. */
  consume(path: string): StampDecision {
    const p = this.pending.get(path);
    this.pending.delete(path);
    if (!p || !p.userEdit || p.lastFromHistory) return 'skip';
    if (this.removed.get(path) === false) {
      this.removed.set(path, true);
      return 'removed';
    }
    const hand = this.manual.get(path);
    if (!hand) return 'stamp';
    if (hand.day !== this.today()) {
      this.manual.delete(path);
      return 'stamp';
    }
    if (hand.reported) return 'skip';
    hand.reported = true;
    return 'handSet';
  }

  /** Whether `path`'s date was set by hand today, so a stamp coming from another note leaves it too (#363). */
  keepsHandSet(path: string): boolean {
    return this.manual.get(path)?.day === this.today();
  }

  /** Take the one notice a hand-set date earns, for a stamp that is being left out right now (#545). */
  claimHandSetNotice(path: string): boolean {
    const hand = this.manual.get(path);
    if (!hand || hand.day !== this.today() || hand.reported) return false;
    hand.reported = true;
    return true;
  }

  clear(): void {
    this.pending.clear();
    this.manual.clear();
    this.removed.clear();
  }
}

// ---------------------------------------------------------------------------
// main.ts: the stamp transform and the debounced scheduler

export interface UpkeepSettings {
  autoUpdateLastUpdated: boolean;
  autoSyncUnitOpToc: boolean;
}

export interface StampDeps {
  settings(): UpkeepSettings;
  tracker: LastUpdatedTracker;
  notify(message: string): void;
  today?: () => string;
}

/**
 * Set `last_updated_date` to today (#42); identity when the setting is off. With `path`, the note whose content this
 * is: a date its reader set by hand today stands (#363).
 */
export function stampLastUpdated(deps: StampDeps): (content: string, path?: string) => string {
  const today = deps.today ?? getSeoulDateString;
  return (content, path) => {
    if (!deps.settings().autoUpdateLastUpdated) return content;
    if (path !== undefined && deps.tracker.keepsHandSet(path)) {
      // Said once a day per note, whichever stamp is the one being left out.
      const stamped = touchLastUpdatedDate(content, today());
      if (stamped !== content && deps.tracker.claimHandSetNotice(path)) {
        deps.notify(coreT('Kept the last_updated_date you set by hand in {0}. It updates automatically again from tomorrow.', posix.basename(path)));
      }
      return content;
    }
    return touchLastUpdatedDate(content, today());
  };
}

export interface SchedulerDeps extends StampDeps {
  /** Applies `stamp` to one note: the open editor's buffer, or the file on disk. */
  stampNote(path: string, stamp: (content: string) => string): Promise<void>;
  delayMs?: number;
}

/**
 * Debounced stamp of a lab note's `last_updated_date` (and, for a workflow note, its experiment README) 2 s after
 * the last change. `consume` only stamps after a recorded user edit.
 */
export class LastUpdatedScheduler {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly stamp: (content: string, path?: string) => string;

  constructor(private readonly deps: SchedulerDeps) {
    this.stamp = stampLastUpdated(deps);
  }

  /** A change seen in an editor of `path`. */
  record(path: string, change: DocChange): void {
    if (!this.deps.settings().autoUpdateLastUpdated || !isLabNotePath(path)) return;
    this.deps.tracker.record(path, change);
    if (change.userEdit || change.fromHistory) this.schedule(path);
  }

  /** A code-driven, user-intent edit (a scan placed in the note, …): stamp it as if typed. */
  markUserEdit(path: string): void {
    this.record(path, { userEdit: true, dateEdited: false, fromHistory: false });
  }

  private schedule(path: string): void {
    const prev = this.timers.get(path);
    if (prev !== undefined) clearTimeout(prev);
    const handle = setTimeout(() => {
      this.timers.delete(path);
      const decision = this.deps.tracker.consume(path);
      if (!this.deps.settings().autoUpdateLastUpdated) return;
      if (decision === 'handSet') {
        this.deps.notify(coreT('Kept the last_updated_date you set by hand in {0}. It updates automatically again from tomorrow.', posix.basename(path)));
        return;
      }
      if (decision === 'removed') {
        this.deps.notify(coreT('{0} has no last_updated_date now, so it is not updated automatically. Put the line back in the front matter to have it recorded again.', posix.basename(path)));
        return;
      }
      if (decision !== 'stamp') return;
      this.stampNoteAndReadme(path).catch((err) => console.warn('[labnoteo] last_updated_date update failed:', err));
    }, this.deps.delayMs ?? 2000);
    this.timers.set(path, handle);
  }

  /** Stamp a note and, for a workflow note, its experiment README unless its date was set by hand today. */
  private async stampNoteAndReadme(path: string): Promise<void> {
    await this.deps.stampNote(path, (content) => this.stamp(content, path));
    const readme = experimentReadmeOf(path);
    if (readme && !this.deps.tracker.keepsHandSet(readme)) await this.deps.stampNote(readme, (content) => this.stamp(content, readme));
  }

  dispose(): void {
    for (const handle of this.timers.values()) clearTimeout(handle);
    this.timers.clear();
  }
}

// ---------------------------------------------------------------------------
// main.ts: registerUnitOpTocAutoSync, run on save

/**
 * A workflow note's `## Related Unit Operations` list rebuilt from its `### [..]` headings (sorting on) or its entries'
 * names and links matched to them in the order the note has (sorting off: no entry is added or dropped here). Null when nothing changes, when `path` is no workflow note, when the
 * caret is in the span the rewrite would replace (#562), or when `fromHistory` (the redo stack stays walkable).
 */
export function syncTocOnSave(
  path: string,
  text: string,
  settings: Pick<UpkeepSettings, 'autoSyncUnitOpToc'>,
  opts: { caret?: number; fromHistory?: boolean } = {},
): string | null {
  if (!isValidWorkflowPath(path) || opts.fromHistory) return null;
  const before = text;
  const after = settings.autoSyncUnitOpToc
    ? rebuildUnitOpToc(before)
    : refreshUnitOpTocEntries(before);
  const edit = minimalReplacement(before, after);
  if (!edit) return null;
  if (opts.caret !== undefined && shouldDeferTocSync(opts.caret, edit)) return null;
  return after;
}

// ---------------------------------------------------------------------------
// unitOpReorderFilter.ts: with sorting off, a deleted block takes its own entry (#406)

const UNIT_OP_HEADING_MARK = '### [';

/**
 * A user deletion that took at least one whole `### [` heading line with it (deleting or cutting a unit-op block).
 * Deleting a heading character by character is not one, since the heading is usually being retyped.
 */
function deletesWholeUnitOpHeading(tr: Transaction): boolean {
  if (!tr.isUserEvent('delete')) return false;
  const doc = tr.startState.doc;
  let hit = false;
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    if (hit || inserted.length > 0 || toA === fromA) return;
    const removed = doc.sliceString(fromA, toA);
    if (!removed.includes('\n')) return;
    const atLineStart = doc.lineAt(fromA).from === fromA;
    hit = (atLineStart && removed.startsWith(UNIT_OP_HEADING_MARK)) || removed.includes(`\n${UNIT_OP_HEADING_MARK}`);
  });
  return hit;
}

/**
 * Changes (positions in `tr.newDoc`, sequential) that drop the list entries of the unit-op blocks `tr` deleted, for a
 * workflow note with sorting off; empty otherwise. A cut keeps its entry: the block is usually pasted back elsewhere.
 * Run as a transaction filter so one undo brings the block and its entry back together.
 */
export function pruneOnUnitOpDelete(
  tr: Transaction,
  path: string,
  settings: Pick<UpkeepSettings, 'autoSyncUnitOpToc'>,
): { from: number; to: number; insert: string }[] {
  if (!tr.docChanged || settings.autoSyncUnitOpToc) return [];
  if (tr.isUserEvent('input.type.compose') || tr.isUserEvent('set') || tr.isUserEvent('undo') || tr.isUserEvent('redo')) return [];
  if (!isValidWorkflowPath(path)) return [];
  if (!deletesWholeUnitOpHeading(tr) || tr.isUserEvent('delete.cut')) return [];
  return pruneUnitOpTocEntries(tr.newDoc.toString());
}
