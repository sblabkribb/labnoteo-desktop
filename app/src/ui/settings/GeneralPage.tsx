import { useState } from 'react';
import { t } from '../../i18n/t';
import { LANG_NAMES, LANGS, setLang, type Lang } from '../../i18n/lang';
import { useLang } from '../../i18n/useLang';
import type { Theme } from '../../theme/useTheme';
import { layoutStore, useLayout, type Density } from '../layoutStore';
import { Segmented } from '../Segmented';
import { SelectMenu } from '../SelectMenu';
import { SettingRow, Toggle } from './SettingRow';

/** 설정 → 일반: 테마, 언어, 줄 간격, 시스템 파일 표시. 테마는 이 PC 의 저장소, 나머지 둘은 ui.json(layoutStore)에 산다. */
export function GeneralPage(props: { theme: Theme; setTheme: (theme: Theme) => void }) {
  const lang = useLang();
  const layout = useLayout();
  const [theme, setThemeState] = useState<Theme>(props.theme);
  const chooseTheme = (next: Theme) => {
    setThemeState(next);
    props.setTheme(next);
  };
  return (
    <>
      <SettingRow
        label={t('theme.label')}
        description={t('settings.theme.desc')}
        control={
          <Segmented<Theme>
            label={t('theme.label')}
            value={theme}
            onChange={chooseTheme}
            options={[
              { value: 'system', label: t('appearance.system') },
              { value: 'light', label: t('appearance.light') },
              { value: 'dark', label: t('appearance.dark') },
            ]}
          />
        }
      />
      <SettingRow
        label={t('lang.label')}
        description={t('settings.lang.desc')}
        control={
          <SelectMenu<Lang>
            label={t('lang.label')}
            value={lang}
            onChange={setLang}
            options={LANGS.map((l) => ({ value: l, label: LANG_NAMES[l], lang: l }))}
          />
        }
      />
      <SettingRow
        label={t('settings.density')}
        description={t('settings.density.desc')}
        control={
          <Segmented<Density>
            label={t('settings.density')}
            value={layout.density}
            onChange={(density) => layoutStore.update({ density })}
            options={[
              { value: 'comfortable', label: t('settings.density.comfortable') },
              { value: 'compact', label: t('settings.density.compact') },
            ]}
          />
        }
      />
      <SettingRow
        label={t('settings.systemFiles')}
        description={t('settings.systemFiles.desc')}
        control={
          <Toggle
            label={t('settings.systemFiles')}
            checked={layout.showSystemFiles}
            onChange={(showSystemFiles) => layoutStore.update({ showSystemFiles })}
          />
        }
      />
    </>
  );
}
