// The max-output-tokens field under "Advanced" in the AI provider part of Integration settings (real-server check,
// 2026-11-11: with no cap a looping request ran for the whole 300 s LLM_TIMEOUT). Blank lets each task set its own
// cap (llmProvider outputTokens: tool turns 4096, text 8192, history summary 2048); a whole number from 256 is sent
// with every request of this vault. Either way the context window minus the prompt bounds it. Saved as
// `llmMaxOutputTokens`.
import { useId, useRef, useState } from 'react';
import { t } from '../i18n/t';
import { parseMaxOutputTokensInput } from '../labnote/settings';

export interface MaxOutputFieldProps {
  /** The saved `llmMaxOutputTokens` (null = blank). */
  value: number | null | undefined;
  commit(patch: { llmMaxOutputTokens: number | null }): Promise<void>;
}

export function MaxOutputField(props: MaxOutputFieldProps) {
  const id = useId();
  const savedRef = useRef<number | null>(props.value ?? null);
  const [draft, setDraft] = useState(props.value == null ? '' : String(props.value));
  const draftRef = useRef(draft);
  const [invalid, setInvalid] = useState(false);

  const commit = async () => {
    const n = parseMaxOutputTokensInput(draftRef.current);
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
    await props.commit({ llmMaxOutputTokens: n });
  };

  return (
    <div className="integration-field">
      <label className="prompt-question" htmlFor={`${id}-max-output`}>
        {t('integrations.ai.maxOutput')}
      </label>
      <input
        id={`${id}-max-output`}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        spellCheck={false}
        placeholder={t('integrations.ai.maxOutputPlaceholder')}
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
      {invalid ? <p className="prompt-hint warn">{t('integrations.ai.maxOutputInvalid')}</p> : null}
      <p className="prompt-hint">{t('integrations.ai.maxOutputHint')}</p>
    </div>
  );
}
