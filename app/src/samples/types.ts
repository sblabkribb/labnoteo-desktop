import { getSampleDisplayMeta } from '@labnoteo/core/lib/sampleUtils';
import type { AppSettings } from '../labnote/settings';

let lastInput: readonly string[] | undefined;
let lastTypes: string[] = [];

/**
 * 내장 종류 다음에 저장된 사용자 종류를 모두 잇는다: `getSampleDisplayMeta(settings.customSampleTypes).types`,
 * 거르지 않는다(예전 판이 저장한 잘못된 이름도 그 `{Type}.json` 과 ID 가 이어지도록 남는다).
 * 이름 검사는 설정 대화상자에서만 한다. 같은 배열이면 같은 결과를 돌려준다(배열 정체성으로 기억).
 */
export function sampleTypesFor(settings: Pick<AppSettings, 'customSampleTypes'>): string[] {
  const input = settings.customSampleTypes;
  if (input !== lastInput) {
    lastInput = input;
    lastTypes = getSampleDisplayMeta(input).types;
  }
  return lastTypes;
}
