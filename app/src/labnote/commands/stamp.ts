import { getSeoulDateString, touchLastUpdatedDate } from '@labnoteo/core/lib/dateUtils';
import type { AppSettings } from '../settings';

/**
 * 명령이 README 를 고칠 때 `last_updated_date` 를 오늘(서울)로 바꾸는 변환(플러그인 main.ts 의 stampLastUpdated).
 * 설정의 autoUpdateLastUpdated 가 꺼져 있으면 그대로 돌려준다.
 * 플러그인의 "손으로 정한 날짜는 두기"(lastUpdatedTracker)는 편집기 자동화와 함께 뒤의 하위 프로젝트에서 온다.
 */
export function readmeStamp(settings: AppSettings): (content: string) => string {
  return settings.autoUpdateLastUpdated ? (c) => touchLastUpdatedDate(c, getSeoulDateString()) : (c) => c;
}
