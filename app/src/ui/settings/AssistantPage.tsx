import { useEffect, useState } from 'react';
import { clearAllHistory, historyStats, type HistoryStats } from '../../assistant/history';
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
 * 하나씩 늘어난다: 보이기, 크기(정수 배율 2·3), 대화 기록(Task 10).
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
      <HistoryRow />
    </>
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
