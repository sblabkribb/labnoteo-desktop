import { isValidWorkflowPath } from '@labnoteo/core/lib/workflowStructure';
import { t } from '../../i18n/t';
import { useLang } from '../../i18n/useLang';
import { Icon } from '../../ui/Icon';
import type { CommandContext } from '../commands/context';
import { runCommand } from '../commands/runCommand';
import { insertUnitOp } from '../commands/unitOp';
import { createWorkflow, isExperimentReadme } from '../commands/workflow';
import { coreT } from '../i18n';
import { showBarcode } from '../port/barcodeActions';
import { isBarcodeNote } from '../port/noteIdService';

interface Props {
  ctx: CommandContext;
  /** 편집기에 열린 노트. */
  path: string;
  /** 편집기가 바쁜 동안(읽는 중, 대화상자, 풀리지 않은 바깥 변경) true: 표 넣기 단추와 같은 규칙. */
  disabled: boolean;
}

/**
 * 보기 머리의 하나뿐인 주 동작: 워크플로 노트는 "UO 추가"(유닛 오퍼레이션 삽입), 실험 README 는 "워크플로 추가"
 * (워크플로 생성). 그 밖의 노트에는 그리지 않는다.
 */
export function EditorActions({ ctx, path, disabled }: Props) {
  useLang();
  const action = isValidWorkflowPath(path)
    ? { label: t('header.addUo'), title: coreT('Insert unit operation'), run: () => insertUnitOp(ctx) }
    : isExperimentReadme(path)
      ? { label: t('header.addWorkflow'), title: coreT('Create workflow'), run: () => createWorkflow(ctx) }
      : undefined;
  if (!action) return null;
  return (
    <button
      type="button"
      className="btn primary view-primary"
      title={action.title}
      disabled={disabled}
      onClick={() => void runCommand(ctx, action.run)}
    >
      <Icon name="plus" />
      <span>{action.label}</span>
    </button>
  );
}

/** 모든 `*.labnote.md` 의 "노트 바코드 보기" 아이콘 단추(플러그인 머리의 QR 아이콘). 그 밖의 노트에는 그리지 않는다. */
export function NoteQrButton({ ctx, path, disabled }: Props) {
  useLang();
  if (!isBarcodeNote(path)) return null;
  return (
    <button
      type="button"
      className="ibtn editor-qr"
      aria-label={coreT('Show note barcode')}
      title={coreT('Show note barcode')}
      disabled={disabled}
      onClick={() => void runCommand(ctx, () => showBarcode(ctx, path))}
    >
      <Icon name="qr-code" />
    </button>
  );
}
