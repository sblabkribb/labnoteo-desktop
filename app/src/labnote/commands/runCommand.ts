import { WINDOWS_PATH_MAX, isPathTooLongError } from '@labnoteo/core/lib/regexUtils';
import { t } from '../../i18n/t';
import { ERROR_KINDS, hasErrorKind } from '../../fs/errorKinds';
import { linkOps } from '../../links/renameWithLinks';
import { coreT } from '../i18n';
import { NoteBusyError, NoteChangedError, NoteGoneError, NoteSaveError } from '../noteErrors';
import type { CommandContext } from './context';
import type { Command } from './registry';

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return String(err);
}

/**
 * 명령을 돌리고 모든 실패를 알림으로 바꾼다(플러그인 main.ts 의 run 과 같다). 던지지 않는다.
 * 팔레트 항목, 메뉴 항목, 패널 동작, 머리 단추가 모두 이것을 거친다: 삼킨 거부 때문에 "아무 일도 안 일어나는" 명령이 없게.
 */
export async function runCommand(ctx: CommandContext, c: Command | (() => Promise<unknown>)): Promise<void> {
  // 링크를 고치는 동안 다른 명령이 노트를 바꾸면 고침의 계획이 낡는다(플러그인 이슈 #41): 끝날 때까지 거절한다
  if (linkOps.running()) {
    ctx.host.notify('warn', t('links.busy'));
    return;
  }
  try {
    await (typeof c === 'function' ? c() : c.run(ctx));
  } catch (err) {
    console.error('[labnoteo] command failed:', err);
    const { host } = ctx;
    if (isPathTooLongError(err) || hasErrorKind(err, ERROR_KINDS.pathTooLong)) {
      host.notify(
        'error',
        coreT(
          'Command failed: the path is too long for the file system (Windows allows {0} characters including the vault folder). Move the vault to a shorter folder path, or shorten the title or alias.',
          String(WINDOWS_PATH_MAX - 1),
        ),
      );
    } else if (err instanceof NoteBusyError) {
      host.notify('warn', t('command.noteBusy'));
    } else if (err instanceof NoteSaveError) {
      host.notify('error', t('command.noteNotSaved'));
    } else if (err instanceof NoteChangedError) {
      host.notify('warn', t('command.noteChanged'));
    } else if (err instanceof NoteGoneError) {
      host.notify('warn', t('command.noteGone'));
    } else {
      host.notify('error', coreT('Command failed: {0}', messageOf(err)));
    }
  }
}
