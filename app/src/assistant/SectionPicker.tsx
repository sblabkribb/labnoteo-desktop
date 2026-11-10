import { listUnitOpBlocks } from '@labnoteo/core';
import { useId, useState } from 'react';
import { findSectionMatches, listHeadings } from '../../vendor/labnoteo/packages/labnoteo-core/src/sections/sectionEdit';
import { t } from '../i18n/t';
import { useLang } from '../i18n/useLang';
import { canonicalSection, RESEARCHER_ONLY_SECTIONS, type UnitOpKind } from '../labnote/context/chain';
import { draftableSectionsFor } from '../labnote/context/planningPrompt';

/** "섹션 만들기" 의 대상 하나. `existing` 이면 update_section, 아니면 add_section(`after` 뒤에)으로 쓴다. */
export interface SectionChoice {
  heading: string;
  parentHeading?: string;
  existing: boolean;
  /** 새 섹션을 넣을 자리: 이 제목(노트에 하나뿐인 것) 바로 뒤. */
  after?: string;
}

export interface SectionOption extends SectionChoice {
  /** 커서가 있는 단위 공정의 계획 섹션(draftableSections). */
  planning: boolean;
}

const kindOf = (opId: string): UnitOpKind => (opId.startsWith('UHW') ? 'hw' : opId.startsWith('USW') ? 'sw' : 'unknown');
const researcherOnly = (heading: string): boolean => {
  const canon = canonicalSection(heading);
  return !!canon && RESEARCHER_ONLY_SECTIONS.includes(canon);
};

/**
 * 열린 노트에서 고를 수 있는 섹션(assistant spec §4.4): 커서(`cursorLine`, 0부터)가 단위 공정 안이면 그 공정의 계획
 * 섹션이 먼저(있는 것은 그 제목 그대로, 없는 것은 새 섹션으로; 넣을 자리가 노트에서 하나로 정해지지 않으면 빼고),
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

const NEW = 'new';

function choiceOf(o: SectionOption): SectionChoice {
  return {
    heading: o.heading,
    ...(o.parentHeading ? { parentHeading: o.parentHeading } : {}),
    existing: o.existing,
    ...(o.after ? { after: o.after } : {}),
  };
}

/**
 * "어떤 섹션?" 고르기: 목록(네이티브 select, 키보드와 읽기 프로그램이 그대로 쓴다)과 끝의 "새 제목…". 새 제목을 고르면
 * 제목 칸이 나온다. 고른 것이 바뀔 때마다 `onChange`(고르지 않았거나 새 제목이 비면 null).
 */
export function SectionPicker(props: { options: SectionOption[]; value: SectionChoice | null; onChange(c: SectionChoice | null): void }) {
  useLang();
  const id = useId();
  const [picked, setPicked] = useState('');
  const [title, setTitle] = useState('');
  const label = (o: SectionOption): string => {
    const base = o.parentHeading && o.planning ? `${o.heading} · ${o.parentHeading}` : o.heading;
    return o.existing ? base : t('section.missing', base);
  };
  const onSelect = (value: string) => {
    setPicked(value);
    if (value === NEW) {
      const h = title.trim();
      props.onChange(h ? { heading: h, existing: false } : null);
      return;
    }
    const o = value === '' ? undefined : props.options[Number(value)];
    props.onChange(o ? choiceOf(o) : null);
  };
  const onTitle = (value: string) => {
    setTitle(value);
    const h = value.replace(/[\r\n]+/g, ' ').trim();
    props.onChange(h ? { heading: h, existing: false } : null);
  };
  return (
    <div className="pet-field">
      <label className="pet-field-label" htmlFor={`${id}-section`}>
        {t('section.pick')}
      </label>
      <select id={`${id}-section`} className="pet-select" value={picked} onChange={(e) => onSelect(e.target.value)}>
        <option value="" disabled>
          {t('section.choose')}
        </option>
        {props.options.map((o, i) => (
          <option key={`${i}:${o.parentHeading ?? ''}:${o.heading}`} value={String(i)}>
            {label(o)}
          </option>
        ))}
        <option value={NEW}>{t('section.new')}</option>
      </select>
      {picked === NEW ? (
        <>
          <label className="pet-field-label" htmlFor={`${id}-title`}>
            {t('section.newTitle')}
          </label>
          <input
            id={`${id}-title`}
            className="pet-input"
            type="text"
            value={title}
            maxLength={200}
            onChange={(e) => onTitle(e.target.value)}
          />
        </>
      ) : null}
    </div>
  );
}
