import { t } from './t';
import { LANG_NAMES, LANGS, type Lang } from './lang';
import { SelectMenu } from '../ui/SelectMenu';

/** 테마 고르기 옆의 언어 고르기. 이름표는 지금 언어로, 선택지는 각자 자기 언어로 적는다(lang 을 붙여 낭독기가 그 언어로 읽는다). */
export function LanguageToggle({ lang, onChange }: { lang: Lang; onChange: (lang: Lang) => void }) {
  return (
    <SelectMenu<Lang>
      label={t('lang.label')}
      value={lang}
      onChange={onChange}
      options={LANGS.map((l) => ({ value: l, label: LANG_NAMES[l], lang: l }))}
    />
  );
}
