import { t } from '../i18n/t';
import { Segmented } from '../ui/Segmented';
import type { Theme } from './useTheme';

const OPTIONS: Array<[Theme, string]> = [
  ['system', 'appearance.system'],
  ['light', 'appearance.light'],
  ['dark', 'appearance.dark'],
];

/** 보관함을 고르는 첫 화면의 테마 고르기: 모양 팝오버와 같은 세 칸 단추 줄(네이티브 select 를 쓰지 않는다). */
export function ThemeToggle({ theme, onChange }: { theme: Theme; onChange: (theme: Theme) => void }) {
  return (
    <Segmented<Theme>
      label={t('theme.label')}
      value={theme}
      onChange={onChange}
      options={OPTIONS.map(([value, key]) => ({ value, label: t(key) }))}
    />
  );
}
