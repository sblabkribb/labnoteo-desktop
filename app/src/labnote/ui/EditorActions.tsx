import { isValidWorkflowPath } from '@labnoteo/core/lib/workflowStructure';
import { t } from '../../i18n/t';
import { useLang } from '../../i18n/useLang';
import type { CommandContext } from '../commands/context';
import { runCommand } from '../commands/runCommand';
import { insertUnitOp } from '../commands/unitOp';
import { createWorkflow, isExperimentReadme } from '../commands/workflow';
import { coreT } from '../i18n';

interface Props {
  ctx: CommandContext;
  /** 편집기에 열린 노트. */
  path: string;
  /** 편집기가 바쁜 동안(읽는 중, 대화상자, 풀리지 않은 바깥 변경) true: 표 넣기 단추와 같은 규칙. */
  disabled: boolean;
}

/**
 * 편집기 머리("표 넣기" 옆)의 노트 단추. 워크플로 노트에는 "유닛 오퍼레이션 삽입", 실험 README 에는 "워크플로 생성".
 * 그 밖의 노트에는 아무것도 그리지 않는다. 이름은 플러그인 명령 이름(coreT)이고 그릴 때의 언어다.
 */
export function EditorActions({ ctx, path, disabled }: Props) {
  useLang();
  const action = isValidWorkflowPath(path)
    ? { label: coreT('Insert unit operation'), run: () => insertUnitOp(ctx) }
    : isExperimentReadme(path)
      ? { label: coreT('Create workflow'), run: () => createWorkflow(ctx) }
      : undefined;
  if (!action) return null;
  return (
    <span role="group" aria-label={t('editorActions.label')} className="editor-actions">
      <button type="button" className="secondary" disabled={disabled} onClick={() => void runCommand(ctx, action.run)}>
        {action.label}
      </button>
    </span>
  );
}
