/**
 * 샘플 탭 아래의 PartBank 구역: 연결된 PartBank 에서 항목을 찾아 샘플로 가져오거나 PartBank 에서 연다.
 * - 펼침 단추(disclosure) 하나와 그 몸. 트리(role=tree)가 아니다: 찾기 칸과 줄마다의 단추가 있어서다.
 * - 연결: 검색은 Rust `partbank_read` 이고, 그것은 저장된 `partbankDefaultConnection` 만 쓴다. 그래서 그 연결에 주소와 키가
 *   있을 때(`feature.client(kind)`)만 찾기 칸을 보인다. 없으면 까닭과 "연결하기"(설정 > 연동의 PartBank 로 연다)를 보인다.
 *   연결 상태는 그릴 때마다 feature 에서 읽고, 키가 바뀌거나(onSecretsChange) 연동 설정이 바뀌면(onIntegrationChange,
 *   주소·기본 연결) 다시 그린다. 연결이 바뀌면 진행 중인 검색을 끊고 결과를 지운다(다른 서버의 결과일 수 있다).
 * - 찾기: 400 ms 쉼마다 한 번, 두 글자부터(SearchDebouncer). 한글 조합 중에는 묻지 않는다(PartbankSearchDialog 와 같다).
 *   새 질문은 앞 질문을 AbortController 로 끊는다. 내 것·그룹·공개 모두 찾는다(exclude_public 을 보내지 않는다).
 * - 줄의 동작은 이미 있는 흐름이다: 가져오기는 handleImportUri(항목 읽기 → 유형 → Local/Global 고르기 → 대장에 등록 →
 *   열린 노트에 넣을지 묻기), 열기는 openInPartbank. 둘 다 runCommand 를 거친다(거절은 알림이 된다).
 * - PartBank 에는 아무것도 쓰지 않는다: 검색(POST /search/global, 읽기 전용)과 그룹 목록(GET /groups/), 가져오기 안의 GET 뿐.
 * - 오류 문장에 Rust 의 글을 싣지 않는다: 연결 실패는 주소 없는 문장으로, 나머지는 feature.describeError 로.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { sourceForItem } from '@labnoteo/core';
import { t } from '../i18n/t';
import { NetError, type InvokeFn } from '../integrations/netIpc';
import { onIntegrationChange, onSecretsChange } from '../integrations/probes';
import type { CommandContext } from '../labnote/commands/context';
import { runCommand } from '../labnote/commands/runCommand';
import { coreT } from '../labnote/i18n';
import { PartbankError, statusKind, toPartbankError } from '../labnote/port/partbankClient';
import { openInPartbank } from '../labnote/port/partbankActions';
import { MIN_QUERY_CHARS, SearchDebouncer, partbankEmptyState, partbankTypeLabel } from '../labnote/port/partbankSearch';
import { handleImportUri } from '../labnote/port/partbankUri';
import { labIpcFor } from '../labservices/ipc';
import { scopeWord } from '../labservices/partbankTools';
import { partbank } from '../partbank/current';
import { Icon } from '../ui/Icon';
import { openSettings } from '../ui/SettingsModal';
import type { SampleEnv } from './env';
import { pbGroupNames, pbPanelRows, type PbPanelRow } from './partbankRows';

/** 한 번의 검색이 묻는 줄 수(유형마다). Rust 는 25 를 넘으면 자른다. */
export const PB_PANEL_LIMIT = 15;

export interface PartbankSectionProps {
  ctx: CommandContext;
  env: SampleEnv;
  /** 테스트가 Rust 대신 끼우는 invoke. 없으면 Tauri 의 것. */
  invoke?: InvokeFn;
  /** 테스트가 시계를 바꿔 끼울 때. 없으면 전역 setTimeout / clearTimeout. */
  timers?: { set: typeof setTimeout; clear: typeof clearTimeout };
}

const isCancelled = (err: unknown): boolean => err instanceof NetError && err.kind === 'cancelled';

export function PartbankSection({ ctx, env, invoke, timers }: PartbankSectionProps) {
  const id = useId();
  const [, setTick] = useState(0);
  const bump = useCallback(() => setTick((n) => n + 1), []);
  const [open, setOpen] = useState(true);
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<PbPanelRow[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [groups, setGroups] = useState<ReadonlyMap<string, string>>(() => new Map());

  const feature = partbank();
  const { partbankDefaultConnection: kind, partbankWebUrl, partbankDesktopUrl } = ctx.settings;
  const client = feature?.client(kind);
  const connKey = client ? `${client.kind} ${client.origin}` : '';
  const otherSet = !client && feature?.configured === true;

  const invokeRef = useRef(invoke);
  invokeRef.current = invoke;
  const live = useRef(true);
  const searchCtrl = useRef<AbortController>();
  const groupsCtrl = useRef<AbortController>();
  const groupsAsked = useRef(false);
  const composing = useRef(false);
  /** 검색을 건 마지막 글자(앞뒤 공백 뺀 것). '\0' 이라 첫 글자는 늘 다르다. */
  const lastAsked = useRef('\u0000');
  const searchInput = useRef<HTMLInputElement>(null);
  const connectButton = useRef<HTMLButtonElement>(null);
  /** "연결하기"로 연 설정이 닫힌 뒤 초점을 옮길 차례. */
  const focusAfterConnect = useRef(false);

  const ipc = (signal: AbortSignal) => labIpcFor(invokeRef.current, signal);

  const loadGroups = () => {
    if (groupsAsked.current) return;
    groupsAsked.current = true;
    const ctrl = new AbortController();
    groupsCtrl.current = ctrl;
    ipc(ctrl.signal)
      .partbankRead('GET', '/groups/', [['limit', '100']])
      .then(
        (res) => {
          if (live.current && !ctrl.signal.aborted && res.status < 400) setGroups(pbGroupNames(res.json));
        },
        // 이름을 못 읽으면 "그룹"이라고만 쓴다
        () => undefined,
      );
  };

  /** 무엇이 잘못됐는지: Rust 의 글은 싣지 않는다. 연결 실패는 주소 없는 문장이다(찾기 칸 아래 좁은 자리라서). */
  const describe = (err: unknown): string => {
    let e = err;
    if (e instanceof NetError) e = toPartbankError(e);
    if (!(e instanceof PartbankError)) return t('samples.pb.error');
    if (e.kind === 'offline' || e.kind === 'timeout') return t('samples.pb.unreachable');
    if (e.kind === 'redirected') return t('samples.pb.error');
    return partbank()?.describeError(e) ?? t('samples.pb.error');
  };

  const debouncer = useRef<SearchDebouncer<PbPanelRow>>();
  if (!debouncer.current) {
    debouncer.current = new SearchDebouncer<PbPanelRow>({
      search: async (q) => {
        searchCtrl.current?.abort();
        const ctrl = new AbortController();
        searchCtrl.current = ctrl;
        const res = await ipc(ctrl.signal).partbankRead('POST', '/search/global', undefined, { query: q, limit: PB_PANEL_LIMIT });
        if (res.status >= 400) throw new PartbankError(statusKind(res.status), res.status, `status ${res.status}`);
        return pbPanelRows(res.json);
      },
      onResults: (_q, found) => {
        if (!live.current) return;
        setRows(found);
        setPending(false);
        setError(undefined);
        if (found.some((r) => r.scope === 'group')) loadGroups();
      },
      onError: (_q, err) => {
        if (!live.current || isCancelled(err)) return;
        setRows([]);
        setPending(false);
        setError(describe(err));
      },
      setTimer: (fn, ms) => (timers?.set ?? setTimeout)(fn, ms) as unknown as number,
      clearTimer: (h) => (timers?.clear ?? clearTimeout)(h as unknown as ReturnType<typeof setTimeout>),
    });
  }

  /** 칸의 글자가 바뀌었다(조합 중이 아닐 때). 글자가 실제로 바뀐 때만 검색을 건다. */
  const ask = (text: string) => {
    const trimmed = text.trim();
    if (trimmed === lastAsked.current) return;
    lastAsked.current = trimmed;
    setError(undefined);
    setPending(trimmed.length >= MIN_QUERY_CHARS);
    debouncer.current?.query(text);
  };

  /** 진행 중인 검색과 그룹 읽기를 끊고 결과를 비운다. */
  const stopAll = () => {
    debouncer.current?.cancel();
    searchCtrl.current?.abort();
    groupsCtrl.current?.abort();
    groupsAsked.current = false;
    lastAsked.current = '\u0000';
  };

  // 키 상태가 바뀌면(설정 창의 키 저장·지우기) partbankApp 이 setStatus 한 뒤에 다시 그린다. 연동 설정이 바뀌면 다시 읽는다.
  useEffect(() => {
    live.current = true;
    const offSecrets = onSecretsChange(() => queueMicrotask(() => live.current && bump()));
    const offIntegration = onIntegrationChange(() => {
      void partbank()
        ?.refresh()
        .then(() => live.current && bump());
    });
    return () => {
      live.current = false;
      offSecrets();
      offIntegration();
      stopAll();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bump]);

  // 처음과, 기본 연결이나 주소가 바뀔 때: 키 상태를 다시 읽는다(앱의 첫 refresh 가 아직 오는 중일 수 있다).
  useEffect(() => {
    let alive = true;
    void partbank()
      ?.refresh()
      .then(() => alive && bump());
    return () => {
      alive = false;
    };
  }, [kind, partbankWebUrl, partbankDesktopUrl, bump]);

  // 연결이 바뀌면(다른 서버, 키가 지워짐) 앞 결과를 버린다.
  const shownKey = useRef(connKey);
  useEffect(() => {
    if (shownKey.current === connKey) return;
    shownKey.current = connKey;
    stopAll();
    debouncer.current?.query('');
    setQuery('');
    setRows([]);
    setPending(false);
    setError(undefined);
    setGroups(new Map());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connKey]);

  // "연결하기"로 연 설정이 닫힌 뒤: 이제 연결됐으면 찾기 칸으로, 아니면 다시 "연결하기"로.
  useEffect(() => {
    if (!focusAfterConnect.current) return;
    focusAfterConnect.current = false;
    (searchInput.current ?? connectButton.current)?.focus();
  });

  if (!feature) return null;

  const connect = async () => {
    await openSettings('integrations', { focus: 'partbank' });
    await partbank()?.refresh();
    if (!live.current) return;
    focusAfterConnect.current = true;
    bump();
  };

  const importRow = (row: PbPanelRow) => {
    const f = partbank();
    const c = f?.client(kind);
    if (!f || !c) return;
    void runCommand(ctx, () => handleImportUri(env, f, { server: c.origin, type: row.type, id: row.id }));
  };

  const openRow = (row: PbPanelRow) => {
    const c = partbank()?.client(kind);
    if (!c) return;
    void runCommand(ctx, () => openInPartbank(env, sourceForItem(row, c.kind, c.origin)));
  };

  const headId = `${id}-head`;
  const bodyId = `${id}-body`;
  const state = partbankEmptyState(query, pending);
  const status = error
    ? error
    : rows.length > 0
      ? t('samples.pb.count', String(rows.length))
      : state === 'short'
        ? coreT('Type at least {0} characters to search partbank.', String(MIN_QUERY_CHARS))
        : state === 'searching'
          ? coreT('Searching partbank…')
          : t('samples.pb.none');

  return (
    <section className="pb-section">
      <button
        type="button"
        id={headId}
        className="pb-section-toggle"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="chevron-right" size={14} className="pb-chevron" />
        <Icon name="link" className="pb-section-icon" />
        <span className="pb-section-title">{t('samples.pb.title')}</span>
      </button>
      <div id={bodyId} role="region" aria-labelledby={headId} className="pb-body" hidden={!open}>
        {!client ? (
          <>
            <p className="samples-hint">{otherSet ? t('samples.pb.defaultNotSet') : t('samples.pb.notConnected')}</p>
            <button type="button" ref={connectButton} className="pb-connect" onClick={() => void connect()}>
              {t('samples.pb.connect')}
            </button>
          </>
        ) : (
          <>
            <input
              ref={searchInput}
              type="search"
              className="samples-search pb-search"
              aria-label={coreT('Search partbank')}
              placeholder={coreT('Search partbank')}
              autoComplete="off"
              spellCheck={false}
              value={query}
              onChange={(e) => {
                const value = e.target.value;
                setQuery(value);
                if (composing.current || (e.nativeEvent as InputEvent).isComposing) return;
                ask(value);
              }}
              onCompositionStart={() => {
                composing.current = true;
              }}
              onCompositionEnd={(e) => {
                composing.current = false;
                const value = e.currentTarget.value;
                setQuery(value);
                ask(value);
              }}
            />
            <p className="pb-status" aria-live="polite">
              {status}
            </p>
            {rows.length > 0 && (
              <ul className="pb-results" aria-label={t('samples.pb.results')}>
                {rows.map((row) => {
                  const title = row.name || row.kid || row.id;
                  const detail = [row.kid, partbankTypeLabel(row.type, coreT)].filter(Boolean).join(' · ');
                  const group = row.groupId ? groups.get(row.groupId) : undefined;
                  return (
                    <li key={`${row.type}:${row.id}`} className="pb-item">
                      <div className="pb-item-head">
                        <span className="pb-item-name" title={title}>
                          {title}
                        </span>
                        <span className="pb-scope" data-scope={row.scope}>
                          {scopeWord(row.scope, group)}
                        </span>
                      </div>
                      <div className="pb-item-detail">{detail}</div>
                      {row.description && (
                        <div className="pb-item-desc" title={row.description}>
                          {row.description}
                        </div>
                      )}
                      <div className="pb-item-actions">
                        <button type="button" className="pb-action" aria-label={t('samples.pb.importNamed', title)} onClick={() => importRow(row)}>
                          {t('samples.pb.import')}
                        </button>
                        <button type="button" className="pb-action" aria-label={t('samples.pb.openNamed', title)} onClick={() => openRow(row)}>
                          <Icon name="external-link" size={14} />
                          {t('samples.pb.open')}
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </div>
    </section>
  );
}
