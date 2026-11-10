import { useEffect, useRef, useState } from 'react';
import { t } from '../i18n/t';
import { useLang } from '../i18n/useLang';
import { LANG_NAMES, LANGS, type Lang } from '../i18n/lang';
import type { Theme } from '../theme/useTheme';
import { Icon } from './Icon';
import { Popover } from './Popover';
import { Segmented } from './Segmented';
import { SelectMenu } from './SelectMenu';

/** 모든 설정 열기의 단축키(보여 주기만 한다: 키는 App 의 처리기가 듣는다). */
export const SETTINGS_KEY = 'Ctrl+,';

interface Props {
  theme: Theme;
  onTheme: (theme: Theme) => void;
  lang: Lang;
  onLang: (lang: Lang) => void;
  onOpenSettings: () => void;
}

/** 모양 창의 내용: 테마(시스템 / 밝게 / 어둡게), 언어, 그리고 "모든 설정 열기 Ctrl+,". */
export function AppearancePanel(p: Props & { onDone: () => void }) {
  useLang();
  return (
    <>
      <div className="popover-row">
        <span className="popover-label">
          {t('theme.label')}
        </span>
        <Segmented<Theme>
          label={t('theme.label')}
          value={p.theme}
          onChange={p.onTheme}
          options={[
            { value: 'system', label: t('appearance.system') },
            { value: 'light', label: t('appearance.light') },
            { value: 'dark', label: t('appearance.dark') },
          ]}
        />
      </div>
      <div className="popover-row">
        <span className="popover-label">{t('lang.label')}</span>
        <SelectMenu<Lang>
          label={t('lang.label')}
          value={p.lang}
          onChange={p.onLang}
          options={LANGS.map((l) => ({ value: l, label: LANG_NAMES[l], lang: l }))}
        />
      </div>
      <button
        type="button"
        className="popover-footer"
        aria-keyshortcuts="Control+,"
        onClick={() => {
          p.onDone();
          p.onOpenSettings();
        }}
      >
        <span>{t('appearance.allSettings')}</span>
        <kbd>{SETTINGS_KEY}</kbd>
      </button>
    </>
  );
}

const openRequests = new Set<() => void>();

/** 모양 창을 연다(팔레트의 app.appearance). 상태 줄의 모양 단추가 듣는다. 단추가 없으면 아무 일도 없다. */
export function requestAppearance(): void {
  [...openRequests].forEach((open) => open());
}

/** 상태 줄 오른쪽 끝의 모양 단추(sun-moon)와 그 창. */
export function AppearanceButton(p: Props) {
  useLang();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const open = () => setOpen(true);
    openRequests.add(open);
    return () => void openRequests.delete(open);
  }, []);
  const close = ({ restoreFocus }: { restoreFocus: boolean }) => {
    setOpen(false);
    if (restoreFocus) button.current?.focus();
  };
  return (
    <>
      <button
        ref={button}
        type="button"
        className="statusbar-item statusbar-button"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={t('appearance.button')}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="sun-moon" size={14} />
        <span>{t('appearance.button')}</span>
      </button>
      {open && button.current && (
        <Popover anchor={button.current} label={t('appearance.button')} placement="above" className="appearance-popover" onClose={close}>
          <AppearancePanel {...p} onDone={() => setOpen(false)} />
        </Popover>
      )}
    </>
  );
}
