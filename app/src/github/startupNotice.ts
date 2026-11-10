import { t } from '../i18n/t';
import type { FolderStatus } from '../integrations/githubIpc';
import type { NotifyOpts } from '../labnote/host/toastStore';
import { isUnfinished, refreshGithubStatuses, currentGithubStatuses } from './statusStore';

/** 끝나지 않은 올리기의 수와 그 첫 폴더(P-R9). 없으면 null. `pushed` 와 `planned` 는 끝나지 않은 것이 아니다. */
export function unfinishedNotice(statuses: Readonly<Record<string, FolderStatus>>): { count: number; folder: string } | null {
  const open = Object.keys(statuses).filter((folder) => isUnfinished(statuses[folder]));
  return open.length === 0 ? null : { count: open.length, folder: open[0] };
}

export interface NoticeDeps {
  load?: () => Promise<Record<string, FolderStatus>>;
  notify(kind: 'warn', message: string, opts: NotifyOpts): void;
  /** "마저 하기": 그 폴더의 `github.finishUpload` 흐름. */
  finish(folder: string): Promise<unknown> | unknown;
}

/**
 * 보관함을 열 때: 상태 저장소를 채우고, 끝나지 않은 올리기가 있으면 `warn` 알림 하나를 [마저 하기] 단추와 함께 보인다.
 * 네트워크를 쓰지 않고, 읽지 못하면 아무 말도 하지 않는다(여는 것을 막지 않는다).
 */
export async function githubNoticeOnOpen(deps: NoticeDeps): Promise<void> {
  await refreshGithubStatuses(deps.load);
  const notice = unfinishedNotice(currentGithubStatuses());
  if (!notice) return;
  const folder = notice.folder;
  deps.notify('warn', t('github.startup.unfinished', notice.count), {
    action: { label: t('github.startup.finish'), run: () => void deps.finish(folder) },
  });
}

/** 보관함 화면 하나에서 한 번만 돈다(보관함을 다시 열면 화면이 새로 만들어 새 가드를 쓴다). */
export function onceForThisVault(run: () => Promise<void>): () => Promise<void> {
  let ran = false;
  return async () => {
    if (ran) return;
    ran = true;
    await run();
  };
}
