import { isValidWorkflowPath } from '@labnoteo/core/lib/workflowStructure';
import type { CommandContext } from '../commands/context';
import type { Command } from '../commands/registry';
import { assignId, showBarcode } from '../port/barcodeActions';
import { printFullNoteCommand } from '../port/fullNotePrint';
import { isBarcodeNote } from '../port/noteIdService';
import { printWorksheetCommand } from '../port/worksheetPrint';
import { fullNoteDeps, worksheetDeps } from '../print/worksheetCommand';

export { assignId, reassignCopiedId, showBarcode } from '../port/barcodeActions';
export { openBarcodeDialog, type BarcodePrintActions } from '../port/barcodeDialog';

/**
 * 바코드 명령 넷(플러그인 barcodeFeature 의 addCommand 넷, 같은 순서). 플러그인의 checkCallback(withActiveNote)처럼
 * 편집기에 열린 노트가 그 명령이 받는 노트일 때만 팔레트에 보인다: 셋은 `*.labnote.md`(isBarcodeNote),
 * 워크시트는 워크플로 노트(isValidWorkflowPath). 팔레트 밖에서 불려 그 노트가 아니면 아무것도 하지 않는다.
 */
function onActiveNote(
  action: (ctx: CommandContext, path: string) => Promise<void>,
  accepts: (path: string) => boolean = isBarcodeNote,
): Pick<Command, 'run' | 'available'> {
  const target = (ctx: CommandContext): string | undefined => {
    const path = ctx.activePath();
    return path !== undefined && accepts(path) ? path : undefined;
  };
  return {
    available: (ctx) => target(ctx) !== undefined,
    run: async (ctx) => {
      const path = target(ctx);
      if (path !== undefined) await action(ctx, path);
    },
  };
}

export const barcodeCommands: Command[] = [
  { id: 'show-note-barcode', nameKey: 'Show note barcode', ...onActiveNote(showBarcode) },
  { id: 'assign-note-id', nameKey: 'Assign note ID', ...onActiveNote(assignId) },
  {
    id: 'print-experiment-worksheet',
    nameKey: 'Print experiment worksheet',
    ...onActiveNote((ctx, path) => printWorksheetCommand(worksheetDeps(ctx), path), isValidWorkflowPath),
  },
  {
    id: 'print-whole-note',
    nameKey: 'Print whole note with barcodes',
    ...onActiveNote((ctx, path) => printFullNoteCommand(fullNoteDeps(ctx), path)),
  },
];
