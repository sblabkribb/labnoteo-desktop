// Ported from app/vendor/labnoteo/src/barcode/barcodeFeature.ts:212-269 sha256:6a67188f516906c2
// labnoteO 0.140.2, Apache-2.0.
// Changes: class methods become functions over CommandContext; TFile becomes a path (its NoteRef comes from the note-ID index through print/worksheetCommand.ts noteIdServiceFor); this.run becomes runCommand; this.t becomes ctx.host.t; app.vault.read becomes the editor-aware ctx.host.fs.read (an open note's buffer); noteTitleOf(app, file) becomes noteTitleOf(path, content), read after the ID is assigned; BarcodeModal becomes openBarcodeDialog (React); worksheetDeps lives in print/worksheetCommand.ts (with fullNoteDeps for the whole-note print, whose plugin form takes the same deps).
/**
 * Note barcodes from the commands and the QR icon in a lab note's header:
 * show a note's barcode, give a note its own ID, and give a copy its own ID.
 */
import { readNoteId } from '@labnoteo/core/lib/noteId';
import { isValidWorkflowPath } from '@labnoteo/core/lib/workflowStructure';
import type { CommandContext } from '../commands/context';
import { runCommand } from '../commands/runCommand';
import { fullNoteDeps, noteIdServiceFor, worksheetDeps } from '../print/worksheetCommand';
import { openBarcodeDialog } from './barcodeDialog';
import { printFullNoteCommand } from './fullNotePrint';
import { noteTitleOf, printWorksheetCommand } from './worksheetPrint';

/** The note's barcode window; the note gets an ID first when it has none. Resolves when the window closes. */
export async function showBarcode(ctx: CommandContext, path: string): Promise<void> {
  const { service, file } = await noteIdServiceFor(ctx, path);
  const id = await service.ensureId(file);
  if (!id) return;
  const title = noteTitleOf(path, await ctx.host.fs.read(path));
  // The window opens for the notes "Print whole note with barcodes" takes, so it is always offered.
  await openBarcodeDialog(
    { title, id },
    {
      worksheet: isValidWorkflowPath(path)
        ? () => void runCommand(ctx, () => printWorksheetCommand(worksheetDeps(ctx), path))
        : undefined,
      wholeNote: () => void runCommand(ctx, () => printFullNoteCommand(fullNoteDeps(ctx), path)),
    },
  );
}

/** "Assign note ID": a note without one gets one; a note sharing its ID with another may get a new one. */
export async function assignId(ctx: CommandContext, path: string): Promise<void> {
  const { host } = ctx;
  const current = readNoteId(await host.fs.read(path));
  const { service, file } = await noteIdServiceFor(ctx, path);
  if (current) {
    const others = service.filesWithId(current).filter((f) => f.path !== path);
    if (others.length === 0) {
      host.notify('info', host.t('This note already has the note ID {0}.', current));
      return;
    }
    const ok = await host.confirm(
      host.t('{0} also has the note ID {1}. Give this note a new ID?', others.map((f) => f.path).join(', '), current),
      { confirmLabel: host.t('Give a new ID') },
    );
    if (!ok) return;
  }
  const id = await service.ensureId(file, { reassign: !!current });
  if (id) host.notify('info', host.t('{0} now has the note ID {1}.', file.basename, id));
}

/** Copies get their own ID right away, like their issue markers (for the app's future copy flow, E2). */
export async function reassignCopiedId(ctx: CommandContext, path: string): Promise<void> {
  const { host } = ctx;
  if (!readNoteId(await host.fs.read(path))) return;
  const { service, file } = await noteIdServiceFor(ctx, path);
  const id = await service.ensureId(file, { reassign: true });
  if (id) host.notify('info', host.t('Gave the copy {0} its own note ID {1}.', file.basename, id));
}
