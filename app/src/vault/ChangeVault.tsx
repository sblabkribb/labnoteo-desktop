import { t } from '../i18n/t';

interface Props {
  /** 저장 안 된 편집을 저장한다. false 면 편집이 남아 있다. */
  flush: () => Promise<boolean>;
  /** 보관함 선택 화면으로 돌아간다. */
  onChange: () => void;
}

/**
 * 다른 보관함으로 바꾸는 단추. 잘못 고른 폴더에서 빠져나올 길이다.
 * 저장 안 된 편집이 있으면 먼저 저장하고, 저장하지 못하면(충돌 등) 떠나지 않는다 — 편집이 사라지지 않게.
 */
export function ChangeVault({ flush, onChange }: Props) {
  return (
    <button
      type="button"
      onClick={async () => {
        if (await flush()) onChange();
      }}
    >
      {t('vault.change')}
    </button>
  );
}
