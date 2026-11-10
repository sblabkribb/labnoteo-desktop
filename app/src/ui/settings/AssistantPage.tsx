import { t } from '../../i18n/t';
import { useLang } from '../../i18n/useLang';
import { layoutStore, useLayout } from '../layoutStore';
import { Segmented } from '../Segmented';
import { SettingRow, Toggle } from './SettingRow';

/**
 * 설정 → 어시스턴트(assistant 명세 §10.1). 이 PC 의 ui.json(layoutStore 의 pet)에 산다. 줄은 그 기능이 동작하게 되는 작업에서
 * 하나씩 늘어난다: 지금은 보이기와 크기(정수 배율 2·3)뿐이다.
 */
export function AssistantPage() {
  useLang();
  const { pet } = useLayout();
  return (
    <>
      <SettingRow
        label={t('settings.assistant.show')}
        description={t('settings.assistant.show.desc')}
        control={<Toggle label={t('settings.assistant.show')} checked={!pet.hidden} onChange={(on) => layoutStore.setPet({ hidden: !on })} />}
      />
      <SettingRow
        label={t('settings.assistant.size')}
        description={t('settings.assistant.size.desc')}
        control={
          <Segmented<'2' | '3'>
            label={t('settings.assistant.size')}
            value={pet.scale === 3 ? '3' : '2'}
            onChange={(v) => layoutStore.setPet({ scale: v === '3' ? 3 : 2 })}
            options={[
              { value: '2', label: t('settings.assistant.size.2') },
              { value: '3', label: t('settings.assistant.size.3') },
            ]}
          />
        }
      />
    </>
  );
}
