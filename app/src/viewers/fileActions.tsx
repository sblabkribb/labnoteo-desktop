import { ERROR_KINDS, hasErrorKind } from '../fs/errorKinds';
import { openWithDefaultApp, revealInFolder } from '../fs/vaultOpen';
import { t } from '../i18n/t';
import { useLang } from '../i18n/useLang';
import { notify } from '../labnote/host/toastStore';
import { Icon } from '../ui/Icon';

const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);

function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string') return (e as { message: string }).message;
  return String(e);
}

/** 기본 앱으로 연다(Rust `vault_open_default`). 거부·실패는 경고 알림이다(조용히 넘어가지 않는다). */
export async function openOrWarn(path: string): Promise<void> {
  try {
    await openWithDefaultApp(path);
  } catch (e) {
    notify('warn', hasErrorKind(e, ERROR_KINDS.badInput) ? t('viewer.notOpenable', nameOf(path)) : t('viewer.openFailed', messageOf(e)));
  }
}

/** 탐색기에서 골라 보인다(Rust `vault_reveal`). */
export async function revealOrWarn(path: string): Promise<void> {
  try {
    await revealInFolder(path);
  } catch (e) {
    notify('warn', t('viewer.openFailed', messageOf(e)));
  }
}

/** 보기 화면의 읽기 실패를 사람의 말로. `cap` 은 그 보기 화면의 상한(예: '50 MiB'). */
export function readFailure(e: unknown, cap: string): string {
  if (hasErrorKind(e, ERROR_KINDS.tooLarge)) return t('viewer.tooLarge', cap);
  return t('viewer.readFailed', messageOf(e));
}

/** 기본 앱으로 열기, 폴더에서 보기. `compact` 면 아이콘 단추(보기 도구 막대), 아니면 글 단추(파일 카드). */
export function FileActions(p: { path: string; compact?: boolean }) {
  useLang();
  const open = t('menu.openDefault');
  const reveal = t('menu.reveal');
  if (p.compact) {
    return (
      <>
        <button type="button" className="ibtn" aria-label={open} title={open} onClick={() => void openOrWarn(p.path)}>
          <Icon name="external-link" />
        </button>
        <button type="button" className="ibtn" aria-label={reveal} title={reveal} onClick={() => void revealOrWarn(p.path)}>
          <Icon name="folder-search" />
        </button>
      </>
    );
  }
  return (
    <div className="file-card-actions">
      <button type="button" className="btn primary" onClick={() => void openOrWarn(p.path)}>
        <Icon name="external-link" size={14} />
        <span>{open}</span>
      </button>
      <button type="button" className="btn" onClick={() => void revealOrWarn(p.path)}>
        <Icon name="folder-search" size={14} />
        <span>{reveal}</span>
      </button>
    </div>
  );
}
