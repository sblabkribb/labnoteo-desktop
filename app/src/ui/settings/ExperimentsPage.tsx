import { useState } from 'react';
import { t } from '../../i18n/t';
import { cleanExperimenter, EXPERIMENTER_MAX, type AppSettings } from '../../labnote/settings';
import { SettingRow, Toggle } from './SettingRow';

type Switches = Pick<AppSettings, 'autoSyncUnitOpToc' | 'autoUpdateLastUpdated'>;

/**
 * 설정 → 실험·워크플로: 기본 실험자(새 실험 대화상자가 미리 채운다), UO 목차 자동 동기화, 마지막 수정일 자동 기록.
 * 뒤의 둘은 플러그인 설정 키 그대로다(이미 저장되고 있었고, 이제 보인다). 스위치는 바로, 이름 칸은 떠날 때(또는 Enter) 저장한다.
 */
export function ExperimentsPage(props: { settings: AppSettings; update: (patch: Partial<AppSettings>) => Promise<void> }) {
  const [switches, setSwitches] = useState<Switches>({
    autoSyncUnitOpToc: props.settings.autoSyncUnitOpToc,
    autoUpdateLastUpdated: props.settings.autoUpdateLastUpdated,
  });
  const [name, setName] = useState(props.settings.defaultExperimenter);
  const [saved, setSaved] = useState(props.settings.defaultExperimenter);
  const flip = (key: keyof Switches) => (next: boolean) => {
    setSwitches((s) => ({ ...s, [key]: next }));
    void props.update({ [key]: next });
  };
  const commitName = () => {
    const clean = cleanExperimenter(name);
    setName(clean);
    if (clean === saved) return;
    setSaved(clean);
    void props.update({ defaultExperimenter: clean });
  };
  return (
    <>
      <SettingRow
        label={t('settings.experimenter')}
        description={t('settings.experimenter.desc')}
        control={
          <input
            type="text"
            className="setting-text"
            aria-label={t('settings.experimenter')}
            autoComplete="off"
            spellCheck={false}
            maxLength={EXPERIMENTER_MAX}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || e.nativeEvent.isComposing || e.keyCode === 229) return;
              e.preventDefault();
              commitName();
            }}
          />
        }
      />
      <SettingRow
        label={t('settings.autoToc')}
        description={t('settings.autoToc.desc')}
        control={<Toggle label={t('settings.autoToc')} checked={switches.autoSyncUnitOpToc} onChange={flip('autoSyncUnitOpToc')} />}
      />
      <SettingRow
        label={t('settings.autoUpdated')}
        description={t('settings.autoUpdated.desc')}
        control={<Toggle label={t('settings.autoUpdated')} checked={switches.autoUpdateLastUpdated} onChange={flip('autoUpdateLastUpdated')} />}
      />
    </>
  );
}
