import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { t } from '../i18n/t';
import { useLang } from '../i18n/useLang';
import { Icon } from '../ui/Icon';
import { MessageView, type BubbleActions } from './MessageView';
import type { UseAssistantSession } from './useAssistantSession';

/** IME 조합 중의 키(한글 입력의 Enter 는 글자를 확정할 뿐 보내지 않는다). */
function composing(e: KeyboardEvent): boolean {
  return e.nativeEvent.isComposing || e.keyCode === 229;
}

const basename = (p: string): string => p.split('/').filter(Boolean).pop() ?? p;

/**
 * 도우미의 말풍선(assistant 명세 §4.2, §4.5): 모달이 아닌 대화상자(role="dialog", aria-modal="false"), 머리글이 이름이다.
 * DialogFrame 은 늘 모달(aria-modal="true")이라 쓰지 않는다.
 * - 머리: 제목, 실험 폴더 이름(없으면 "저장되지 않아요"), 이 실험의 기록 지우기(확인 후), 닫기.
 * - 대화(role="log", aria-live="polite"): 흘러 들어오는 답, 상태 줄, 출처. 글은 글 그대로 그린다(MessageView).
 * - 입력 칸: Enter 보내기(IME 조합 중에는 아니다), Shift+Enter 줄바꿈. 실행 중에는 멈추기 단추가 보인다.
 * - 열리면 초점은 입력 칸에, 보낸 뒤에도 입력 칸에 남는다(실행 중의 승인 대화상자가 닫히면 그리로 돌아온다).
 *   Esc 는 닫고 초점을 돌려준다(PetLayer 가 정한다).
 * 칩은 그 기능이 동작하는 작업(11B)에서 붙는다.
 */
export function Bubble(props: {
  id: string;
  onClose: () => void;
  onHide: () => void;
  chat: UseAssistantSession;
  actions?: BubbleActions;
}) {
  useLang();
  const { chat } = props;
  const heading = useId();
  const composer = useRef<HTMLTextAreaElement>(null);
  const logEnd = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState('');

  // 열리면 초점을 입력 칸으로. 마우스로 열어도 같다: 열자마자 키보드로 이어 쓸 수 있다.
  useEffect(() => {
    composer.current?.focus();
  }, []);
  // 새 글이 오면 맨 아래를 보인다
  const last = chat.messages[chat.messages.length - 1];
  useEffect(() => {
    logEnd.current?.scrollIntoView?.({ block: 'end' });
  }, [chat.messages.length, last?.text]);

  const send = () => {
    if (!draft.trim() || chat.streaming) return;
    const text = draft;
    setDraft('');
    composer.current?.focus();
    void chat.send(text);
  };
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    send();
  };
  const onComposerKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey || composing(e)) return;
    e.preventDefault();
    send();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape' || composing(e)) return;
    e.preventDefault();
    e.stopPropagation();
    props.onClose();
  };
  const stop = () => {
    chat.stop();
    composer.current?.focus();
  };

  return (
    <div id={props.id} className="pet-bubble" role="dialog" aria-modal="false" aria-labelledby={heading} onKeyDown={onKeyDown}>
      <div className="pet-bubble-head">
        <div className="pet-bubble-heading">
          <h2 id={heading} className="pet-bubble-title">
            {t('pet.title')}
          </h2>
          {chat.folder !== null ? (
            <span className="pet-bubble-folder" title={chat.folder}>
              {t('pet.folder', basename(chat.folder))}
            </span>
          ) : null}
        </div>
        <div className="pet-bubble-tools">
          {chat.folder !== null ? (
            <button
              type="button"
              className="ibtn pet-bubble-clear"
              aria-label={t('history.clear')}
              title={t('history.clear')}
              onClick={() => void chat.clear()}
            >
              <Icon name="eraser" size={16} />
            </button>
          ) : null}
          <button type="button" className="ibtn pet-bubble-close" aria-label={t('pet.close')} title={t('pet.close')} onClick={props.onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>
      </div>
      {chat.folder === null ? <p className="pet-bubble-note">{t('pet.ephemeral')}</p> : null}
      {chat.notice ? (
        <p className="pet-bubble-notice" role="status">
          {chat.notice}
        </p>
      ) : null}
      <div className="pet-log" role="log" aria-live="polite" aria-relevant="additions" aria-label={t('pet.log')}>
        {chat.messages.length === 0 && !chat.summarised ? <p className="pet-bubble-greeting">{t('pet.greeting')}</p> : null}
        {chat.summarised ? <p className="pet-divider">{t('pet.summarised')}</p> : null}
        {chat.messages.map((m) => (
          <MessageView key={m.id} item={m} actions={props.actions} />
        ))}
        <div ref={logEnd} />
      </div>
      <form className="pet-composer" onSubmit={onSubmit}>
        <textarea
          ref={composer}
          className="pet-composer-input"
          rows={2}
          value={draft}
          aria-label={t('pet.composer')}
          placeholder={t('pet.placeholder')}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onComposerKey}
        />
        <div className="pet-composer-actions">
          {chat.streaming ? (
            <button type="button" className="btn pet-stop" onClick={stop}>
              <Icon name="circle-stop" size={14} />
              <span>{t('pet.stop')}</span>
            </button>
          ) : null}
          <button type="submit" className="btn primary pet-send" disabled={chat.streaming || !draft.trim()}>
            <Icon name="send" size={14} />
            <span>{t('pet.send')}</span>
          </button>
        </div>
      </form>
      <div className="pet-bubble-foot">
        <button type="button" className="btn pet-bubble-hide" onClick={props.onHide}>
          <Icon name="eye-off" size={14} />
          <span>{t('pet.hide')}</span>
        </button>
      </div>
    </div>
  );
}
