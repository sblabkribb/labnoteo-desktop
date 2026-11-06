import { t } from './t';
import { isLang, LANG_NAMES, LANGS, type Lang } from './lang';

/** 테마 선택 옆의 언어 선택. 이름표는 지금 언어로, 선택지는 각자 자기 언어로 적는다(lang 을 붙여 낭독기가 그 언어로 읽는다). */
export function LanguageToggle({ lang, onChange }: { lang: Lang; onChange: (lang: Lang) => void }) {
  return (
    <select aria-label={t('lang.label')} value={lang} onChange={(e) => isLang(e.target.value) && onChange(e.target.value)}>
      {LANGS.map((l) => (
        <option key={l} value={l} lang={l}>
          {LANG_NAMES[l]}
        </option>
      ))}
    </select>
  );
}
