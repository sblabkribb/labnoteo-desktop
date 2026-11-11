import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { t } from '../i18n/t';
import { useLang } from '../i18n/useLang';
import { Icon } from '../ui/Icon';
import { ChipBar } from './ChipBar';
import { chipGate, isWorkflowNotePath, type ChipId } from './chips';
import { HowToCard } from './HowToCard';
import { MessageView, type BubbleActions } from './MessageView';
import { SectionPicker, sectionOptions, type SectionChoice, type SectionOption } from './SectionPicker';
import type { UseAssistantSession } from './useAssistantSession';

/** IME 조합 중의 키(한글 입력의 Enter 는 글자를 확정할 뿐 보내지 않는다). */
function composing(e: KeyboardEvent): boolean {
  return e.nativeEvent.isComposing || e.keyCode === 229;
}

const basename = (p: string): string => p.split('/').filter(Boolean).pop() ?? p;

/** 고르기 칸에 들어갈 이름: 길면 가운데를 줄임표로 줄인다(번호와 끝 이름이 남는다). 고르기 칸은 줄임표를 그리지 않는다. */
export function shortName(name: string, max = 36): string {
  const chars = [...name];
  if (chars.length <= max) return name;
  const tail = Math.min(16, Math.floor((max - 1) / 2));
  return `${chars.slice(0, max - 1 - tail).join('')}…${chars.slice(-tail).join('')}`;
}

/** 웹 검색 안내 칩을 닫았거나 그 단추를 눌렀다: 이 실행(앱 세션) 동안 다시 보이지 않는다. */
let webHintDone = false;

/** 테스트용: 안내 칩을 다시 보일 수 있게 한다. */
export function resetWebHint(): void {
  webHintDone = false;
}

/** 칩마다 입력 칸의 안내 글. */
function placeholderOf(chip: ChipId): string {
  switch (chip) {
    case 'section':
      return t('chip.section.placeholder');
    case 'unitOp':
      return t('chip.unitOp.placeholder');
    case 'workflow':
      return t('chip.workflow.placeholder');
    default:
      return t('pet.placeholder');
  }
}

/**
 * 도우미의 말풍선(assistant 명세 §4.2, §4.4, §4.5): 모달이 아닌 대화상자(role="dialog", aria-modal="false"), 머리글이 이름이다.
 * DialogFrame 은 늘 모달(aria-modal="true")이라 쓰지 않는다.
 * - 머리: 제목, 실험 폴더 이름(없으면 "저장되지 않아요"), 이 실험의 기록 지우기(확인 후), 닫기.
 * - 칩 줄(ChipBar, roving tabindex): 사용법(도움말, 모델 없음) / 섹션 만들기 / 단위 공정 만들기 / 워크플로 만들기 / 대화.
 *   사용법 말고는 AI 제공자가 있어야 하고(없으면 ai.configureFirst 와 연동 설정 단추), 만들기 칩은 실험 노트가 열려
 *   있어야 한다(없으면 "실험 노트를 먼저 열어 주세요" 와 실험 목록 단추).
 * - 대화(role="log", aria-live="polite"): 흘러 들어오는 답, 상태 줄, 출처. 글은 글 그대로 그린다(MessageView).
 * - 대화 칩: 이 PC 에 웹 검색 주소가 없으면 안내 칩(role="note")을 한 번 보인다. "설정 열기"는 어시스턴트 설정을 연다.
 * - 입력 칸: Enter 보내기(IME 조합 중에는 아니다), Shift+Enter 줄바꿈. 실행 중에는 멈추기 단추가 보인다. 섹션 칩은
 *   섹션을 고른 뒤에만, 단위 공정·워크플로 칩은 글이 있어야 보낸다.
 * - 열리면 초점은 입력 칸(없으면 칩 칸의 첫 칸, 그것도 없으면 고른 칩)에, 칩을 바꾸면 그 칩 칸의 첫 칸으로 간다.
 *   Esc 는 닫고 초점을 돌려준다(PetLayer 가 정한다).
 * - 크기 조절 손잡이(`grip`)는 PetLayer 가 만든다(끌기·키보드·자리). 크기를 정했으면(`sized`) 바닥에 "기본 크기로" 가 있다.
 */
export function Bubble(props: {
  id: string;
  onClose: () => void;
  onHide: () => void;
  /** 크기 조절 손잡이(말풍선 모서리에 뜬다). */
  grip?: ReactNode;
  /** 크기를 정했는지(기본 크기가 아닌지). */
  sized?: boolean;
  onResetSize?: () => void;
  chat: UseAssistantSession;
  activePath?: string;
  actions?: BubbleActions;
}) {
  useLang();
  const { chat, actions } = props;
  const heading = useId();
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const logEnd = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState('');
  const [provider, setProvider] = useState<boolean | null>(null);
  const [options, setOptions] = useState<SectionOption[]>([]);
  const [notePath, setNotePath] = useState<string | undefined>(undefined);
  const [section, setSection] = useState<SectionChoice | null>(null);
  const [workflows, setWorkflows] = useState<string[] | null>(null);
  const [target, setTarget] = useState<string>('');
  const chip = chat.chip;
  const gate = chipGate(chip, { provider: provider !== false, folder: chat.folder });
  const ready = gate === 'ok';
  const firstChip = useRef(true);
  const [webHint, setWebHint] = useState(false);

  // AI 제공자가 있는지: 열 때와 칩을 바꿀 때 다시 본다(설정 창에서 바꿨을 수 있다)
  const { ready: checkReady } = chat;
  useEffect(() => {
    let live = true;
    void checkReady().then((ok) => {
      if (live) setProvider(ok);
    });
    return () => {
      live = false;
    };
  }, [checkReady, chip]);

  // 대화 칩: 웹 검색 주소가 없으면 한 번 안내한다(Task 14). 닫거나 설정을 열면 다시 보이지 않는다.
  const webConfigured = actions?.webSearchConfigured;
  useEffect(() => {
    if (chip !== 'chat' || !ready || webHintDone || !webConfigured) return;
    let live = true;
    void webConfigured().then(
      (ok) => {
        if (live && !ok && !webHintDone) setWebHint(true);
      },
      (err: unknown) => console.warn('[labnoteo] assistant could not read the web search setting:', err)
    );
    return () => {
      live = false;
    };
  }, [chip, ready, webConfigured]);
  const closeWebHint = () => {
    webHintDone = true;
    setWebHint(false);
  };

  // 섹션 칩: 열린 노트의 제목들
  const noteReader = actions?.activeNote;
  useEffect(() => {
    if (chip !== 'section' || chat.folder === null) return;
    let live = true;
    setSection(null);
    setOptions([]);
    setNotePath(undefined);
    void (noteReader ? noteReader() : Promise.resolve(undefined)).then(
      (note) => {
        if (!live || !note) return;
        setNotePath(note.path);
        setOptions(sectionOptions(note.text, note.cursorLine));
      },
      (err: unknown) => console.warn('[labnoteo] assistant could not read the open note:', err)
    );
    return () => {
      live = false;
    };
  }, [chip, chat.folder, props.activePath, noteReader]);

  // 단위 공정 칩: 열린 노트가 워크플로 노트가 아니면 이 실험의 워크플로 노트 중에서 고른다
  const listWorkflows = actions?.workflowNotes;
  const openIsWorkflow = !!props.activePath && isWorkflowNotePath(props.activePath);
  useEffect(() => {
    if (chip !== 'unitOp' || chat.folder === null || openIsWorkflow) return;
    let live = true;
    setWorkflows(null);
    const folder = chat.folder;
    void (listWorkflows ? listWorkflows(folder) : Promise.resolve([])).then(
      (list) => {
        if (!live) return;
        setWorkflows(list);
        setTarget(list[0] ?? '');
      },
      (err: unknown) => {
        console.warn('[labnoteo] assistant could not list the workflow notes:', err);
        if (live) setWorkflows([]);
      }
    );
    return () => {
      live = false;
    };
  }, [chip, chat.folder, openIsWorkflow, listWorkflows]);

  // 열리면 초점을 입력 칸으로(마우스로 열어도: 열자마자 키보드로 이어 쓸 수 있다). 칩을 바꾸면 그 칩 칸의 첫 칸으로.
  useEffect(() => {
    const first = firstChip.current;
    firstChip.current = false;
    const field = (first ? composer.current : null) ?? panel.current?.querySelector<HTMLElement>('select, input, textarea, button');
    (field ?? root.current?.querySelector<HTMLElement>('.pet-chip[aria-pressed="true"]'))?.focus();
  }, [chip, ready]);

  // 대화가 바뀌면 맨 아래를 보인다: 새 글만이 아니라 글이 끝난 뒤에 붙는 출처·도구 요약·"노트에 넣기"도(메시지 배열은 바뀔
  // 때마다 새것이다). 그것들이 그려진 뒤에 스크롤하도록 layout effect 다.
  useLayoutEffect(() => {
    logEnd.current?.scrollIntoView?.({ block: 'end' });
  }, [chat.messages, chat.streaming]);

  const unitOpTarget = openIsWorkflow ? props.activePath : target || undefined;
  const canSend = (): boolean => {
    if (chat.streaming || !ready) return false;
    switch (chip) {
      case 'section':
        return section !== null;
      case 'unitOp':
        return !!unitOpTarget && !!draft.trim();
      case 'howTo':
        return false;
      default:
        return !!draft.trim();
    }
  };

  const send = () => {
    if (!canSend()) return;
    const text = draft.trim();
    setDraft('');
    composer.current?.focus();
    if (chip === 'chat') {
      void chat.send(text);
      return;
    }
    if (chip === 'section' && section) {
      const documentPath = notePath ?? props.activePath ?? '';
      void chat.runChip({
        chip,
        params: {
          documentPath,
          heading: section.heading,
          ...(section.parentHeading ? { parentHeading: section.parentHeading } : {}),
          ...(section.after ? { after: section.after } : {}),
          existing: section.existing ? 'yes' : 'no',
        },
        line: text ? `${section.heading} — ${text}` : section.heading,
        text,
      });
      return;
    }
    if (chip === 'unitOp' && unitOpTarget) {
      void chat.runChip({ chip, params: { documentPath: unitOpTarget }, line: text, text });
      return;
    }
    if (chip === 'workflow') {
      void chat.runChip({ chip, params: { documentPath: props.activePath ?? chat.folder ?? '' }, line: text, text });
    }
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
  const run = actions?.runCommand;

  const gatePanel =
    gate === 'noProvider' ? (
      <div className="pet-gate" role="status">
        <p>{t('ai.configureFirst')}</p>
        {run ? (
          <button type="button" className="btn" onClick={() => run('app.integration-settings')}>
            <Icon name="settings" size={14} />
            <span>{t('pet.openIntegrations')}</span>
          </button>
        ) : null}
      </div>
    ) : gate === 'noScope' ? (
      <div className="pet-gate" role="status">
        <p>{t('pet.needExperiment')}</p>
        {run ? (
          <button type="button" className="btn" onClick={() => run('open-workflow-view')}>
            <Icon name="folder-open" size={14} />
            <span>{t('pet.openExperiments')}</span>
          </button>
        ) : null}
      </div>
    ) : null;

  const chipFields =
    chip === 'section' ? (
      <SectionPicker key={`${props.activePath ?? ''}`} options={options} value={section} onChange={setSection} />
    ) : chip === 'unitOp' ? (
      openIsWorkflow && props.activePath ? (
        <p className="pet-chip-target">{t('chip.target', basename(props.activePath))}</p>
      ) : workflows === null ? null : workflows.length === 0 ? (
        <p className="pet-chip-target">{t('chip.noWorkflow')}</p>
      ) : (
        <div className="pet-field">
          <label className="pet-field-label" htmlFor={`${props.id}-wf`}>
            {t('chip.pickWorkflow')}
          </label>
          <select
            id={`${props.id}-wf`}
            className="pet-select"
            value={target}
            title={target ? basename(target) : undefined}
            onChange={(e) => setTarget(e.target.value)}
          >
            {workflows.map((p) => (
              <option key={p} value={p} title={basename(p)}>
                {shortName(basename(p))}
              </option>
            ))}
          </select>
        </div>
      )
    ) : null;

  return (
    <div
      ref={root}
      id={props.id}
      className="pet-bubble"
      role="dialog"
      aria-modal="false"
      aria-labelledby={heading}
      onKeyDown={onKeyDown}
    >
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
      <ChipBar active={chip} onSelect={chat.setChip} />
      {chat.folder === null ? <p className="pet-bubble-note">{t('pet.ephemeral')}</p> : null}
      {chat.notice ? (
        <p className="pet-bubble-notice" role="status">
          {chat.notice}
        </p>
      ) : null}
      {webHint && chip === 'chat' && ready ? (
        <div className="pet-hint" role="note">
          <Icon name="search" size={14} />
          <p className="pet-hint-text">{t('web.noUrl')}</p>
          {run ? (
            <button
              type="button"
              className="btn pet-hint-open"
              onClick={() => {
                closeWebHint();
                run('assistant.settings');
              }}
            >
              {t('web.hint.open')}
            </button>
          ) : null}
          <button
            type="button"
            className="ibtn pet-hint-close"
            aria-label={t('web.hint.dismiss')}
            title={t('web.hint.dismiss')}
            onClick={closeWebHint}
          >
            <Icon name="x" size={14} />
          </button>
        </div>
      ) : null}
      <div className="pet-log" role="log" aria-live="polite" aria-relevant="additions" aria-label={t('pet.log')}>
        {chat.messages.length === 0 && !chat.summarised ? <p className="pet-bubble-greeting">{t('pet.greeting')}</p> : null}
        {chat.summarised ? <p className="pet-divider">{t('pet.summarised')}</p> : null}
        {chat.messages.map((m) => (
          <MessageView key={m.id} item={m} actions={actions} />
        ))}
        <div ref={logEnd} />
      </div>
      <div ref={panel} className="pet-chip-panel" data-chip={chip}>
        {chip === 'howTo' ? (
          <HowToCard onChat={() => chat.setChip('chat')} runCommand={run} canClear={chat.folder !== null} />
        ) : !ready ? (
          gatePanel
        ) : (
          <form className="pet-composer" onSubmit={onSubmit}>
            {chipFields}
            <textarea
              ref={composer}
              className="pet-composer-input"
              rows={2}
              value={draft}
              aria-label={t('pet.composer')}
              placeholder={placeholderOf(chip)}
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
              <button type="submit" className="btn primary pet-send" disabled={!canSend()}>
                <Icon name="send" size={14} />
                <span>{t('pet.send')}</span>
              </button>
            </div>
          </form>
        )}
      </div>
      <div className="pet-bubble-foot">
        {props.sized && props.onResetSize ? (
          <button type="button" className="btn pet-bubble-resetsize" onClick={props.onResetSize}>
            <Icon name="refresh-cw" size={14} />
            <span>{t('pet.resetSize')}</span>
          </button>
        ) : null}
        <button type="button" className="btn pet-bubble-hide" onClick={props.onHide}>
          <Icon name="eye-off" size={14} />
          <span>{t('pet.hide')}</span>
        </button>
      </div>
      {props.grip}
    </div>
  );
}
