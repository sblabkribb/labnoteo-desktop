import { t } from '../i18n/t';
import { useLang } from '../i18n/useLang';
import { Icon, type IconName } from './Icon';

interface Action {
  commandId: string;
  icon: IconName;
  labelKey: string;
  key?: string;
  needsCtx?: boolean;
}

/** 열린 노트가 없을 때 고를 수 있는 일(리본과 같은 명령 id). */
const ACTIONS: readonly Action[] = [
  { commandId: 'create-experiment', icon: 'flask-conical', labelKey: 'empty.newExperiment', needsCtx: true },
  { commandId: 'app.newNote', icon: 'file-plus', labelKey: 'empty.newNote', key: 'Ctrl+N' },
  { commandId: 'app.quickSwitcher', icon: 'search', labelKey: 'empty.switcher', key: 'Ctrl+O', needsCtx: true },
  { commandId: 'app.palette', icon: 'terminal', labelKey: 'empty.palette', key: 'Ctrl+P', needsCtx: true },
];

/**
 * 열린 노트가 없을 때 본문 가운데의 빈 화면(Obsidian 의 "No file is open"): 제목, 한 줄 안내, 그리고 새 실험·새 노트·빠른 이동·
 * 명령 팔레트를 고르는 줄. 줄은 리본과 같은 명령 id 로 부른다. 보관함 설정을 읽기 전(ready=false)에는 설정이 필요한 줄을 끈다.
 */
export function EmptyState(p: { onCommand: (commandId: string) => void; ready: boolean }) {
  useLang();
  return (
    <section className="empty-state" aria-labelledby="empty-state-title">
      <h2 id="empty-state-title" className="empty-state-title">
        {t('empty.title')}
      </h2>
      <p className="empty-state-body">{t('editor.empty')}</p>
      <ul className="empty-state-actions">
        {ACTIONS.map((a) => (
          <li key={a.commandId}>
            <button
              type="button"
              className="empty-state-action"
              disabled={a.needsCtx === true && !p.ready}
              onClick={() => p.onCommand(a.commandId)}
            >
              <Icon name={a.icon} />
              <span className="empty-state-label">{t(a.labelKey)}</span>
              {a.key ? <kbd>{a.key}</kbd> : null}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
