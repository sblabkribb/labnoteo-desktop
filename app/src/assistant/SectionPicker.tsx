import { useId, useState } from 'react';
import { t } from '../i18n/t';
import { useLang } from '../i18n/useLang';

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

const NEW = 'new';

/** The text of one choice in the list (a missing section says so). The desktop pet shows the same text. */
export function sectionLabel(o: SectionOption): string {
  const base = o.parentHeading && o.planning ? `${o.heading} · ${o.parentHeading}` : o.heading;
  return o.existing ? base : t('section.missing', base);
}

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
            {sectionLabel(o)}
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
