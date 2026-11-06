import { t } from '../i18n/t';
import type { Theme } from './useTheme';

const OPTIONS: Array<[Theme, string]> = [
  ['system', 'theme.system'],
  ['dark', 'theme.dark'],
  ['light', 'theme.light'],
];

export function ThemeToggle({ theme, onChange }: { theme: Theme; onChange: (theme: Theme) => void }) {
  return (
    <select aria-label={t('theme.label')} value={theme} onChange={(e) => onChange(e.target.value as Theme)}>
      {OPTIONS.map(([value, key]) => (
        <option key={value} value={value}>
          {t(key)}
        </option>
      ))}
    </select>
  );
}
