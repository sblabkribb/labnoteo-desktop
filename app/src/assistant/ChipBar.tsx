import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { t } from '../i18n/t';
import { useLang } from '../i18n/useLang';
import { rovingStop } from '../ui/roving';
import { CHIP_IDS, chipLabel, type ChipId } from './chips';

/** 칩 다섯을 3 + 2 로 고르게 놓는다(줄바꿈에 맡기면 4 + 1 로 접혔다, visual QA). 화살표 순서는 그대로 CHIP_IDS 다. */
const CHIP_ROWS: readonly (readonly ChipId[])[] = [CHIP_IDS.slice(0, 3), CHIP_IDS.slice(3)];

const STEP: Readonly<Record<string, number>> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

/**
 * 말풍선의 칩 줄(assistant spec §4.2, §4.4): role="toolbar" 의 단추 다섯 개, roving tabindex(WAI-ARIA 도구 막대 패턴).
 * Tab 으로는 한 단추(처음은 고른 칩)에만 닿고, 화살표는 앞뒤로(끝에서 돌아), Home/End 는 처음과 끝으로 초점을 옮긴다.
 * 누르면(Enter/Space/클릭) 그 칩을 고른다. 고른 칩은 aria-pressed 로 알린다.
 */
export function ChipBar(props: { active: ChipId; onSelect(chip: ChipId): void }) {
  useLang();
  const [focusChip, setFocusChip] = useState<ChipId>(props.active);
  const buttons = useRef(new Map<ChipId, HTMLButtonElement>());
  useEffect(() => setFocusChip(props.active), [props.active]);
  const stop = rovingStop(CHIP_IDS, focusChip);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = CHIP_IDS.indexOf(stop ?? props.active);
    const n = CHIP_IDS.length;
    const next =
      e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : Object.hasOwn(STEP, e.key) ? (i + STEP[e.key] + n) % n : undefined;
    if (next === undefined) return;
    e.preventDefault();
    const chip = CHIP_IDS[next];
    setFocusChip(chip);
    buttons.current.get(chip)?.focus();
  };

  return (
    <div className="pet-chips" role="toolbar" aria-label={t('pet.chips')} onKeyDown={onKeyDown}>
      {CHIP_ROWS.map((row) => (
        <div key={row.join()} className="pet-chips-row">
          {row.map((chip) => (
            <button
              key={chip}
              ref={(el) => {
                if (el) buttons.current.set(chip, el);
                else buttons.current.delete(chip);
              }}
              type="button"
              className="pet-chip"
              data-chip={chip}
              aria-pressed={chip === props.active}
              tabIndex={chip === stop ? 0 : -1}
              onFocus={() => setFocusChip(chip)}
              onClick={() => props.onSelect(chip)}
            >
              {chipLabel(chip)}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
