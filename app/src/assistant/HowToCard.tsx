import { useId } from 'react';
import { t } from '../i18n/t';
import { useLang } from '../i18n/useLang';
import { Icon } from '../ui/Icon';
import { chipLabel } from './chips';

/**
 * 사용법 칩(assistant spec §4.4): 모델을 부르지 않는 짧은 도움말. 무엇을 하는지, 칩이 어떻게 움직이는지(쓰기 전에 늘
 * 묻는다), 기록이 어디 있는지, 옮기고 숨기는 법. 단추는 관련 명령을 부른다(설정, 이 실험의 기록 지우기)와 대화 칩.
 */
export function HowToCard(props: { onChat(): void; runCommand?(id: string): void; canClear: boolean }) {
  useLang();
  const heading = useId();
  const run = props.runCommand;
  return (
    <section className="pet-howto" aria-labelledby={heading}>
      <h3 id={heading} className="pet-howto-title">
        {chipLabel('howTo')}
      </h3>
      <p>{t('howto.what')}</p>
      <p>{t('howto.chips')}</p>
      <p>{t('howto.history')}</p>
      <p>{t('howto.hide')}</p>
      <div className="pet-howto-actions">
        <button type="button" className="btn primary" onClick={props.onChat}>
          <Icon name="bot" size={14} />
          <span>{t('howto.startChat')}</span>
        </button>
        {run ? (
          <button type="button" className="btn" onClick={() => run('assistant.settings')}>
            <Icon name="settings" size={14} />
            <span>{t('howto.settings')}</span>
          </button>
        ) : null}
        {run && props.canClear ? (
          <button type="button" className="btn" onClick={() => run('assistant.clearHistory')}>
            <Icon name="eraser" size={14} />
            <span>{t('history.clear')}</span>
          </button>
        ) : null}
      </div>
    </section>
  );
}
