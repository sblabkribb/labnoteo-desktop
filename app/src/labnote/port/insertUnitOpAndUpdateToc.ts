// Ported from app/vendor/labnoteo/src/commands.ts:1425-1468 sha256:b03d1467386e815a
// labnoteO 0.138.0, Apache-2.0.
// Changes: the imports below replace the top of commands.ts. The caller (commands/unitOp.ts) passes a host whose
// editTarget() is the batching target of the open view, so the block insert and the TOC rewrite are one transaction.

import type { InsertUnitOperationInput, LabnoteHost } from '@labnoteo/core';
import {
  addUnitOpTocEntry,
  insertUnitOperation,
  locateInsertedUnitOpHeading,
  rebuildUnitOpToc,
  refreshUnitOpTocEntries,
  unitOpInsertPointAtCursor,
  unitOpSectionLine,
} from '@labnoteo/core';
import { isValidWorkflowPath } from '@labnoteo/core/lib/workflowStructure';

export async function insertUnitOpAndUpdateToc(
  host: LabnoteHost,
  input: InsertUnitOperationInput,
  askAlias?: (input: InsertUnitOperationInput) => Promise<string | undefined>,
  opts: { sortToc: boolean } = { sortToc: true }
): Promise<boolean> {
  // Asked only where the insert will go ahead: `insertUnitOperation` refuses a
  // note that is no workflow, which would come after the alias was typed.
  let alias = input.alias;
  const opened = host.editTarget();
  if (askAlias && opened && isValidWorkflowPath(opened.path)) {
    alias = await askAlias(input);
    if (alias === undefined) return false;
  }

  // Resolve the insertion point BEFORE inserting and hand it to the insert, so
  // the new heading can be found again after the whole-doc TOC rewrite.
  const before = host.editTarget();
  const at = before ? await unitOpInsertPointAtCursor(before) : undefined;
  const insertOffset = at?.offset ?? -1;

  // The TOC follows before the notice, which says whether there was one (#455).
  const afterInsert = async (): Promise<boolean> => {
    const target = host.editTarget();
    if (!target) return false;
    const md = await target.getText();
    const heading = insertOffset >= 0 ? md.indexOf('### [', insertOffset) : -1;
    const updated =
      opts.sortToc || heading === -1 ? rebuildUnitOpToc(md) : refreshUnitOpTocEntries(addUnitOpTocEntry(md, heading));
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

