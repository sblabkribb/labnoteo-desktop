// Ported from app/vendor/labnoteo/src/llm/approvalMessage.ts:19-139 sha256:07f483209eb01205
// labnoteO 0.140.2, Apache-2.0.
// Changes: the Translator parameter t is named translate (as in sampleSettings.ts and llmError.ts) so the app catalog test does not take the plugin keys for app keys; callers pass coreT, whose Korean list (l10n.ko.ts) holds every sentence. The logic is otherwise verbatim.
/**
 * The text of the "allow this write?" prompt, shared by the MCP server and the
 * built-in AI so both describe a write the same way.
 */
import type {
  SampleCreatePreview,
  SectionEditPreview,
  ToolPreview,
  Translator,
  UnitOpInsertPreview,
  WorkflowCreatePreview,
} from '@labnoteo/core';

/**
 * `prompt`, then the write target, then what the write changes (#69, #113):
 * an empty `update_section` once wiped recorded results behind a prompt that
 * named only the tool and the note.
 */
export function buildApprovalMessage(
  translate: Translator,
  prompt: string,
  target: string | null,
  preview?: Exclude<ToolPreview, { error: string }>
): string {
  const parts = [prompt];
  if (target) parts.push(translate('Target: {0}', target));
  if (preview?.kind === 'sectionEdit') parts.push(describeSectionEdit(translate, preview));
  if (preview?.kind === 'sampleCreate') parts.push(describeSampleCreate(translate, preview));
  if (preview?.kind === 'workflowCreate') parts.push(describeWorkflowCreate(translate, preview));
  if (preview?.kind === 'unitOpInsert') parts.push(describeUnitOpInsert(translate, preview));
  return parts.join('\n\n');
}

// Where it goes in the words of the app's insert notice (#491).
function describeUnitOpInsert(translate: Translator, p: UnitOpInsertPreview): string {
  const where =
    p.place === 'after'
      ? translate('(after {0})', p.after ?? '')
      : p.place === 'first'
        ? translate('(before the first unit operation)')
        : p.place === 'end'
          ? translate('(after the last unit operation)')
          : p.place === 'noSection'
            ? p.beforeConclusions
              ? translate('(before the conclusions: no unit operation section was found, so the table of contents was not updated)')
              : translate('(at the end of the note: no unit operation section was found, so the table of contents was not updated)')
            : '';
  const heading = `[${p.opId} ${p.opName}]${p.alias ? ` ${p.alias}` : ''}`;
  const note = p.documentPath.split('/').pop() ?? p.documentPath;
  const head = translate('This inserts unit operation {0} into {1}.', heading, where ? `${note} ${where}` : note);
  if (!p.sameAliasAs) return head;
  return `${head}\n${translate(
    '{0} is already in this note, so the two would read the same in the headings and the table of contents. Give this one its own alias to tell them apart.',
    p.sameAliasAs
  )}`;
}

/** Whether the write erases recorded lines, so Cancel should be the default answer (#187, #198). */
export function erasesRecordedLines(preview?: ToolPreview): boolean {
  return !!preview && 'kind' in preview && preview.kind === 'sectionEdit' && preview.removedText.length > 0;
}

// Two calls on one experiment otherwise read the same (#124).
function describeWorkflowCreate(translate: Translator, p: WorkflowCreatePreview): string {
  const head = translate(
    'This creates catalog workflow {0} {1}. File: {2}. It is also added to the checklist in {3}.',
    p.workflowId,
    p.workflowName,
    p.fileName,
    p.readmePath
  );
  // The same words as the app's alias prompt (#484).
  if (!p.sameAliasAs) return head;
  return `${head}\n${translate(
    '{0} already has this ID and alias, so the two would read the same in the README checklist. Give this one its own alias to tell them apart.',
    p.sameAliasAs
  )}`;
}

function describeSectionEdit(translate: Translator, p: SectionEditPreview): string {
  const section = p.parentHeading ? `${p.parentHeading} > ${p.heading}` : p.heading;
  const lines = String(p.removedLines);
  const head = p.appending
    ? translate('This adds to the end of section "{0}", which now has {1} line(s).', section, lines)
    : p.clearing
      ? translate('This empties section "{0}", which now has {1} line(s).', section, lines)
      : translate('This replaces section "{0}", which now has {1} line(s).', section, lines);
  const parts = [head];
  if (p.removedSubheadings > 0) {
    parts.push(translate('Its {0} nested heading(s) are replaced too.', String(p.removedSubheadings)));
  }
  // Repeated headings read the same otherwise (#114).
  if (p.total > 1) {
    parts.push(
      translate('It is occurrence {0} of {1}, with its heading on line {2}.', String(p.occurrence), String(p.total), String(p.line))
    );
  }
  // The lines themselves, so a note or sample reference about to go is seen
  // before allowing, not after (#187).
  const block = (title: string, lines: string[], more: number): string => {
    const rows = lines.map(l => `  ${l}`);
    if (more > 0) rows.push(`  ${translate('(+{0} more line(s))', String(more))}`);
    return [title, ...rows].join('\n');
  };
  const blocks = [
    p.removedText.length > 0
      ? block(translate('Lines removed:'), p.removedText, p.removedMore)
      : translate('No recorded lines are removed.'),
  ];
  if (p.addedText.length > 0) blocks.push(block(translate('Lines added:'), p.addedText, p.addedMore));
  return [parts.join(' '), ...blocks].join('\n\n');
}

function describeSampleCreate(translate: Translator, p: SampleCreatePreview): string {
  const lines = [
    p.id === undefined
      ? translate('This creates a {0} sample with a new ID.', p.type)
      : p.existing
        ? translate('This adds to {0} sample {1}.', p.type, p.id)
        : translate('This creates {0} sample {1}.', p.type, p.id),
  ];
  if (p.alias) lines.push(translate('Alias: {0}', p.alias));
  if (p.alias && p.aliasTwins?.length) {
    lines.push(
      translate(
        p.scope === 'global' ? 'Global samples already have the alias {0} ({1}).' : 'This experiment already has the alias {0} ({1}).',
        p.alias,
        p.aliasTwins.join(', ')
      )
    );
  }
  if (p.location) lines.push(translate('Storage location: {0}', p.location));
  lines.push(
    p.scope === 'global'
      ? translate('Saved in the global samples folder {0}.', p.folder)
      : translate('Saved in the local samples folder {0}.', p.folder)
  );
  return lines.join('\n');
}
