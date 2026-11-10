import { useEffect, useId, useRef, type KeyboardEvent } from 'react';
import { t } from '../i18n/t';
import { useLang } from '../i18n/useLang';
import { Icon } from '../ui/Icon';

/**
 * 도우미의 말풍선(assistant 명세 §4.2): 모달이 아닌 대화상자(role="dialog", aria-modal="false"), 머리글이 이름이다.
 * DialogFrame 은 늘 모달(aria-modal="true")이라 쓰지 않는다. 지금은 인사와 숨기기·닫기만 있다: 칩, 대화 기록, 입력 칸은
 * 그 기능이 동작하는 작업에서 붙는다(빈 조작을 미리 보이지 않는다). Esc 는 닫고 초점을 돌려준다(PetLayer 가 정한다).
 */
export function Bubble(props: { id: string; onClose: () => void; onHide: () => void }) {
  useLang();
  const heading = useId();
  const root = useRef<HTMLDivElement>(null);
  // 열리면 초점을 말풍선 안으로(나중에는 입력 칸). 마우스로 열어도 같다: 열자마자 키보드로 이어 쓸 수 있다.
  useEffect(() => {
    root.current?.querySelector<HTMLElement>('button')?.focus();
  }, []);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape' || e.nativeEvent.isComposing) return;
    e.preventDefault();
    e.stopPropagation();
    props.onClose();
  };
  return (
    <div ref={root} id={props.id} className="pet-bubble" role="dialog" aria-modal="false" aria-labelledby={heading} onKeyDown={onKeyDown}>
      <div className="pet-bubble-head">
        <h2 id={heading} className="pet-bubble-title">
          {t('pet.title')}
        </h2>
        <button type="button" className="ibtn pet-bubble-close" aria-label={t('pet.close')} title={t('pet.close')} onClick={props.onClose}>
          <Icon name="x" size={16} />
        </button>
      </div>
      <p className="pet-bubble-greeting">{t('pet.greeting')}</p>
      <div className="pet-bubble-foot">
        <button type="button" className="btn pet-bubble-hide" onClick={props.onHide}>
          <Icon name="eye-off" size={14} />
          <span>{t('pet.hide')}</span>
        </button>
      </div>
    </div>
  );
}
