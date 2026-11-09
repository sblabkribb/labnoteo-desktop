import { useEffect, useRef, useState } from 'react';
import { coreT } from '../labnote/i18n';
import { DialogFrame } from '../labnote/host/DialogFrame';
import type { DialogSpec } from '../labnote/host/dialogStore';
import { OPEN_USAGE_GROUPS, SAMPLE_ACTION_LABEL, type SampleDefinitionAction, type SampleDefinitionResult, type UsageGroup } from '../labnote/port/sampleDefinitionModel';

type Usages = { state: 'loading' } | { state: 'failed' } | { state: 'done'; groups: UsageGroup[] };

/**
 * 샘플 정의 창(plan SP5 Task 23, vendor sampleDefinitionModal.ts 의 화면). 모델의 줄, 카탈로그의 읽기 전용 문장, 사용처,
 * 그리고 단추를 그린다. 순수한 화면이다: 단추는 고른 동작을, 사용처 링크는 열 자리를 돌려줄 뿐이고(D16) 흐름은 명령이 돌린다.
 * 사용처는 창이 열린 뒤에 채워진다. 실험 묶음은 처음 OPEN_USAGE_GROUPS 개만 펼친다.
 */
export function SampleDefinitionDialog(props: {
  spec: Extract<DialogSpec, { kind: 'sampleDefinition' }>;
  onDone: (value: SampleDefinitionResult) => void;
  onCancel: () => void;
}) {
  const { model, usages } = props.spec;
  const [loaded, setLoaded] = useState<Usages>({ state: 'loading' });
  const close = useRef<HTMLButtonElement>(null);

  useEffect(() => close.current?.focus(), []);

  useEffect(() => {
    let live = true;
    usages.then(
      (groups) => live && setLoaded({ state: 'done', groups }),
      (err: unknown) => {
        console.warn('[labnoteo] sample usages failed:', err);
        if (live) setLoaded({ state: 'failed' });
      },
    );
    return () => {
      live = false;
    };
  }, [usages]);

  const label = (a: SampleDefinitionAction) => (a === 'moveGlobal' || a === 'moveLocal') && model.move ? model.move.label : coreT(SAMPLE_ACTION_LABEL[a]);

  return (
    <DialogFrame title={model.title} className="sample-def" onCancel={props.onCancel}>
      <div className="sample-def-body">
        <dl className="sample-def-rows">
          {model.rows.map((row, i) => (
            <div key={i} className="sample-def-row">
              <dt>{row.label}</dt>
              <dd>
                <span className="sample-def-value">{row.value}</span>
                {row.sources && row.sources.length > 0 && (
                  <span className="sample-def-from">{`${coreT('From')} ${row.sources.join(', ')}`}</span>
                )}
              </dd>
            </div>
          ))}
        </dl>
        <section className="sample-def-section">
          <h3>{coreT('Usages')}</h3>
          <div className="sample-def-usages">
            {loaded.state === 'loading' && <p>{coreT('Loading…')}</p>}
            {loaded.state === 'failed' && <p>{coreT('Could not list the usages.')}</p>}
            {loaded.state === 'done' && loaded.groups.length === 0 && <p>{coreT('{0} is not used in any note.', model.id)}</p>}
            {loaded.state === 'done' &&
              loaded.groups.map((group, i) => (
                <details key={i} className="sample-def-usage-group" open={i < OPEN_USAGE_GROUPS}>
                  <summary>
                    {`${group.experiment || coreT('Outside experiments')} (${coreT('{0} note(s)', String(new Set(group.spots.map((s) => s.path)).size))})`}
                  </summary>
                  <ul>
                    {group.spots.map((spot, j) => (
                      <li key={j}>
                        <button
                          type="button"
                          className="sample-def-link"
                          onClick={() => props.onDone({ open: { path: spot.path, line: spot.line, ...(spot.ch !== undefined ? { ch: spot.ch } : {}) } })}
                        >
                          {spot.label}
                        </button>
                      </li>
                    ))}
                  </ul>
                </details>
              ))}
          </div>
        </section>
        {model.notice && <p className="sample-def-notice">{model.notice}</p>}
      </div>
      <div className="dialog-actions sample-def-actions">
        {model.actions.map((a) => (
          <button key={a} type="button" className={a === 'edit' ? 'primary' : a === 'delete' ? 'danger' : undefined} onClick={() => props.onDone({ action: a })}>
            {label(a)}
          </button>
        ))}
        <button ref={close} type="button" onClick={props.onCancel}>
          {coreT('Close')}
        </button>
      </div>
    </DialogFrame>
  );
}
