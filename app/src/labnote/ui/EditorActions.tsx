import { isValidWorkflowPath } from '@labnoteo/core/lib/workflowStructure';
import { t } from '../../i18n/t';
import { useLang } from '../../i18n/useLang';
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

/** 바코드 단추의 QR 모양(장식, 글자 색). 세 모서리의 찾기 무늬와 점 몇 개. */
function QrGlyph() {
  return (
    <svg aria-hidden="true" fill="currentColor" viewBox="0 0 16 16" width="16" height="16">
      <path d="M1 1h6v6H1zm1.5 1.5v3h3v-3zM9 1h6v6H9zm1.5 1.5v3h3v-3zM1 9h6v6H1zm1.5 1.5v3h3v-3z" fillRule="evenodd" />
      <path d="M3 3h2v2H3zm8 0h2v2h-2zM3 11h2v2H3zm6-2h2v2H9zm4 0h2v2h-2zm-2 2h2v2h-2zm-2 2h2v2H9zm4 0h2v2h-2z" />
    </svg>
  );
}

/**
 * 편집기 머리("표 넣기" 옆)의 노트 단추. 워크플로 노트에는 "유닛 오퍼레이션 삽입", 실험 README 에는 "워크플로 생성".
 * 모든 `*.labnote.md` 에는 그 옆에 "노트 바코드 보기" 아이콘 단추(플러그인 머리의 QR 아이콘)가 붙는다.
 * 그 밖의 노트에는 아무것도 그리지 않는다. 이름은 플러그인 명령 이름(coreT)이고 그릴 때의 언어다.
 */
export function EditorActions({ ctx, path, disabled }: Props) {
  useLang();
  const action = isValidWorkflowPath(path)
    ? { label: coreT('Insert unit operation'), run: () => insertUnitOp(ctx) }
    : isExperimentReadme(path)
      ? { label: coreT('Create workflow'), run: () => createWorkflow(ctx) }
      : undefined;
  const barcode = isBarcodeNote(path);
  if (!action && !barcode) return null;
  return (
    <span role="group" aria-label={t('editorActions.label')} className="editor-actions">
      {action ? (
        <button type="button" className="secondary" disabled={disabled} onClick={() => void runCommand(ctx, action.run)}>
          {action.label}
        </button>
      ) : null}
      {barcode ? (
        <button
          type="button"
          className="icon editor-qr"
          aria-label={coreT('Show note barcode')}
          title={coreT('Show note barcode')}
          disabled={disabled}
          onClick={() => void runCommand(ctx, () => showBarcode(ctx, path))}
        >
          <QrGlyph />
        </button>
      ) : null}
    </span>
  );
}
