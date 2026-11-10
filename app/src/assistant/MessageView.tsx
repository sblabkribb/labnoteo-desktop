import { useMemo } from 'react';
import { t } from '../i18n/t';
import { Icon } from '../ui/Icon';
import { SourceLedger, type Source } from './sources';
import type { ChatItem } from './useAssistantSession';

/** 열린 노트(섹션 만들기 칩이 제목을 고르는 데 쓴다). `cursorLine` 은 0부터. */
export interface ActiveNote {
  path: string;
  text: string;
  cursorLine?: number;
}

/**
 * 말풍선이 바깥에 맡기는 일: 출처 열기(노트는 편집기, 주소는 시스템 브라우저), 답을 노트에 넣기, 명령 부르기(id),
 * 칩이 쓰는 열린 노트 읽기와 실험의 워크플로 노트 목록.
 */
export interface BubbleActions {
  openSource?(src: Source): void;
  /** 열린 노트에 답을 넣는다. `tainted` 면 먼저 묻는다(ai.confirm.tainted). */
  insert?(text: string, tainted: boolean): void | Promise<void>;
  /** 명령 하나를 부른다(연동 설정, 실험 목록, 어시스턴트 설정 …). */
  runCommand?(id: string): void;
  /** 열린 노트의 글과 커서 줄. */
  activeNote?(): Promise<ActiveNote | undefined>;
  /** 실험 폴더의 워크플로 노트(보관함 상대 경로, 번호 차례). */
  workflowNotes?(folder: string): Promise<string[]>;
  /** 이 PC 에 웹 검색 주소가 있는지(`assistant.json`). 없으면 대화 칩이 한 번 안내한다. */
  webSearchConfigured?(): Promise<boolean>;
}

/**
 * 메시지 하나(assistant spec §4.5). 모델의 글은 글 그대로 그린다(white-space: pre-wrap, aiAnswerDialog 와 같은 규칙, D19):
 * HTML 도 마크다운도 읽지 않고 HTML 문자열을 DOM 에 넣지 않는다. 장부에 있는 `[n]` 만 React 단추가 되고, 없는 번호는
 * 글로 남는다. 출처 목록은 답 아래에 있고, 이름표도 글로만 그린다.
 */
export function MessageView({ item, actions }: { item: ChatItem; actions?: BubbleActions }) {
  const assistant = item.role === 'assistant';
  const ledger = useMemo(() => SourceLedger.from(item.sources), [item.sources]);
  const parts = assistant && item.sources.length ? ledger.render(item.text) : [item.text];
  const open = actions?.openSource;
  const sources = assistant ? ledger.list() : [];
  return (
    <div className="pet-msg" data-role={item.role}>
      <span className="pet-sr">{assistant ? t('pet.title') : t('pet.you')}: </span>
      {item.text ? (
        <p className="pet-msg-text">
          {parts.map((p, i) =>
            typeof p === 'string' ? (
              p
            ) : open ? (
              <button
                key={i}
                type="button"
                className="pet-cite"
                aria-label={t('pet.cite', p.n, p.src.label)}
                title={p.src.label}
                onClick={() => open(p.src)}
              >
                [{p.n}]
              </button>
            ) : (
              `[${p.n}]`
            )
          )}
        </p>
      ) : item.pending ? (
        <p className="pet-msg-text pet-msg-wait">{t('pet.thinking')}</p>
      ) : null}
      {item.pending && item.status ? <p className="pet-msg-status">{item.status}</p> : null}
      {item.stopped ? <p className="pet-msg-status">{t('pet.stopped')}</p> : null}
      {item.error ? <p className="pet-msg-error">{item.error}</p> : null}
      {item.notice ? <p className="pet-msg-status">{item.notice}</p> : null}
      {sources.length > 0 ? (
        <ol className="pet-sources" aria-label={t('pet.sources')}>
          {sources.map((s, i) => (
            <li key={`${s.kind}:${s.target}`} className="pet-source" data-kind={s.kind}>
              <span className="pet-source-n">[{i + 1}]</span>{' '}
              {open ? (
                <button type="button" className="pet-source-link" title={s.target} onClick={() => open(s)}>
                  {s.label}
                </button>
              ) : (
                <span>{s.label}</span>
              )}
            </li>
          ))}
        </ol>
      ) : null}
      {assistant && !item.pending && item.text && actions?.insert ? (
        <div className="pet-msg-actions">
          <button type="button" className="btn pet-msg-insert" onClick={() => void actions.insert!(item.text, item.tainted)}>
            <Icon name="file-plus" size={14} />
            <span>{t('pet.insert')}</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
