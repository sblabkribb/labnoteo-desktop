import { Fragment, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
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

/** 카탈로그 코드가 앞에 붙은 이름(`WB030: DNA Assembly`). */
const CODE = /^([A-Za-z]{1,4}\d{2,4}[A-Za-z]?)\s*:\s*(.*)$/;
/** "최근" 묶음에 두는 가장 많은 수. */
export const PICKER_RECENT_MAX = 5;
const RECENT_PREFIX = 'labnoteo.recent.';

/** 최근 고른 항목의 열쇠(코드, 없으면 이름). 저장소가 없거나 깨졌으면 빈 목록. */
function readRecent(key: string): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(RECENT_PREFIX + key) ?? '[]');
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function writeRecent(key: string, id: string): void {
  try {
    const next = [id, ...readRecent(key).filter((v) => v !== id)].slice(0, PICKER_RECENT_MAX);
    localStorage.setItem(RECENT_PREFIX + key, JSON.stringify(next));
  } catch {
    // 저장소를 쓸 수 없다(사생활 창 등): 최근 목록 없이 쓴다
  }
}

const itemKey = (item: PickItem<unknown>) => CODE.exec(item.label)?.[1] ?? item.label;

/** 카탈로그 행: 고정폭 코드, 영어 이름, 흐린 한 줄 설명. 상세 줄은 고른 행에만. */
function CatalogText({ item, active }: { item: PickItem<unknown>; active: boolean }) {
  const m = CODE.exec(item.label);
  return (
    <>
      {m ? <span className="picker-code">{m[1]}</span> : null}
      <span className="picker-label">{m ? m[2] : item.label}</span>
      {item.description ? <small className="picker-desc">{item.description}</small> : null}
      {active && item.detail ? <small className="picker-detail">{item.detail}</small> : null}
    </>
  );
}

/**
 * 보이는 차례와 묶음 머리. 검색어가 있으면 순위 그대로(머리 없음). 없으면 최근 고른 것을 맨 위 "최근" 묶음에, 나머지는
 * groupOf 의 묶음(처음 나온 차례)으로 모은다.
 */
function arrange(
  ranked: PickItem<unknown>[],
  query: string,
  recent: readonly string[],
  groupOf: ((item: PickItem<unknown>) => string | undefined) | undefined,
): { items: PickItem<unknown>[]; heads: Map<number, string> } {
  const heads = new Map<number, string>();
  if (query.trim() || (!groupOf && recent.length === 0)) return { items: ranked, heads };
  const recentItems = recent.flatMap((id) => ranked.filter((item) => itemKey(item) === id).slice(0, 1));
  const rest = ranked.filter((item) => !recentItems.includes(item));
  const order: string[] = [];
  const byGroup = new Map<string, PickItem<unknown>[]>();
  for (const item of rest) {
    const g = groupOf?.(item) ?? '';
    if (!byGroup.has(g)) {
      order.push(g);
      byGroup.set(g, []);
    }
    byGroup.get(g)!.push(item);
  }
  const items = [...recentItems];
  if (recentItems.length > 0) heads.set(0, t('picker.recent'));
  for (const g of order) {
    if (g) heads.set(items.length, g);
    items.push(...byGroup.get(g)!);
  }
  return { items, heads };
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
  const [query, setQuery] = useState(spec.query ?? '');
  const [active, setActive] = useState(0);
  // 연 순간의 최근 목록: 고르는 동안 바뀌지 않는다
  const [recent] = useState(() => (spec.recentKey ? readRecent(spec.recentKey) : []));
  const input = useRef<HTMLInputElement>(null);
  const optionEls = useRef<(HTMLLIElement | null)[]>([]);
  const id = useId();
  const { items: ranked, heads } = useMemo(
    () => arrange(withSelectedFirst(rankPickItems(spec.items, query), query, spec.selected), query, recent, spec.groupOf),
    [spec.items, spec.selected, spec.groupOf, query, recent],
  );
  const shown = ranked.slice(0, PICKER_MAX_ROWS);
  const current = Math.min(active, shown.length - 1);
  const optionId = (i: number) => `${id}-opt-${i}`;

  useEffect(() => input.current?.focus(), []);
  useEffect(() => {
    if (current < 0) return;
    optionEls.current[current]?.scrollIntoView?.({ block: 'nearest' });
  }, [current]);

  const choose = (item: PickItem<unknown>) => {
    if (spec.recentKey) writeRecent(spec.recentKey, itemKey(item));
    props.onDone(item.value);
  };
  const move = (delta: number) => setActive(Math.max(0, Math.min(shown.length - 1, current + delta)));
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (isComposing(e)) return;
    const step = { ArrowDown: 1, ArrowUp: -1, PageDown: PAGE, PageUp: -PAGE }[e.key];
    if (step !== undefined) {
      e.preventDefault();
      move(step);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (current >= 0) choose(shown[current]);
    }
  };

  return (
    <DialogFrame title={spec.title} className={spec.catalog ? 'picker catalog' : 'picker'} onCancel={props.onCancel} unsolicited={spec.unsolicited}>
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
          spec.onQuery?.(e.target.value);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
      />
      <ul id={`${id}-list`} role="listbox" aria-label={spec.title ?? t('picker.list')} className="picker-list">
        {shown.map((item, i) => (
          <Fragment key={i}>
            {heads.has(i) ? (
              <li role="presentation" aria-hidden="true" className="picker-group">
                {heads.get(i)}
              </li>
            ) : null}
            <li
              ref={(el) => {
                optionEls.current[i] = el;
              }}
              id={optionId(i)}
              role="option"
              aria-selected={i === current}
              className={item.dimmed ? 'picker-option dimmed' : 'picker-option'}
              onMouseDown={(e) => e.preventDefault()}
              onMouseMove={() => i !== current && setActive(i)}
              onClick={() => choose(item)}
            >
              {spec.catalog ? <CatalogText item={item} active={i === current} /> : <ItemText item={item} />}
            </li>
          </Fragment>
        ))}
      </ul>
      <MoreOrEmpty shown={shown.length} total={ranked.length} />
    </DialogFrame>
  );
}

/**
 * 여러 개 고르기: 검색 칸(searchbox: 팝업을 여는 combobox 가 아니다) 아래 체크 상자 목록(group). 검색 칸에서 아래 화살표로 목록에 들어가 Space 로 체크하고(검색 칸의 빈칸은 글자다),
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
          role="searchbox"
          aria-label={t('picker.label')}
          placeholder={spec.placeholder}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <ul ref={list} role="group" aria-label={spec.title ?? t('picker.list')} className="picker-list">
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
