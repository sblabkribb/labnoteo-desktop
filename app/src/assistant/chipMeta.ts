/**
 * The light half of the chips (assistant spec §4.4): ids, labels, the gate and the workflow note name test. No tools, no
 * vault code, so the desktop assistant window can draw the chip bar and the panel from it. `chips.ts` re-exports all of it.
 */
import { t } from '../i18n/t';
import type { ChipId } from './runtime';

export type { ChipId } from './runtime';

export const CHIP_IDS: readonly ChipId[] = ['howTo', 'section', 'unitOp', 'workflow', 'chat'];

/** 칩 이름(지금 언어). 번역 키는 글자 그대로 둔다(카탈로그 검사가 키를 찾는다). */
export function chipLabel(chip: ChipId): string {
  switch (chip) {
    case 'howTo':
      return t('chip.howTo');
    case 'section':
      return t('chip.section');
    case 'unitOp':
      return t('chip.unitOp');
    case 'workflow':
      return t('chip.workflow');
    case 'chat':
      return t('chip.chat');
  }
}

/** 칩이 실험 범위(열린 실험 노트)를 꼭 써야 하는지. 대화는 실험 밖에서도 된다(저장되지 않는다, R3). */
export function chipNeedsScope(chip: ChipId): chip is 'section' | 'unitOp' | 'workflow' {
  return chip === 'section' || chip === 'unitOp' || chip === 'workflow';
}

export type ChipGate = 'ok' | 'noProvider' | 'noScope';

/** 칩을 지금 쓸 수 있는지: 사용법은 늘, 나머지는 AI 제공자가 먼저, 만들기 칩은 실험 노트도. */
export function chipGate(chip: ChipId, s: { provider: boolean; folder: string | null }): ChipGate {
  if (chip === 'howTo') return 'ok';
  if (!s.provider) return 'noProvider';
  if (chipNeedsScope(chip) && s.folder === null) return 'noScope';
  return 'ok';
}

const WORKFLOW_NOTE_RE = /^\d{3}_.*\.md$/i;
const README_RE = /^readme(?:\.labnote)?\.md$/i;

/** 워크플로 노트(`###_….md`, README 는 아니다). 실험 폴더 바로 아래의 파일 이름으로 본다. */
export function isWorkflowNotePath(path: string): boolean {
  const name = path.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? '';
  return WORKFLOW_NOTE_RE.test(name) && !README_RE.test(name);
}
