import { getSeoulDateString, touchLastUpdatedDate } from '@labnoteo/core/lib/dateUtils';
import type { AppSettings } from '../settings';
import { appUpkeep } from './autoUpkeep';

/**
 * 명령이 README 를 고칠 때 `last_updated_date` 를 오늘(서울)로 바꾸는 변환(플러그인 main.ts 의 stampLastUpdated).
 * 설정의 autoUpdateLastUpdated 가 꺼져 있으면 그대로 돌려준다.
 * `path` 를 주면 그 노트의 날짜를 오늘 손으로 정했을 때 그대로 둔다(플러그인 lastUpdatedTracker, Task 20 의 autoUpkeep 이 기억한다).
 * 편집 중의 자동 찍기와 워크플로 → README 전파는 commands/autoUpkeep.ts 가 한다.
 */
export function readmeStamp(settings: AppSettings): (content: string, path?: string) => string {
  if (!settings.autoUpdateLastUpdated) return (c) => c;
  return (c, path) => (path !== undefined && appUpkeep()?.keepsHandSet(path) ? c : touchLastUpdatedDate(c, getSeoulDateString()));
}
