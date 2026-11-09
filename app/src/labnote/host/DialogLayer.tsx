import { useLayoutEffect, type RefObject } from 'react';
import { useLang } from '../../i18n/useLang';
import { AliasDialog } from './AliasDialog';
import { ChoiceDialog } from './ChoiceDialog';
import { ConfirmDialog } from './ConfirmDialog';
import { settleDialog, takeReturnFocus, useCurrentDialog, type DialogEntry } from './dialogStore';
import { PickManyDialog, Picker } from './Picker';
import { PromptDialog } from './PromptDialog';
import { SampleDefinitionDialog } from '../../samples/SampleDefinitionDialog';
import { SampleSettingsDialog } from '../../samples/SampleSettingsDialog';

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
    case 'sampleSettings':
      return <SampleSettingsDialog spec={spec} onDone={onDone} onCancel={onCancel} />;
  }
}

/**
 * 저장소(dialogStore)의 지금 대화상자를 그린다. .shell 밖에 그려야 한다: 대화상자가 열려 있는 동안 `blockRef`(.shell)에
 * inert 를 걸어 편집기·트리·상단 바가 초점도 클릭도 받지 않게 한다. 마지막 대화상자가 닫히면 inert 를 푼 뒤 열기 전 초점 자리
 * (편집기의 그림자 루트 안 포함)로 초점을 돌려준다. 언어를 바꾸면 열린 채로 글자만 바뀐다.
 */
export function DialogLayer({ blockRef }: { blockRef?: RefObject<HTMLElement> }) {
  useLang();
  const current = useCurrentDialog();
  const open = current !== null;

  useLayoutEffect(() => {
    if (!open) return;
    const shell = blockRef?.current;
    shell?.setAttribute('inert', '');
    return () => {
      shell?.removeAttribute('inert');
      const el = takeReturnFocus();
      if (el?.isConnected) el.focus();
    };
  }, [open, blockRef]);

  if (!current) return null;
  return (
    <div className="dialog-layer">
      <div className="dialog-backdrop" />
      <Body key={current.id} entry={current} />
    </div>
  );
}
