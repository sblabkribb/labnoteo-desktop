/**
 * The sections the "Create section" chip can pick in the open note (assistant spec §4.4). It reads the note text with the
 * labnoteO section helpers, so it runs in the main window only; the desktop assistant window gets the list through the
 * `sectionChoices` action and never imports this file.
 */
import { listUnitOpBlocks } from '@labnoteo/core';
import { findSectionMatches, listHeadings } from '../../vendor/labnoteo/packages/labnoteo-core/src/sections/sectionEdit';
import { canonicalSection, RESEARCHER_ONLY_SECTIONS, type UnitOpKind } from '../labnote/context/chain';
import { draftableSectionsFor } from '../labnote/context/planningPrompt';
import type { SectionOption } from './SectionPicker';

const kindOf = (opId: string): UnitOpKind => (opId.startsWith('UHW') ? 'hw' : opId.startsWith('USW') ? 'sw' : 'unknown');
const researcherOnly = (heading: string): boolean => {
  const canon = canonicalSection(heading);
  return !!canon && RESEARCHER_ONLY_SECTIONS.includes(canon);
};

/**
 * 열린 노트에서 고를 수 있는 섹션(assistant spec §4.4): 커서(`cursorLine`, 0부터)가 단위 공정 안이면 그 공정의 계획
 * 섹션을 먼저(있는 것은 그 제목 그대로, 없는 것은 새 섹션으로; 넣을 자리가 노트에서 하나로 정해지지 않으면 빼고),
 * 그다음 단위 공정 밖의 제목(# 제목은 빼고). 연구자만 쓰는 섹션(Results & Discussions, QC Metrics, Discussion, Meta)은 없다.
 */
export function sectionOptions(md: string, cursorLine?: number): SectionOption[] {
  const headings = listHeadings(md);
  const blocks = listUnitOpBlocks(md);
  const out: SectionOption[] = [];
  const block = cursorLine === undefined ? undefined : blocks.find((b) => cursorLine >= b.headingLine && cursorLine < b.endLine);
  if (block) {
    const parent = headings.find((h) => h.line === block.headingLine)?.text ?? '';
    const inside = headings.filter((h) => h.line > block.headingLine && h.line < block.endLine && h.level === 4);
    const unique = (heading: string) => findSectionMatches(md, heading).length === 1;
    for (const name of draftableSectionsFor(kindOf(block.opId))) {
      const at = inside.find((h) => canonicalSection(h.text) === name);
      if (at) {
        out.push({ heading: at.text, parentHeading: parent, existing: true, planning: true });
        continue;
      }
      // A missing planning section goes after the nearest section above it that names one place in the note.
      const before = inside.filter((h) => {
        const canon = canonicalSection(h.text);
        const order = draftableSectionsFor(kindOf(block.opId));
        return canon !== undefined && order.indexOf(canon) !== -1 && order.indexOf(canon) < order.indexOf(name);
      });
      const anchor = [...before].reverse().find((h) => unique(h.text));
      if (!anchor) continue;
      out.push({ heading: name, parentHeading: parent, existing: false, after: anchor.text, planning: true });
    }
  }
  const blockOf = (line: number) => blocks.find((b) => line >= b.headingLine && line < b.endLine);
  for (const h of headings) {
    if (h.level < 2 || researcherOnly(h.text) || blockOf(h.line)) continue;
    out.push({ heading: h.text, ...(h.parentHeading ? { parentHeading: h.parentHeading } : {}), existing: true, planning: false });
  }
  return out;
}
