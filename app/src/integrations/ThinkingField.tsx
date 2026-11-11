// The thinking-mode field under "Advanced" in the AI provider part of Integration settings (2026-11-11, user report
// "AI 모델이 같은 생각을 되풀이해서 멈췄습니다"). Auto (default) lets settings thinkingFor decide: the qwen3 family
// thinks off on requests with tools; On and Off are sent as chosen (llmProvider). Saved as `llmThinking`.
import { useId } from 'react';
import { t } from '../i18n/t';
import type { ThinkingSetting } from '../labnote/settings';
import { SelectField } from '../ui/SelectField';

export interface ThinkingFieldProps {
  /** The saved `llmThinking` (undefined reads as auto). */
  value: ThinkingSetting | undefined;
  commit(patch: { llmThinking: ThinkingSetting }): Promise<void>;
}

const CHOICES: ReadonlyArray<[ThinkingSetting, () => string]> = [
  ['auto', () => t('integrations.ai.thinking.auto')],
  ['on', () => t('integrations.ai.thinking.on')],
  ['off', () => t('integrations.ai.thinking.off')],
];

export function ThinkingField(props: ThinkingFieldProps) {
  const id = useId();
  const value = props.value ?? 'auto';
  return (
    <div className="integration-field">
      <label className="prompt-question" htmlFor={`${id}-thinking`}>
        {t('integrations.ai.thinking')}
      </label>
      <SelectField
        id={`${id}-thinking`}
        value={value}
        onChange={(e) => {
          const next = e.currentTarget.value as ThinkingSetting;
          if (next !== value) void props.commit({ llmThinking: next });
        }}
      >
        {CHOICES.map(([c, label]) => (
          <option key={c} value={c}>
            {label()}
          </option>
        ))}
      </SelectField>
      <p className="prompt-hint">{t('integrations.ai.thinkingHint')}</p>
    </div>
  );
}
