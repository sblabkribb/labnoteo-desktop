import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { PickItem } from '@labnoteo/core';
import { t } from '../../i18n/t';
import { rankPickItems, withSelectedFirst } from '../port/rankPickItems';
import { DialogFrame, isComposing } from './DialogFrame';
import type { DialogSpec } from './dialogStore';

/** 한 번에 그리는 줄 수. 그 뒤는 picker.more 로 "더 있다"고만 말한다. */
export const PICKER_MAX_ROWS = 200;
const PAGE = 10;

function ItemText({ item }: { item: PickItem<unknown> }) {
  return (
    <>
      <span className="picker-label">{item.label}</span>
      {item.description ? <small className="picker-desc">{item.description}</small> : null}
      {item.detail ? <small className="picker-detail">{item.detail}</small> : null}
    </>
  );
}

function MoreOrEmpty({ shown, total }: { shown: number; total: number }) {
  if (total === 0) return <p className="picker-note">{t('picker.empty')}</p>;
  if (total > shown) return <p className="picker-note">{t('picker.more', total - shown)}</p>;
  return null;
}

/** 하나 고르기: 검색 칸(combobox)과 목록(listbox). 지금 값(`selected`)이 맨 위에서 골라진 채로 열린다. */
export function Picker(props: {
  spec: Extract<DialogSpec, { kind: 'pick' }>;
  onDone: (value: unknown) => void;
  onCancel: () => void;
}) {
  const { spec } = props;
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const id = useId();
  const ranked = useMemo(
    () => withSelectedFirst(rankPickItems(spec.items, query), query, spec.selected),
    [spec.items, spec.selected, query],
  );
  const shown = ranked.slice(0, PICKER_MAX_ROWS);
  const current = Math.min(active, shown.length - 1);
  const optionId = (i: number) => `${id}-opt-${i}`;

  useEffect(() => input.current?.focus(), []);
  useEffect(() => {
    if (current < 0) return;
    const el = list.current?.children[current] as HTMLElement | undefined;
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [current]);

  const move = (delta: number) => setActive(Math.max(0, Math.min(shown.length - 1, current + delta)));
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (isComposing(e)) return;
    const step = { ArrowDown: 1, ArrowUp: -1, PageDown: PAGE, PageUp: -PAGE }[e.key];
    if (step !== undefined) {
      e.preventDefault();
      move(step);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (current >= 0) props.onDone(shown[current].value);
    }
  };

  return (
    <DialogFrame title={spec.title} className="picker" onCancel={props.onCancel}>
      <input
        ref={input}
        type="text"
        role="combobox"
        aria-label={t('picker.label')}
        aria-expanded="true"
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        aria-activedescendant={current >= 0 ? optionId(current) : undefined}
        placeholder={spec.placeholder}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
      />
      <ul ref={list} id={`${id}-list`} role="listbox" aria-label={spec.title ?? t('picker.label')} className="picker-list">
        {shown.map((item, i) => (
          <li
            key={i}
            id={optionId(i)}
            role="option"
            aria-selected={i === current}
            className={item.dimmed ? 'picker-option dimmed' : 'picker-option'}
            onMouseDown={(e) => e.preventDefault()}
            onMouseMove={() => i !== current && setActive(i)}
            onClick={() => props.onDone(item.value)}
          >
            <ItemText item={item} />
          </li>
        ))}
      </ul>
      <MoreOrEmpty shown={shown.length} total={ranked.length} />
    </DialogFrame>
  );
}

/**
 * 여러 개 고르기: 검색 칸 아래 체크 상자 목록. 검색 칸에서 아래 화살표로 목록에 들어가 Space 로 체크하고(검색 칸의 빈칸은 글자다),
 * Enter 나 확인 단추로 체크한 것을 원래 순서로 돌려준다. 걸러서 안 보이는 항목의 체크도 남는다.
 */
export function PickManyDialog(props: {
  spec: Extract<DialogSpec, { kind: 'pickMany' }>;
  onDone: (value: unknown) => void;
  onCancel: () => void;
}) {
  const { spec } = props;
  const [query, setQuery] = useState('');
  const [checked, setChecked] = useState<ReadonlySet<number>>(
    () => new Set(spec.items.flatMap((item, i) => (item.checked ? [i] : []))),
  );
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const id = useId();
  const indexOf = useMemo(() => new Map(spec.items.map((item, i) => [item, i])), [spec.items]);
  const ranked = useMemo(() => rankPickItems(spec.items, query), [spec.items, query]);
  const shown = ranked.slice(0, PICKER_MAX_ROWS);

  useEffect(() => input.current?.focus(), []);

  const boxes = () => [...(list.current?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]') ?? [])];
  const toggle = (index: number) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (!next.delete(index)) next.add(index);
      return next;
    });
  const submit = () => props.onDone([...checked].sort((a, b) => a - b).map((i) => spec.items[i].value));

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (isComposing(e)) return;
    const target = e.target as HTMLElement;
    const inSearch = target === input.current;
    const all = boxes();
    const at = all.indexOf(target as HTMLInputElement);
    if (!inSearch && at < 0) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      all[inSearch ? 0 : Math.min(all.length - 1, at + 1)]?.focus();
    } else if (e.key === 'ArrowUp' && !inSearch) {
      e.preventDefault();
      (at === 0 ? input.current : all[at - 1])?.focus();
    }
  };

  return (
    <DialogFrame title={spec.title} className="picker" onCancel={props.onCancel}>
      <div className="picker-body" onKeyDown={onKeyDown}>
        <input
          ref={input}
          type="text"
          role="combobox"
          aria-label={t('picker.label')}
          aria-expanded="true"
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          placeholder={spec.placeholder}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <ul ref={list} id={`${id}-list`} role="group" aria-label={spec.title ?? t('picker.label')} className="picker-list">
          {shown.map((item) => {
            const index = indexOf.get(item) ?? -1;
            return (
              <li key={index} className={item.dimmed ? 'picker-option dimmed' : 'picker-option'}>
                <label>
                  <input type="checkbox" checked={checked.has(index)} onChange={() => toggle(index)} />
                  <ItemText item={item} />
                </label>
              </li>
            );
          })}
        </ul>
        <MoreOrEmpty shown={shown.length} total={ranked.length} />
      </div>
      <div className="dialog-actions">
        <button type="button" className="primary" onClick={submit}>
          {t('dialog.ok')}
        </button>
        <button type="button" onClick={props.onCancel}>
          {t('dialog.cancel')}
        </button>
      </div>
    </DialogFrame>
  );
}
