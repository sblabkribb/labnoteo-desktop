// The context-window field in the AI provider part of Integration settings (Task 17).
// It saves `llmContextWindow` through the dialog's own save patch; parsing and clamping
// live in windowSetting.ts.
import { useId, useRef, useState } from 'react';
import { t } from '../../i18n/t';
import { SelectField } from '../../ui/SelectField';
import { WINDOW_PRESETS } from './sourcesModel';
import { isPresetWindow, parseWindowInput } from './windowSetting';

export interface ContextWindowFieldProps {
  /** The saved `llmContextWindow`. */
  value: number;
  commit(patch: { llmContextWindow: number }): Promise<void>;
}

const CUSTOM = 'custom';

export function ContextWindowField(props: ContextWindowFieldProps) {
  const id = useId();
  const savedRef = useRef(props.value);
  const [custom, setCustom] = useState(!isPresetWindow(props.value));
  const [selected, setSelected] = useState(props.value);
  const [draft, setDraftState] = useState(String(props.value));
  const draftRef = useRef(String(props.value));
  const [invalid, setInvalid] = useState(false);

  const setDraft = (v: string) => {
    draftRef.current = v;
    setDraftState(v);
  };

  const saveValue = async (n: number) => {
    setSelected(n);
    if (n === savedRef.current) return;
    savedRef.current = n;
    await props.commit({ llmContextWindow: n });
  };

  const onSelect = (v: string) => {
    setInvalid(false);
    if (v === CUSTOM) {
      setCustom(true);
      setDraft(String(savedRef.current));
      return;
    }
    setCustom(false);
    void saveValue(Number(v));
  };

  const commitCustom = async () => {
    const n = parseWindowInput(draftRef.current);
    if (n === null) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    if (String(n) !== draftRef.current) setDraft(String(n));
    await saveValue(n);
  };

  return (
    <div className="integration-field">
      <label className="prompt-question" htmlFor={`${id}-window`}>
        {t('aiCtx.window.label')}
      </label>
      <SelectField id={`${id}-window`} value={custom ? CUSTOM : String(selected)} onChange={(e) => onSelect(e.currentTarget.value)}>
        {WINDOW_PRESETS.map((n) => (
          <option key={n} value={String(n)}>
            {t('aiCtx.sources.windowOption', String(n))}
          </option>
        ))}
        <option value={CUSTOM}>{t('aiCtx.window.custom')}</option>
      </SelectField>
      {custom ? (
        <div className="integration-field-sub">
          <label className="prompt-question" htmlFor={`${id}-custom`}>
            {t('aiCtx.window.customLabel')}
          </label>
          <input
            id={`${id}-custom`}
            type="text"
            inputMode="numeric"
            autoComplete="off"
            spellCheck={false}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setInvalid(false);
            }}
            onBlur={() => void commitCustom()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void commitCustom();
              }
            }}
          />
        </div>
      ) : null}
      {invalid ? <p className="prompt-hint warn">{t('aiCtx.window.invalid')}</p> : null}
      <p className="prompt-hint">{t('aiCtx.window.hint')}</p>
    </div>
  );
}
