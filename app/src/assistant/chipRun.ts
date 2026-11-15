import type { ChipId } from './chips';
import type { SectionChoice } from './SectionPicker';
import type { ChipRun } from './useAssistantSession';

export interface ChipRunInput {
  /** What the person wrote (may be empty for a section). */
  text: string;
  /** The picked section (section chip). */
  section?: SectionChoice | null;
  /** Path of the note the section list was read from. */
  notePath?: string;
  /** The open note. */
  activePath?: string;
  /** The experiment folder (null outside an experiment). */
  folder: string | null;
  /** The workflow note a unit operation goes to (the open workflow note, or the one picked). */
  unitOpTarget?: string;
}

/**
 * The run a creating chip sends: the same parameters whether the in-window panel or the desktop pet's question asks.
 * Null when the chip has nothing to run yet (no section picked, no target, no text) or is not a creating chip.
 */
export function buildChipRun(chip: ChipId, i: ChipRunInput): ChipRun | null {
  const text = i.text.trim();
  if (chip === 'section') {
    const section = i.section;
    if (!section) return null;
    return {
      chip,
      params: {
        documentPath: i.notePath ?? i.activePath ?? '',
        heading: section.heading,
        ...(section.parentHeading ? { parentHeading: section.parentHeading } : {}),
        ...(section.after ? { after: section.after } : {}),
        existing: section.existing ? 'yes' : 'no',
      },
      line: text ? `${section.heading} — ${text}` : section.heading,
      text,
    };
  }
  if (chip === 'unitOp') {
    if (!i.unitOpTarget || !text) return null;
    return { chip, params: { documentPath: i.unitOpTarget }, line: text, text };
  }
  if (chip === 'workflow') {
    if (!text) return null;
    return { chip, params: { documentPath: i.activePath ?? i.folder ?? '' }, line: text, text };
  }
  return null;
}
