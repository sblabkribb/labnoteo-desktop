import { t } from '../../i18n/t';
import { appCommands, displayKey } from '../../editor/commands/appCommands';

/**
 * 설정 → 단축키: 명령 목록(appCommands 의 key)에서 읽은 표. 읽기만 한다. 키는 표시용 이름(displayKey: Ctrl+…)이다.
 * 명령 팔레트(app.palette)도 이 목록에 있다(팔레트 안에는 보이지 않을 뿐이다).
 */
export function ShortcutsPage() {
  const rows = appCommands()
    .filter((c) => c.key)
    .map((c) => ({ id: c.id, name: t(c.nameKey), key: displayKey(c.key!) }));
  return (
    <>
      <p className="setting-desc settings-lead">{t('settings.shortcuts.desc')}</p>
      <table className="shortcut-table">
        <thead>
          <tr>
            <th scope="col">{t('settings.shortcuts.command')}</th>
            <th scope="col">{t('settings.shortcuts.key')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.name}</td>
              <td>
                <kbd>{r.key}</kbd>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
