// The temperature field under "Advanced" in the AI provider part of Integration settings (real-server check,
// 2026-11-11: thinking models such as qwen3 loop at the app's 0.2). Blank keeps each request's own value, as
// before; a number 0-2 replaces it for every request of this vault (llmProvider temperatureOf).
import { useId, useRef, useState } from 'react';
import { t } from '../i18n/t';
import { parseTemperatureInput } from '../labnote/settings';

export interface TemperatureFieldProps {
  /** The saved `llmTemperature` (null = blank). */
  value: number | null | undefined;
  commit(patch: { llmTemperature: number | null }): Promise<void>;
}

export function TemperatureField(props: TemperatureFieldProps) {
  const id = useId();
  const savedRef = useRef<number | null>(props.value ?? null);
  const [draft, setDraft] = useState(props.value == null ? '' : String(props.value));
  const draftRef = useRef(draft);
  const [invalid, setInvalid] = useState(false);

  const commit = async () => {
    const n = parseTemperatureInput(draftRef.current);
    if (n === 'invalid') {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    const shown = n === null ? '' : String(n);
    if (shown !== draftRef.current) {
      draftRef.current = shown;
      setDraft(shown);
    }
    if (n === savedRef.current) return;
    savedRef.current = n;
    await props.commit({ llmTemperature: n });
  };

  return (
    <div className="integration-field">
      <label className="prompt-question" htmlFor={`${id}-temperature`}>
        {t('integrations.ai.temperature')}
      </label>
      <input
        id={`${id}-temperature`}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        placeholder={t('integrations.ai.temperaturePlaceholder')}
        value={draft}
        aria-invalid={invalid || undefined}
        onChange={(e) => {
          draftRef.current = e.target.value;
          setDraft(e.target.value);
          setInvalid(false);
        }}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void commit();
          }
        }}
      />
      {invalid ? <p className="prompt-hint warn">{t('integrations.ai.temperatureInvalid')}</p> : null}
      <p className="prompt-hint">{t('integrations.ai.temperatureHint')}</p>
    </div>
  );
}
