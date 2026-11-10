import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { t } from '../../i18n/t';
import type { WorksheetPaperSize } from '../../../vendor/labnoteo/src/settings';
import { DialogFrame, isComposing } from '../host/DialogFrame';
import type { DialogSpec } from '../host/dialogStore';
import { coreT } from '../i18n';
import { initialWorksheetSelection, unitOpLabel, type WorksheetChoice } from '../port/worksheetPrint';
import { SelectField } from '../../ui/SelectField';

const PAPERS: readonly WorksheetPaperSize[] = ['a4', 'letter'];

/**
 * "실험 워크시트 출력" 창(플러그인 WorksheetModal 의 React 판). 유닛 오퍼레이션마다 체크박스 하나(실험실 것이 먼저 골라져
 * 있다), 용지 고르기, "브라우저에서 열기"와 "출력" 단추. 출력 단추가 처음 초점을 받는다(#325: 첫 체크박스에 초점이 가면
 * Enter 가 그 쪽을 끈다). Enter 는 초점이 "브라우저에서 열기"에 있지 않으면 출력이다. 한글 조합 중의 Enter·Escape 는
 * 아무것도 하지 않는다. 하나도 고르지 않으면 안내 줄을 보이고 닫지 않는다.
 */
export function WorksheetDialog(props: {
  spec: Extract<DialogSpec, { kind: 'worksheet' }>;
  onDone: (value: unknown) => void;
  onCancel: () => void;
}) {
  const { spec } = props;
  const id = useId();
  const print = useRef<HTMLButtonElement>(null);
  const browser = useRef<HTMLButtonElement>(null);
  const [selected, setSelected] = useState<ReadonlySet<number>>(() => new Set(initialWorksheetSelection(spec.unitOps)));
  const [paper, setPaper] = useState<WorksheetPaperSize>(spec.paper);
  const [empty, setEmpty] = useState(false);

  useEffect(() => print.current?.focus(), []);

  const toggle = (index: number, on: boolean) => {
    setEmpty(false);
    setSelected((cur) => {
      const next = new Set(cur);
      if (on) next.add(index);
      else next.delete(index);
      return next;
    });
  };

  const finish = (target: WorksheetChoice['target']) => {
    if (selected.size === 0) {
      setEmpty(true);
      return;
    }
    const indices = spec.unitOps.map((op) => op.index).filter((i) => selected.has(i));
    const choice: WorksheetChoice = { indices, paper, target };
    props.onDone(choice);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    e.stopPropagation();
    if (isComposing(e)) return;
    finish(e.target === browser.current ? 'browser' : 'print');
  };

  const hasLab = spec.unitOps.some((op) => op.kind === 'hw');
  return (
    <DialogFrame title={coreT('Print experiment worksheet')} className="worksheet" describedBy={`${id}-intro`} onCancel={props.onCancel}>
      <div className="worksheet-body" onKeyDown={onKeyDown}>
        <p id={`${id}-intro`} className="prompt-hint">
          {hasLab
            ? coreT(
                'Each unit operation starts on a new page with a QR code in two corners. Lab unit operations are selected; turn on software ones to print them too.',
              )
            : coreT(
                'Each unit operation starts on a new page with a QR code in two corners. This note has only software unit operations, so all of them are selected.',
              )}
        </p>
        <ul className="worksheet-ops">
          {spec.unitOps.map((op) => (
            <li key={op.index}>
              <label>
                <input
                  type="checkbox"
                  checked={selected.has(op.index)}
                  aria-describedby={`${id}-kind-${op.index}`}
                  onChange={(e) => toggle(op.index, e.currentTarget.checked)}
                />
                <span>{unitOpLabel(op)}</span>
              </label>
              <span id={`${id}-kind-${op.index}`} className="worksheet-kind">
                {op.kind === 'hw' ? coreT('Lab') : coreT('Software')}
              </span>
            </li>
          ))}
        </ul>
        <label className="worksheet-paper">
          <span>{coreT('Paper size')}</span>
          <SelectField value={paper} onChange={(e) => setPaper(e.currentTarget.value as WorksheetPaperSize)}>
            {PAPERS.map((p) => (
              <option key={p} value={p}>
                {p === 'a4' ? t('print.paper.a4') : t('print.paper.letter')}
              </option>
            ))}
          </SelectField>
        </label>
        {empty ? (
          <p role="alert" className="prompt-hint warn">
            {coreT('Select at least one unit operation.')}
          </p>
        ) : null}
        <div className="dialog-actions">
          <button ref={browser} type="button" onClick={() => finish('browser')}>
            {coreT('Open in browser')}
          </button>
          <button ref={print} type="button" className="primary" onClick={() => finish('print')}>
            {coreT('Print')}
          </button>
        </div>
      </div>
    </DialogFrame>
  );
}
