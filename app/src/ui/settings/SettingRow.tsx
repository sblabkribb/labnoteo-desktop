import { useId, type ReactNode } from 'react';

/**
 * 설정 창의 한 줄(Obsidian 의 설정 줄): 왼쪽에 이름과 설명, 오른쪽에 조작. 조작의 이름은 부르는 쪽이 aria-label 로 준다
 * (Segmented·SelectMenu·Toggle 은 label 을 받는다). 설명은 이 줄의 그룹이 aria-describedby 로 읽힌다.
 */
export function SettingRow(props: { label: string; description?: ReactNode; control: ReactNode }) {
  const id = useId();
  return (
    <div className="setting-row" role="group" aria-labelledby={`${id}-name`} aria-describedby={props.description ? `${id}-desc` : undefined}>
      <div className="setting-info">
        <div className="setting-name" id={`${id}-name`}>
          {props.label}
        </div>
        {props.description ? (
          <div className="setting-desc" id={`${id}-desc`}>
            {props.description}
          </div>
        ) : null}
      </div>
      <div className="setting-control">{props.control}</div>
    </div>
  );
}

/** 켜기·끄기 스위치: `button[role=switch]`. Space·Enter 와 클릭이 바꾼다(단추의 기본 동작). */
export function Toggle(props: { checked: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      className="toggle"
      aria-checked={props.checked}
      aria-label={props.label}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
    >
      <span className="toggle-knob" aria-hidden="true" />
    </button>
  );
}
