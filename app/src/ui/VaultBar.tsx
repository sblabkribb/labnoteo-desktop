import type { MouseEvent } from 'react';
import { t } from '../i18n/t';
import { useLang } from '../i18n/useLang';
import type { CommandContext } from '../labnote/commands/context';
import { openMenu } from '../labnote/ui/menuStore';
import { Icon } from './Icon';

interface Props {
  /** 보관함 이름(폴더 이름). */
  name: string;
  /** 보관함의 절대 경로(툴팁). */
  root: string;
  /** 명령 맥락. 설정을 읽기 전이면 undefined: 그때도 보관함 바꾸기는 된다. */
  ctx: CommandContext | undefined;
  /** 저장 안 된 편집을 저장한 뒤 보관함 선택 화면으로 간다(저장하지 못하면 떠나지 않는다). */
  onSwitchVault: () => Promise<void>;
  /** 설정 창을 연다(Ctrl+, 와 같다). */
  onOpenSettings: () => void;
}

/** 왼쪽 독 맨 아래의 보관함 줄(40px): 보관함 아이콘과 이름, ⇅ 메뉴(보관함 바꾸기), 설정 톱니(설정 창, Ctrl+,). */
export function VaultBar({ name, root, ctx, onSwitchVault, onOpenSettings }: Props) {
  useLang();
  const openVaultMenu = (e: MouseEvent<HTMLButtonElement>) => {
    // 맥락이 아직 없으면(설정을 읽는 중) 메뉴 없이 바로 바꾼다: 잘못 고른 폴더에서 늘 빠져나올 수 있어야 한다
    if (!ctx) return void onSwitchVault();
    openMenu(ctx, { element: e.currentTarget }, [{ labelKey: 'vault.change', run: onSwitchVault }]);
  };
  return (
    <div className="vault-bar" role="group" aria-label={t('vault.bar')}>
      <Icon name="vault" size={16} />
      <span className="vault-bar-name" title={root}>
        {name}
      </span>
      <button type="button" className="ibtn" aria-label={t('vault.menu')} title={t('vault.menu')} aria-haspopup="menu" onClick={openVaultMenu}>
        <Icon name="chevrons-up-down" size={16} />
      </button>
      <button
        type="button"
        className="ibtn"
        aria-label={t('vault.settings')}
        title={t('ribbon.withKey', t('vault.settings'), 'Ctrl+,')}
        aria-haspopup="dialog"
        aria-keyshortcuts="Control+,"
        disabled={!ctx}
        onClick={onOpenSettings}
      >
        <Icon name="settings" size={16} />
      </button>
    </div>
  );
}
