import { t } from '../../i18n/t';

/** 설정 → 정보: 앱 이름과 버전, 라이선스, 제3자 고지(Lucide, ISC). 전문은 저장소의 THIRD_PARTY_NOTICES.md 에 있다. */
export function AboutPage(props: { version: string }) {
  return (
    <div className="settings-about">
      <p className="settings-about-name">{t('app.title')}</p>
      {props.version ? <p className="settings-about-version">{t('settings.about.version', props.version)}</p> : null}
      <p>{t('settings.about.license')}</p>
      <h4>{t('settings.about.notices')}</h4>
      <ul>
        <li>{t('settings.about.lucide')}</li>
      </ul>
      <p className="setting-desc">{t('settings.about.noticesFile')}</p>
    </div>
  );
}
