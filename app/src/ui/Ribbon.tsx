import type { KeyboardEvent } from 'react';
import { t } from '../i18n/t';
import { useLang } from '../i18n/useLang';
import { Icon, type IconName } from './Icon';

/** 리본 단추 하나: 등록된 명령 하나를 부른다(명세 §5.5 "모든 동작은 명령이다"). */
interface Item {
  /** 부를 명령의 id(labnote/commands/registry 또는 앱 명령). */
  commandId: string;
  icon: IconName;
  labelKey: string;
  /** 툴팁에 보이는 단축키(보여 주기만 한다: 키는 App 의 처리기가 듣는다). */
  key?: string;
  /** 명령 맥락(보관함 설정)이 있어야 돈다. */
  needsCtx?: boolean;
  /** 사이드바 접기 단추: aria-expanded 로 열림을 알린다. */
  expands?: 'left' | 'right';
}

const TOP: readonly Item[] = [
  { commandId: 'app.toggleLeft', icon: 'panel-left', labelKey: 'ribbon.toggleLeft', key: 'Ctrl+\\', expands: 'left' },
];
const MIDDLE: readonly Item[] = [
  { commandId: 'app.quickSwitcher', icon: 'search', labelKey: 'ribbon.quickSwitcher', key: 'Ctrl+O', needsCtx: true },
  { commandId: 'app.palette', icon: 'terminal', labelKey: 'palette.open', key: 'Ctrl+P', needsCtx: true },
  { commandId: 'create-experiment', icon: 'flask-conical', labelKey: 'ribbon.newExperiment', needsCtx: true },
  { commandId: 'app.newNote', icon: 'file-plus', labelKey: 'ribbon.newNote', key: 'Ctrl+N' },
  { commandId: 'import-scanned-pages', icon: 'scan-barcode', labelKey: 'ribbon.scan', needsCtx: true },
];
const BOTTOM: readonly Item[] = [
  { commandId: 'app.toggleRight', icon: 'panel-right', labelKey: 'ribbon.toggleRight', key: 'Ctrl+Shift+\\', expands: 'right' },
];

/**
 * 왼쪽 끝의 리본(44px, 늘 보인다): 18px 아이콘 단추와 그 툴팁(단축키 포함). 세로 toolbar 라 ↑/↓ 로 단추 사이를 옮긴다.
 * 이름은 aria-label 에 있고 단추에는 글자가 없다. 단추마다 등록된 명령 하나를 부른다(data-command-id).
 */
export function Ribbon(p: { onCommand: (commandId: string) => void; leftHidden: boolean; rightOpen: boolean; ready: boolean }) {
  useLang();
  const button = (item: Item) => {
    const label = t(item.labelKey);
    const expanded = item.expands === 'left' ? !p.leftHidden : item.expands === 'right' ? p.rightOpen : undefined;
    return (
      <button
        key={item.commandId}
        type="button"
        className="ibtn ribbon-btn"
        aria-label={label}
        title={item.key ? t('ribbon.withKey', label, item.key) : label}
        aria-keyshortcuts={item.key ? item.key.replace('Ctrl', 'Control') : undefined}
        aria-expanded={expanded}
        aria-controls={item.expands === 'left' ? 'dock' : item.expands === 'right' ? 'right-dock' : undefined}
        disabled={item.needsCtx && !p.ready}
        data-command-id={item.commandId}
        onClick={() => p.onCommand(item.commandId)}
      >
        <Icon name={item.icon} size={18} />
      </button>
    );
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    if (buttons.length === 0) return;
    e.preventDefault();
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const step = e.key === 'ArrowDown' ? 1 : -1;
    buttons[(at + step + buttons.length) % buttons.length].focus();
  };
  return (
    <div className="ribbon" role="toolbar" aria-orientation="vertical" aria-label={t('ribbon.label')} onKeyDown={onKeyDown}>
      {TOP.map(button)}
      <span className="ribbon-sep" role="separator" />
      {MIDDLE.map(button)}
      <span className="ribbon-spacer" />
      {BOTTOM.map(button)}
    </div>
  );
}
