import { useEffect, useState } from 'react';
import { probeWebSearch, readAssistantConfig, updateAssistantConfig, type AssistantConfig } from '../../assistant/config';
import { clearAllHistory, historyStats, type HistoryStats } from '../../assistant/history';
import type { WebSearchResult } from '../../assistant/web/ipc';
import { assistantSession } from '../../assistant/useAssistantSession';
import { t } from '../../i18n/t';
import { useLang } from '../../i18n/useLang';
import { confirmDialog } from '../../labnote/host/dialogStore';
import { notify as toast } from '../../labnote/host/toastStore';
import { layoutStore, useLayout } from '../layoutStore';
import { Segmented } from '../Segmented';
import { SettingRow, Toggle } from './SettingRow';

/**
 * 설정 → 어시스턴트(assistant 명세 §10.1). 이 PC 의 ui.json(layoutStore 의 pet)에 산다. 줄은 그 기능이 동작하게 되는 작업에서
 * 하나씩 늘어난다: 보이기, 크기(정수 배율 2·3), 웹 검색 주소(Task 12, 이 PC 의 assistant.json), 대화 기록(Task 10).
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
      <WebSearchRow />
      <HistoryRow />
    </>
  );
}

export interface WebSearchRowDeps {
  read?: () => Promise<AssistantConfig>;
  /** 웹 검색 주소만 바꾼다(빈 글은 지우기). Rust 가 정리해 저장한 설정을 돌려준다. */
  save?: (url: string) => Promise<AssistantConfig>;
  /** 저장하지 않은 주소로 시험 검색. */
  probe?: (url: string) => Promise<WebSearchResult>;
}

/** 시험 검색이나 저장의 거절을 짧은 안내로. `message` 는 Rust 글이라 보이지 않는다. */
function searchErrorText(e: unknown): string {
  const kind = (e as { kind?: unknown } | null)?.kind;
  switch (kind) {
    case 'badUrl':
    case 'invalidUrl':
      return t('settings.assistant.search.badUrl');
    case 'insecure':
      return t('settings.assistant.search.insecure');
    case 'jsonDisabled':
      return t('settings.assistant.search.jsonDisabled');
    case 'rateLimited':
      return t('settings.assistant.search.rateLimited');
    case 'enginesDown':
      return t('settings.assistant.search.enginesDown');
    default:
      return t('settings.assistant.search.failed');
  }
}

/**
 * 웹 검색 주소 줄(assistant 명세 §7.1, plan Task 12): 이 PC 의 `assistant.json` 에 SearXNG 주소를 둔다. 보관함에는 두지 않는다.
 * Enter 나 칸을 떠나면 저장하고(Rust 가 검사), "확인"은 칸에 적힌 주소(저장 전)로 시험 검색을 한 번 한다.
 * 결과와 거절은 `role=status` 한 줄로 알린다. 한글 입력 중의 Enter 는 저장하지 않는다.
 */
export function WebSearchRow(deps: WebSearchRowDeps = {}) {
  useLang();
  const read = deps.read ?? (() => readAssistantConfig());
  const save = deps.save ?? ((url: string) => updateAssistantConfig({ searxngUrl: url || undefined }));
  const probe = deps.probe ?? ((url: string) => probeWebSearch(url));
  const [value, setValue] = useState('');
  const [saved, setSaved] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    read().then(
      (cfg) => {
        if (!live) return;
        setValue(cfg.searxngUrl ?? '');
        setSaved(cfg.searxngUrl ?? '');
      },
      () => undefined
    );
    return () => {
      live = false;
    };
    // Read once when the pane opens.
  }, []);

  const commit = async () => {
    const next = value.trim();
    if (next === saved) return;
    try {
      const stored = await save(next);
      const url = stored.searxngUrl ?? '';
      setSaved(url);
      setValue(url);
      setStatus(t(url ? 'settings.assistant.search.saved' : 'settings.assistant.search.cleared'));
    } catch (e) {
      const kind = (e as { kind?: unknown } | null)?.kind;
      setStatus(kind === 'badUrl' ? searchErrorText(e) : t('settings.assistant.search.saveFailed'));
    }
  };

  const check = async () => {
    const url = value.trim();
    if (!url) return;
    setBusy(true);
    try {
      const r = await probe(url);
      setStatus(t('settings.assistant.search.ok', r.hits.length));
    } catch (e) {
      setStatus(searchErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  const label = t('settings.assistant.search');
  return (
    <SettingRow
      label={label}
      description={t('settings.assistant.search.desc')}
      control={
        <>
          <input
            type="text"
            className="setting-text"
            aria-label={label}
            autoComplete="off"
            spellCheck={false}
            inputMode="url"
            maxLength={2048}
            placeholder={t('settings.assistant.search.placeholder')}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onBlur={() => void commit()}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || e.nativeEvent.isComposing || e.keyCode === 229) return;
              e.preventDefault();
              void commit();
            }}
          />
          <button type="button" className="btn" disabled={busy || value.trim() === ''} onClick={() => void check()}>
            {t('settings.assistant.search.check')}
          </button>
          <span role="status" className="setting-status">
            {status}
          </span>
        </>
      }
    />
  );
}

export interface HistoryRowDeps {
  stats?: () => Promise<HistoryStats>;
  clearAll?: () => Promise<number>;
  confirm?: (message: string) => Promise<boolean>;
  /** 모두 지운 뒤: 열린 대화를 비운다. */
  onCleared?: () => void;
  notify?: (kind: 'info' | 'warn', message: string) => void;
}

/**
 * 대화 기록 줄(assistant 명세 §6.1, §10.1): 기록이 있는 실험 수와 "모든 기록 지우기"(확인 후, 되돌릴 수 없다).
 * 기록은 이 PC 의 앱 데이터 폴더에만 있다(보관함에는 쓰지 않는다). 수를 읽지 못하면 수는 보이지 않고 단추는 그대로다.
 */
export function HistoryRow(deps: HistoryRowDeps = {}) {
  useLang();
  const stats = deps.stats ?? (() => historyStats());
  const clearAll = deps.clearAll ?? (() => clearAllHistory());
  const confirm =
    deps.confirm ?? ((message: string) => confirmDialog(message, { confirmLabel: t('history.clearAction'), destructive: true }));
  const onCleared = deps.onCleared ?? (() => assistantSession.forget());
  const notify = deps.notify ?? toast;
  const [folders, setFolders] = useState<number | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const refresh = () =>
    stats().then(
      (s) => setFolders(s.folders),
      () => setFolders(undefined)
    );
  useEffect(() => {
    let live = true;
    stats().then(
      (s) => live && setFolders(s.folders),
      () => undefined
    );
    return () => {
      live = false;
    };
    // Read once when the pane opens.
  }, []);

  const run = async () => {
    if (!(await confirm(t('history.clearAllConfirm')))) return;
    setBusy(true);
    try {
      await clearAll();
      onCleared();
      notify('info', t('history.clearedAll'));
    } catch (err) {
      console.warn('[labnoteo] assistant history clear-all failed:', err);
      notify('warn', t('history.clearFailed'));
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  const desc = t('settings.assistant.history.desc');
  return (
    <SettingRow
      label={t('settings.assistant.history')}
      description={folders === undefined ? desc : `${t('settings.assistant.history.count', folders)} ${desc}`}
      control={
        <button type="button" className="btn danger" disabled={busy || folders === 0} onClick={() => void run()}>
          {t('settings.assistant.history.clearAll')}
        </button>
      }
    />
  );
}
