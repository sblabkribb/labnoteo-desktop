import { useSyncExternalStore } from 'react';
import { t } from '../i18n/t';
import { githubStatuses, type FolderStatus } from '../integrations/githubIpc';
import type { TreeBadge } from '../labnote/panel/TreeView';

/**
 * 실험 폴더마다의 GitHub 연결 상태(`github_statuses`, 네트워크 없이 Rust 가 만든다). 메뉴는 여는 순간 동기로 만들어지므로
 * 평범한 getter(`githubStatusOf`)로 읽고, 실험 탭은 `useGithubStatuses` 로 구독한다(toastStore 와 같은 꼴).
 * 보관함을 열 때, 올리기·끝맺기·연결 끊기 뒤, 보관함 밖의 변경 뒤에 다시 채운다.
 */
type Statuses = Readonly<Record<string, FolderStatus>>;

let statuses: Statuses = {};
/** 마지막으로 시작한 읽기: 늦게 온 앞선 답이 새 답을 덮지 않게 한다. */
let generation = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function setGithubStatuses(next: Record<string, FolderStatus>): void {
  generation++;
  statuses = { ...next };
  emit();
}

/** 한 폴더의 상태. 연결 기록이 없는 폴더는 undefined. */
export function githubStatusOf(folder: string): FolderStatus | undefined {
  return Object.prototype.hasOwnProperty.call(statuses, folder) ? statuses[folder] : undefined;
}

export function currentGithubStatuses(): Statuses {
  return statuses;
}

/** 연결을 끊은 폴더를 바로 지운다(다음 읽기를 기다리지 않는다). */
export function forgetGithubStatus(folder: string): void {
  if (!Object.prototype.hasOwnProperty.call(statuses, folder)) return;
  const { [folder]: _gone, ...rest } = statuses;
  void _gone;
  statuses = rest;
  emit();
}

/** 상태를 다시 읽는다. 실패하면(Rust 가 없거나 보관함이 바뀌는 중) 있던 것을 그대로 둔다. */
export async function refreshGithubStatuses(load: () => Promise<Record<string, FolderStatus>> = () => githubStatuses()): Promise<void> {
  const mine = ++generation;
  let next: Record<string, FolderStatus> | undefined;
  try {
    next = await load();
  } catch {
    return;
  }
  if (mine !== generation || !next || typeof next !== 'object') return;
  statuses = { ...next };
  emit();
}

let timer: ReturnType<typeof setTimeout> | undefined;
/** 보관함 밖의 변경이 몰려 올 때: 마지막 변경 `ms` 뒤에 한 번 다시 읽는다. */
export function scheduleGithubStatusRefresh(ms = 1500): void {
  if (timer !== undefined) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = undefined;
    void refreshGithubStatuses();
  }, ms);
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useGithubStatuses(): Statuses {
  return useSyncExternalStore(subscribe, currentGithubStatuses, currentGithubStatuses);
}

/** 보관함을 떠날 때와 테스트에서. */
export function resetGithubStatusesForTest(): void {
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  generation++;
  statuses = {};
  emit();
}
export const clearGithubStatuses = resetGithubStatusesForTest;

export type StatusKind = 'synced' | 'changed' | 'unfinished';

/** 올리기 기록이 중간 단계에 멈췄는가(저장소 만드는 중, 저장소만 있음, 커밋만 있음). */
export function isUnfinished(s: FolderStatus | undefined): boolean {
  return s !== undefined && s.state !== 'pushed' && s.state !== 'planned';
}

/** 메뉴·명령·표시가 함께 쓰는 갈래. 연결이 없으면 undefined. */
export function statusKind(s: FolderStatus | undefined): StatusKind | undefined {
  if (!s) return undefined;
  if (isUnfinished(s)) return 'unfinished';
  if (!s.linked) return undefined;
  return s.changedCount > 0 ? 'changed' : 'synced';
}

/** 실험 줄의 표시(spec §5.1): 모양과 글이 상태마다 다르다. */
export function statusBadge(s: FolderStatus | undefined): TreeBadge | undefined {
  switch (statusKind(s)) {
    case 'synced':
      return { icon: 'cloud-check', label: t('github.status.synced') };
    case 'changed':
      return { icon: 'cloud-upload', label: t('github.status.changed', s!.changedCount) };
    case 'unfinished':
      return { icon: 'cloud-alert', label: t('github.status.unfinished') };
    default:
      return undefined;
  }
}
