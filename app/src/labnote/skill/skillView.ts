/** Wording for the SKILL.md section: the status line key and the error text per `SkillErrorKind`. */
import { t } from '../../i18n/t';
import type { SkillError, SkillStatus } from './skillIpc';

/** The status line: not installed, differs from this version, or up to date. */
export function skillStateText(s: Pick<SkillStatus, 'exists' | 'same'>): string {
  if (!s.exists) return t('skill.state.absent');
  return s.same ? t('skill.state.same') : t('skill.state.differs');
}

/** The user-facing text for a skill error. Only `io` carries Rust's message (an OS error, no secret). */
export function skillErrorText(e: SkillError): string {
  switch (e.kind) {
    case 'exists':
      return t('skill.err.exists');
    case 'symlink':
      return t('skill.err.symlink');
    case 'noHome':
      return t('skill.err.noHome');
    default:
      return t('skill.err.io', e.message);
  }
}
