import { t } from '../i18n/t';
import type { ApiFailure } from '../integrations/githubIpc';

/** 기다릴 초를 분으로(올림, 적어도 1분). `rateLimited{120}` → 2. */
export function minutesOf(seconds: number): number {
  return Math.max(1, Math.ceil(seconds / 60));
}

/** GitHub 답(`ApiOutcome` 의 실패)을 사용자에게 보일 한 문장으로. */
export function apiFailureText(o: ApiFailure): string {
  switch (o.outcome) {
    case 'needsSignIn':
      return t('github.err.needsSignIn');
    case 'orgRestricted':
      return t('github.err.orgRestricted', o.org);
    case 'ssoRequired':
      return t('github.err.sso');
    case 'cannotCreateInOrg':
      return t('github.err.cannotCreate');
    case 'rateLimited':
      return t('github.err.rateLimited', minutesOf(o.seconds));
    case 'nameTaken':
      return t('github.dest.taken');
    case 'notFoundOrNoAccess':
    case 'moved':
      return t('github.err.notFound');
    case 'legalBlock':
      return t('github.err.legal', o.message);
    case 'other':
      return t('github.err.apiLeg');
  }
}
