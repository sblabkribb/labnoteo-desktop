// Ported from app/vendor/labnoteo/src/barcode/noteIdService.ts:1-364 sha256:9a5ee260f79825f4
// labnoteO 0.140.2, Apache-2.0.
// Changes: App/TFile become NoteIdSource/NoteRef; metadataCache…frontmatter[NOTE_ID_KEY] becomes source.idOf(path);
// vault.getMarkdownFiles() becomes source.files(); vault.read becomes source.read; vault.process(file, fn) becomes
// source.process(path, fn), editor-aware, refusing a composing note with NoteBusyError; getAbstractFileByPath(p)
// instanceof TFile becomes source.exists(p); file.stat.ctime becomes ref.ctime; file.basename is ref.basename (the
// file name without .md); noteIdFromFiledScanEmbed comes from ./scanNames; NoteIdSource is declared here.
/**
 * Finding notes by their `labnote_id`, and giving notes one.
 *
 * Lookups go through the note-ID index, so they cost nothing per scan. A note
 * copied outside the app (file manager, git) keeps the original's ID; such
 * duplicates are reported once per session and set of notes, with an offer to
 * give the newer note its own ID. Only lab notes count: a template or other
 * Markdown file carrying an ID is named in a warning instead (#426).
 */
import type { LabnoteHost } from '@labnoteo/core';
import { listFiledScans, parseFrontMatterYaml } from '@labnoteo/core';
import { generateNoteId, isValidNoteId, readNoteId, readRawNoteId, setNoteId } from '@labnoteo/core/lib/noteId';
import type { NoteRef } from '../barcode/noteIdIndex';
import { noteIdFromFiledScanEmbed } from './scanNames';

/** Where the service finds notes and their IDs, and how it writes one (the plugin's App). */
export interface NoteIdSource {
  /** Every Markdown file. */
  files(): readonly NoteRef[];
  /** The note's valid `labnote_id`, from its front matter. */
  idOf(path: string): string | undefined;
  read(path: string): Promise<string>;
  /** Rewrite the note; refuses a note being edited (composing) with NoteBusyError and writes nothing. */
  process(path: string, fn: (text: string) => string): Promise<void>;
  exists(path: string): boolean;
}

/** Notes that get a barcode: lab notes (`*.labnote.md`). */
export const isBarcodeNote = (path: string): boolean => path.toLowerCase().endsWith('.labnote.md');

const duplicateKey = (id: string, files: readonly NoteRef[]): string =>
  `${id}\n${files
    .map((f) => f.path)
    .sort()
    .join('\n')}`;

const newestOf = (files: readonly NoteRef[]): NoteRef => files.reduce((a, b) => (b.ctime > a.ctime ? b : a));

/**
 * The ID a note was printed under before its `labnote_id` line was lost, read
 * from the names of the scans filed in it; the most frequent when they differ.
 */
export function previousNoteIdFromScans(content: string): string | undefined {
  const counts = new Map<string, number>();
  for (const scan of listFiledScans(content)) {
    const id = noteIdFromFiledScanEmbed(scan.embed);
    if (id && isValidNoteId(id)) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  let best: string | undefined;
  for (const [id, n] of counts) if (best === undefined || n > counts.get(best)!) best = id;
  return best;
}

export class NoteIdService {
  /** Duplicates already asked about, by ID and the notes sharing it (#425). */
  private readonly reported = new Set<string>();
  private readonly warnedOutsideLabNotes = new Set<string>();
  /**
   * Each lab note's ID as last seen, by path, to tell when it changed (#443).
   * Undefined until {@link rememberIds}: before the index has every note there
   * is nothing to compare with.
   */
  private known: Map<string, string> | undefined;
  /** The changed-ID questions, asked one after another. */
  private idChangeQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly source: NoteIdSource,
    private readonly host: LabnoteHost,
  ) {}

  /** The note's ID as the index knows it. */
  idOf(file: NoteRef): string | undefined {
    const value: unknown = this.source.idOf(file.path);
    return isValidNoteId(value) ? value : undefined;
  }

  /**
   * Every ID in the vault with the lab notes carrying it. Other Markdown files
   * (a template made from a lab note, say) are left out, with
   * `outsideLabNotes`: they are never printed, so a scan cannot be meant for them.
   */
  index(opts: { outsideLabNotes?: boolean } = {}): Map<string, NoteRef[]> {
    const byId = new Map<string, NoteRef[]>();
    for (const file of this.source.files()) {
      if (isBarcodeNote(file.path) === !!opts.outsideLabNotes) continue;
      const id = this.idOf(file);
      if (!id) continue;
      const list = byId.get(id);
      if (list) list.push(file);
      else byId.set(id, [file]);
    }
    return byId;
  }

  filesWithId(id: string): NoteRef[] {
    return this.index().get(id) ?? [];
  }

  /** Markdown files other than lab notes that carry `id`. */
  filesOutsideLabNotesWithId(id: string): NoteRef[] {
    return this.index({ outsideLabNotes: true }).get(id) ?? [];
  }

  /**
   * The note's ID, giving it a fresh one first when it has none (or always,
   * with `reassign`). Undefined when the front matter cannot be read (writing
   * then could lose the other fields) or when the user cancelled the offer to
   * restore an earlier ID. Not a content change, so `last_updated_date` stays
   * as it is.
   */
  async ensureId(file: NoteRef, opts: { reassign?: boolean } = {}): Promise<string | undefined> {
    return (await this.ensureIdResult(file, opts)).id;
  }

  /** {@link ensureId}, saying why no ID came back. */
  async ensureIdResult(
    file: NoteRef,
    opts: { reassign?: boolean } = {},
  ): Promise<{ id: string; reason?: undefined } | { id?: undefined; reason: 'unreadable' | 'cancelled' }> {
    const content = (await this.source.read(file.path)).replace(/\r\n/g, '\n');
    if (!opts.reassign) {
      const existing = readNoteId(content);
      if (existing) return { id: existing };
    }
    const { parseError } = parseFrontMatterYaml(content);
    if (parseError) {
      this.host.notify(
        'warn',
        this.host.t(
          'Front matter of {0} could not be read, so it was left unchanged. Fix the YAML and try again: {1}',
          file.path,
          parseError,
        ),
      );
      return { reason: 'unreadable' };
    }
    if (!opts.reassign) {
      const raw = readRawNoteId(content);
      const offer = raw === undefined ? await this.offerPreviousId(file, content) : await this.offerFixedId(file, content, raw);
      if (offer.choice === 'restored') return { id: offer.id };
      if (offer.choice === 'cancelled') return { reason: 'cancelled' };
    }
    const taken = new Set([...this.index().keys(), ...this.index({ outsideLabNotes: true }).keys()]);
    let id = generateNoteId();
    while (taken.has(id)) id = generateNoteId();
    await this.writeId(file, id);
    return { id };
  }

  /** Write `id` as the note's `labnote_id`, known first so it is not taken for a change made elsewhere. */
  private async writeId(file: NoteRef, id: string): Promise<void> {
    this.known?.set(file.path, id);
    await this.source.process(file.path, (data) => setNoteId(data, id));
  }

  /**
   * Start following each lab note's ID (#443). Called once the index has every
   * note; later calls change nothing, or an ID changed in between would be
   * taken as the one to compare with.
   */
  rememberIds(): void {
    if (this.known) return;
    this.known = new Map();
    for (const [id, files] of this.index()) for (const file of files) this.known.set(file.path, id);
  }

  moveKnown(oldPath: string, newPath: string): void {
    const id = this.known?.get(oldPath);
    if (id === undefined) return;
    this.known!.delete(oldPath);
    this.known!.set(newPath, id);
  }

  forget(path: string): void {
    this.known?.delete(path);
  }

  /**
   * The note's `labnote_id` changed to another valid ID (#443): merging notes
   * keeps the merged one's ID, and worksheets printed under the old ID no
   * longer find the note. Offer the old ID back, unless another note holds it
   * (a pulled fix of a duplicate). Resolves true when it asked, so a duplicate
   * the change made for a moment is not asked about as well.
   */
  async checkIdChange(file: NoteRef): Promise<boolean> {
    const now = this.idOf(file);
    if (!this.known || !now || !isBarcodeNote(file.path)) return false;
    const old = this.known.get(file.path);
    this.known.set(file.path, now);
    if (old === undefined || old === now) return false;
    if (this.filesWithId(old).some((f) => f.path !== file.path)) return false;
    const asked = this.idChangeQueue.then(() => this.offerIdBack(file, old, now));
    this.idChangeQueue = asked.catch(() => undefined);
    await asked;
    return true;
  }

  private async offerIdBack(file: NoteRef, old: string, now: string): Promise<void> {
    const ok = await this.host.confirm(
      this.host.t(
        'The labnote_id of {0} changed from {1} to {2} (by merging notes, say). Worksheets already printed as {1} will not find this note. Restore {1}?',
        file.basename,
        old,
        now,
      ),
      { confirmLabel: this.host.t('Restore ID') },
    );
    if (!ok || !this.source.exists(file.path)) return;
    if (this.filesWithId(old).some((f) => f.path !== file.path)) return;
    await this.writeId(file, old);
    this.host.notify('info', this.host.t('{0} has the note ID {1} again.', file.basename, old));
  }

  /**
   * A `labnote_id` edited out of the ID format (#478). One that only lost its
   * capitals is the ID it was, so it is written back as such; anything else is
   * not replaced without asking, since worksheets printed under the old ID
   * would no longer find the note. Restoring the ID its scans name is offered
   * first, as for a deleted line.
   */
  private async offerFixedId(
    file: NoteRef,
    content: string,
    raw: string,
  ): Promise<{ choice: 'restored'; id: string } | { choice: 'new' | 'cancelled' }> {
    const upper = raw.toUpperCase();
    if (isValidNoteId(upper) && !this.filesWithId(upper).some((f) => f.path !== file.path)) {
      await this.writeId(file, upper);
      this.host.notify(
        'info',
        this.host.t('The labnote_id of {0} was written as "{1}"; restored it as {2}.', file.basename, raw, upper),
      );
      return { choice: 'restored', id: upper };
    }
    const previous = previousNoteIdFromScans(content);
    const restorable = previous && !this.filesWithId(previous).some((f) => f.path !== file.path) ? previous : undefined;
    const choice = await this.host.pick<'restore' | 'new' | 'cancel'>(
      [
        ...(restorable ? [{ label: this.host.t('Restore ID'), description: restorable, value: 'restore' as const }] : []),
        { label: this.host.t('Give a new ID'), value: 'new' },
        { label: this.host.t('Cancel'), value: 'cancel' },
      ],
      {
        title: this.host.t(
          'The labnote_id of this note, "{0}", is not a note ID (LN- and 8 letters or digits). Give it a new one? Worksheets printed under the old ID will not find this note.',
          raw,
        ),
      },
    );
    if (choice === 'new') return { choice: 'new' };
    if (choice !== 'restore' || !restorable) return { choice: 'cancelled' };
    await this.writeId(file, restorable);
    return { choice: 'restored', id: restorable };
  }

  /**
   * A note without an ID whose filed scans name the ID it was printed under
   * (#236): offer that ID back, so worksheets already printed still find the
   * note. A new ID is a choice of its own, so closing the question changes
   * nothing and it is asked again next time (#267).
   */
  private async offerPreviousId(
    file: NoteRef,
    content: string,
  ): Promise<{ choice: 'restored'; id: string } | { choice: 'new' | 'cancelled' }> {
    const previous = previousNoteIdFromScans(content);
    if (!previous) return { choice: 'new' };
    const holder = this.filesWithId(previous).find((f) => f.path !== file.path);
    if (holder) {
      this.host.notify(
        'warn',
        this.host.t(
          'The scans in this note are named after the note ID {0}, but {1} has that ID now, so this note gets a new one. Worksheets printed as {0} are filed in {1}.',
          previous,
          holder.path,
        ),
      );
      return { choice: 'new' };
    }
    const choice = await this.host.pick<'restore' | 'new' | 'cancel'>(
      [
        { label: this.host.t('Restore ID'), description: previous, value: 'restore' },
        { label: this.host.t('Give a new ID'), value: 'new' },
        { label: this.host.t('Cancel'), value: 'cancel' },
      ],
      {
        title: this.host.t(
          'This note has no labnote_id, but its scans show it was printed as {0}. Restore that ID? With a new ID, worksheets already printed will not find this note.',
          previous,
        ),
      },
    );
    if (choice === 'new') return { choice: 'new' };
    if (choice !== 'restore') return { choice: 'cancelled' };
    await this.writeId(file, previous);
    return { choice: 'restored', id: previous };
  }

  /**
   * IDs carried by several lab notes whose set of notes was not reported yet
   * this session, each with the note to re-number: the most recently created
   * one. A note joining a reported set makes it a new one (#425).
   */
  unreportedDuplicates(): { id: string; files: NoteRef[]; newest: NoteRef }[] {
    const out: { id: string; files: NoteRef[]; newest: NoteRef }[] = [];
    for (const [id, files] of this.index()) {
      if (files.length < 2 || this.reported.has(duplicateKey(id, files))) continue;
      this.reported.add(duplicateKey(id, files));
      out.push({ id, files, newest: newestOf(files) });
    }
    return out;
  }

  /** True when another lab note or a Markdown file outside lab notes carries the note's ID. */
  sharesId(file: NoteRef): boolean {
    const id = this.idOf(file);
    if (!id) return false;
    return this.filesWithId(id).length > 1 || this.filesOutsideLabNotesWithId(id).length > 0;
  }

  /**
   * Ask about each newly found duplicate ID, one at a time, and again about
   * the notes left sharing it after one was re-numbered (#425).
   */
  async offerDuplicateFixes(): Promise<void> {
    this.warnIdsOutsideLabNotes();
    for (const dup of this.unreportedDuplicates()) {
      let files = dup.files;
      while (files.length > 1) {
        const newest = files === dup.files ? dup.newest : newestOf(files);
        this.reported.add(duplicateKey(dup.id, files));
        const ok = await this.host.confirm(
          this.host.t(
            'Notes {0} share the note ID {1}, probably because one was copied. Scans of either note would be filed in the wrong one. Give {2} a new ID?',
            files.map((f) => f.path).join(', '),
            dup.id,
            newest.path,
          ),
          { confirmLabel: this.host.t('Give a new ID') },
        );
        if (!ok) break;
        if (this.source.exists(newest.path)) {
          const next = await this.ensureId(newest, { reassign: true });
          if (!next) break;
          this.host.notify('info', this.host.t('{0} now has the note ID {1}.', newest.basename, next));
        }
        files = files.filter((f) => f.path !== newest.path);
      }
    }
  }

  /**
   * A template or other Markdown file sharing a lab note's ID hands it to every
   * note made from it, and re-numbering the file only moves the clash (#426).
   */
  private warnIdsOutsideLabNotes(): void {
    const labIds = this.index();
    for (const [id, files] of this.index({ outsideLabNotes: true })) {
      if (!labIds.has(id)) continue;
      for (const file of files) {
        const key = `${id}\n${file.path}`;
        if (this.warnedOutsideLabNotes.has(key)) continue;
        this.warnedOutsideLabNotes.add(key);
        this.host.notify(
          'warn',
          this.host.t(
            '{0} is not a lab note but carries the note ID {1}, so notes made from it as a template get that ID too. Delete its labnote_id line.',
            file.path,
            id,
          ),
        );
      }
    }
  }
}
