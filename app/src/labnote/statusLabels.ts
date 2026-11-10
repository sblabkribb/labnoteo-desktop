/**
 * 상태 값(파일에 적힌 그대로)을 화면에 보일 이름과 모양으로 바꾼다. 저장 값은 바꾸지 않는다: `status: in-progress` 는
 * 그대로 두고 "진행 중 / In progress" 로 그리기만 한다(플러그인 파일 호환).
 */
import type { ExperimentStatus } from '@labnoteo/core';
import { EXPERIMENT_STATUSES } from '@labnoteo/core';
import { t } from '../i18n/t';
import { coreT } from './i18n';
import { statusNames } from './port/status';

export type StatusKind = 'planned' | 'inProgress' | 'done';
export type StatusShape = 'dashed' | 'half' | 'check';

const fold = (raw: string) => raw.trim().toLowerCase().replace(/_/g, '-');

/** 세 가지 큰 상태 중 하나. 그 밖의 값(검토 필요 등, 모르는 값)은 undefined. */
export function statusKind(raw: string): StatusKind | undefined {
  const v = fold(raw);
  if (v === 'planned') return 'planned';
  if (v === 'in-progress') return 'inProgress';
  if (v === 'done' || v === 'completed') return 'done';
  return undefined;
}

/** 화면에 보일 이름: 계획 / 진행 중 / 완료, 플러그인의 다른 상태는 그 이름(검토 필요…), 모르는 값은 적힌 그대로. */
export function statusLabel(raw: string): string {
  switch (statusKind(raw)) {
    case 'planned':
      return t('status.planned');
    case 'inProgress':
      return t('status.inProgress');
    case 'done':
      return t('status.done');
  }
  const v = fold(raw);
  if ((EXPERIMENT_STATUSES as readonly string[]).includes(v)) return statusNames({ t: coreT })[v as ExperimentStatus];
  return raw;
}

/** 상태 칩의 아이콘 모양: 계획은 점선 원, 진행 중은 반쪽 원, 완료는 체크. 그 밖은 점선 원. */
export function statusShape(raw: string): StatusShape {
  const kind = statusKind(raw);
  const v = fold(raw);
  if (kind === 'done') return 'check';
  if (kind === 'inProgress' || v === 'needs-review' || v === 'needs-repeat') return 'half';
  return 'dashed';
}
