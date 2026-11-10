import { t } from '../../i18n/t';
import { appCommands, displayKey } from '../../editor/commands/appCommands';

/** 명령 팔레트는 명령 목록에 없다(팔레트를 여는 키라서): 표의 맨 위에 따로 적는다. */
const PALETTE_KEY = 'Mod-p';

/**
 * 설정 → 단축키: 명령 목록(appCommands 의 key)에서 읽은 표. 읽기만 한다. 키는 표시용 이름(displayKey: Ctrl+…)이다.
 */
export function ShortcutsPage() {
  const rows = [
    { id: 'palette', name: t('palette.open'), key: displayKey(PALETTE_KEY) },
    ...appCommands()
      .filter((c) => c.key)
      .map((c) => ({ id: c.id, name: t(c.nameKey), key: displayKey(c.key!) })),
  ];
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
