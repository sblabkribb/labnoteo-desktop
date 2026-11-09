// Ported from app/vendor/labnoteo/src/commands.ts:1448-1510 sha256:ce1993018eafe7d8
// labnoteO 0.140.2, Apache-2.0.
// Changes: the imports below replace the top of commands.ts. The caller (commands/unitOp.ts) passes a host whose
// editTarget() is the batching target of the open view, so the restored section heading (#564), the block insert and
// the TOC rewrite are one transaction. The caller asks the alias before the batch and passes no opts.caret, so the
// caret (#544) is read from the batch target's own cursor, which no dialog moves.

import type { InsertUnitOperationInput, LabnoteHost } from '@labnoteo/core';
import {
  insertUnitOperation,
  locateInsertedUnitOpHeading,
  missingUnitOpSectionEdit,
  syncUnitOpTocAfterInsert,
  unitOpInsertPointAtCursor,
  unitOpSectionLine,
} from '@labnoteo/core';
import { caretBeforeModal } from '@labnoteo/core/lib/caret';
import { isValidWorkflowPath } from '@labnoteo/core/lib/workflowStructure';

/**
 * Insert a unit-operation block into the `## Related Unit Operations` section
 * (after the block the cursor is in, see `insertUnitOperation`), then rebuild
 * that section's TOC so its entries follow the document order of the actual
 * `### [..]` headings. Finally, move the cursor/focus to the just-inserted
 * heading. Shared by the command and the workflow sidebar's context menu, which
 * uses the cursor of the editor last active. With `sortToc` off (the "Auto-sync
 * unit operation TOC" setting), the new entry is added without reordering the
 * others (#457).
 */
export async function insertUnitOpAndUpdateToc(
  host: LabnoteHost,
  input: InsertUnitOperationInput,
  askAlias?: (input: InsertUnitOperationInput) => Promise<string | undefined>,
  opts: { sortToc: boolean; caret?: number } = { sortToc: true }
): Promise<boolean> {
  // Asked only where the insert will go ahead: `insertUnitOperation` refuses a
  // note that is no workflow, which would come after the alias was typed.
  let alias = input.alias;
  const opened = host.editTarget();
  // Read before the alias prompt opens: a modal takes the focus, and the
  // Source-mode editor then reports the cursor at the start of the note (#544).
  // A caller whose own picker already moved it passes what it read instead.
  let caret = opts.caret ?? (opened ? await caretBeforeModal(opened) : undefined);
  if (askAlias && opened && isValidWorkflowPath(opened.path)) {
    alias = await askAlias(input);
    if (alias === undefined) return false;
  }

  // Resolve the insertion point BEFORE inserting and hand it to the insert, so
  // the new heading can be found again after the whole-doc TOC rewrite.
  const before = host.editTarget();
  // A deleted section heading comes back first, or the list would go under the title (#564).
  if (before && isValidWorkflowPath(before.path)) {
    const fix = missingUnitOpSectionEdit(await before.getText());
    if (fix) {
      await before.replaceRange(fix.offset, fix.offset, fix.text);
      if (caret !== undefined && caret >= fix.offset) caret += fix.text.length;
    }
  }
  const at = before ? await unitOpInsertPointAtCursor(before, caret) : undefined;
  const insertOffset = at?.offset ?? -1;

  // The TOC follows before the notice, which says whether there was one (#455).
  const afterInsert = async (): Promise<boolean> => {
    const target = host.editTarget();
    if (!target) return false;
    const md = await target.getText();
    const updated = syncUnitOpTocAfterInsert(md, insertOffset, opts.sortToc);
    if (updated !== md) {
      await target.replaceRange(0, md.length, updated);
    }
    // Whole-doc replaceRange resets the cursor, so explicitly move focus to the
    // inserted unit-operation heading in the final (rebuilt) text.
    if (target.revealOffset && insertOffset >= 0) {
      const off = locateInsertedUnitOpHeading(md, insertOffset, updated);
      if (off >= 0) await target.revealOffset(off);
    }
    return unitOpSectionLine(updated) !== -1;
  };

  return insertUnitOperation(host, { ...input, alias, at, afterInsert });
}
