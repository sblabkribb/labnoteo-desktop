import { useLayoutEffect, type MouseEvent, type RefObject } from 'react';
import { useLang } from '../../i18n/useLang';
import { AliasDialog } from './AliasDialog';
import { ChoiceDialog } from './ChoiceDialog';
import { ConfirmDialog } from './ConfirmDialog';
import { settleDialog, takeReturnFocus, useCurrentDialog, type DialogEntry } from './dialogStore';
import { PickManyDialog, Picker } from './Picker';
import { PromptDialog } from './PromptDialog';
import { SampleDefinitionDialog } from '../../samples/SampleDefinitionDialog';
import { ProgressDialog } from '../../integrations/ProgressDialog';
import { SettingsModal } from '../../ui/SettingsModal';
import { restoreFocusTo } from '../../ui/returnFocus';
import { PartbankSearchDialog } from '../../partbank/PartbankSearchDialog';
import { AiAnswerDialog } from '../port/aiAnswerDialog';
import { WorksheetDialog } from '../print/WorksheetDialog';
import { BarcodeDialog } from '../port/barcodeDialog';
import { ImportDialog } from '../scan/ImportDialog';
import { ResultsDialog } from '../scan/ResultsDialog';
import { UnmatchedDialog } from '../scan/UnmatchedDialog';
import { NewNoteDialog } from '../../tree/NewNoteDialog';
import { NewExperimentDialog } from '../ui/NewExperimentDialog';
import { ContextSourcesDialog } from '../context/ContextSourcesDialog';
import { SkinImportDialog } from '../../assistant/skins/ImportDialog';

/** App.tsx 가 .shell 밖, 알림 층 뒤에 그리는 도우미 층의 id. */
export const PET_LAYER_ID = 'pet-layer';

function Body({ entry }: { entry: DialogEntry }) {
  const onDone = (value: unknown) => settleDialog(entry.id, value);
  const onCancel = () => settleDialog(entry.id, entry.cancelValue);
  const { spec } = entry;
  switch (spec.kind) {
    case 'pick':
      return <Picker spec={spec} onDone={onDone} onCancel={onCancel} />;
    case 'pickMany':
      return <PickManyDialog spec={spec} onDone={onDone} onCancel={onCancel} />;
    case 'prompt':
      return <PromptDialog spec={spec} onDone={onDone} onCancel={onCancel} />;
    case 'alias':
      return <AliasDialog spec={spec} onDone={onDone} onCancel={onCancel} />;
    case 'confirm':
      return <ConfirmDialog spec={spec} onDone={onDone} onCancel={onCancel} />;
    case 'choice':
      return <ChoiceDialog spec={spec} onDone={onDone} onCancel={onCancel} />;
    case 'sampleDefinition':
      return <SampleDefinitionDialog spec={spec} onDone={onDone} onCancel={onCancel} />;
    case 'progress':
      return <ProgressDialog spec={spec} onCancel={onCancel} />;
    case 'settings':
      return <SettingsModal spec={spec} onDone={onDone} onCancel={onCancel} />;
    case 'partbankSearch':
      return <PartbankSearchDialog spec={spec} onDone={onDone} onCancel={onCancel} />;
    case 'aiAnswer':
      return <AiAnswerDialog spec={spec} onDone={onDone} onCancel={onCancel} />;
    case 'worksheet':
      return <WorksheetDialog spec={spec} onDone={onDone} onCancel={onCancel} />;
    case 'barcode':
      return <BarcodeDialog spec={spec} onDone={onDone} onCancel={onCancel} />;
    case 'scanImport':
      return <ImportDialog spec={spec} onDone={onDone} onCancel={onCancel} />;
    case 'scanResults':
      return <ResultsDialog spec={spec} onDone={onDone} onCancel={onCancel} />;
    case 'scanUnmatched':
      return <UnmatchedDialog spec={spec} onDone={onDone} onCancel={onCancel} />;
    case 'newNote':
      return <NewNoteDialog spec={spec} onDone={onDone} onCancel={onCancel} />;
    case 'newExperiment':
      return <NewExperimentDialog spec={spec} onDone={onDone} onCancel={onCancel} />;
    case 'aiContextSources':
      return <ContextSourcesDialog spec={spec} onDone={onDone} onCancel={onCancel} />;
    case 'skinImport':
      return <SkinImportDialog spec={spec} onDone={onDone} onCancel={onCancel} />;
  }
}

/**
 * 저장소(dialogStore)의 지금 대화상자를 그린다. .shell 밖에 그려야 한다: 대화상자가 열려 있는 동안 `blockRef`(.shell)에
 * inert 를 걸어 편집기·트리·상단 바가 초점도 클릭도 받지 않게 한다. 마지막 대화상자가 닫히면 inert 를 푼 뒤 열기 전 초점 자리
 * (편집기의 그림자 루트 안 포함)로 초점을 돌려준다. #pet-layer 도 같이 inert 다(알림 층은 아니다). 언어를 바꾸면 열린 채로 글자만 바뀐다. 하나 고르기는 배경을 눌러도 닫힌다.
 */
export function DialogLayer({ blockRef }: { blockRef?: RefObject<HTMLElement> }) {
  useLang();
  const current = useCurrentDialog();
  const open = current !== null;

  useLayoutEffect(() => {
    if (!open) return;
    const shell = blockRef?.current;
    // 떠 있는 도우미(#pet-layer)도 막는다. 알림 층(Toaster)은 막지 않는다: inert 는 live region 을 접근성 트리에서 지운다.
    const pet = document.getElementById(PET_LAYER_ID);
    shell?.setAttribute('inert', '');
    pet?.setAttribute('inert', '');
    return () => {
      // 초점을 돌려주기 전에 푼다: 열기 전 초점이 도우미 안에 있었을 수 있다.
      shell?.removeAttribute('inert');
      pet?.removeAttribute('inert');
      restoreFocusTo(takeReturnFocus());
    };
  }, [open, blockRef]);

  if (!current) return null;
  // 하나 고르기(팔레트, 빠른 이동, 카탈로그 …)는 바깥(배경)을 누르면 닫힌다: 잃을 입력이 없다. 입력·확인 창은 Esc 나 단추로만 닫는다.
  const dismissOutside = current.spec.kind === 'pick';
  const onBackdrop = (e: MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0 || e.target !== e.currentTarget) return;
    e.preventDefault();
    settleDialog(current.id, current.cancelValue);
  };
  return (
    <div className="dialog-layer">
      <div className="dialog-backdrop" onMouseDown={dismissOutside ? onBackdrop : undefined} />
      <Body key={current.id} entry={current} />
    </div>
  );
}
