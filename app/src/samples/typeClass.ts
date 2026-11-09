/**
 * 샘플 종류별 색 클래스. 기본 종류(SAMPLE_TYPES)는 대소문자를 그대로 가려 자기 클래스를 받고,
 * 사용자 정의 종류(한글 포함)와 대소문자가 다른 이름은 모두 한 가지 custom 클래스를 받는다.
 * 색은 theme.ts 의 규칙이 styles/tokens.css 의 --sample-<x>-bg 토큰으로 칠한다.
 */
import { SAMPLE_TYPES } from '@labnoteo/core/lib/sampleUtils';

export const BUILTIN_SAMPLE_CLASS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(SAMPLE_TYPES.map((type) => [type, `lno-sample-t-${type.toLowerCase()}`])),
);

export const CUSTOM_SAMPLE_CLASS = 'lno-sample-t-custom';

export function sampleTypeClass(type: string): string {
  return Object.prototype.hasOwnProperty.call(BUILTIN_SAMPLE_CLASS, type) ? BUILTIN_SAMPLE_CLASS[type] : CUSTOM_SAMPLE_CLASS;
}
