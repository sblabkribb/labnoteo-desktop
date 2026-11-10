import { t } from '../i18n/t';
import type { AppCommand } from '../editor/commands/appCommands';
import { openSettings } from '../ui/SettingsModal';
import { captureFocus } from '../ui/returnFocus';
import type { ChipId } from './chips';
import { petStore } from './petStore';
import { assistantSession } from './useAssistantSession';

/**
 * 어시스턴트 명령(assistant 명세 §10.2): 앱 명령(AppCommand)이다. 이름은 앱 번역 키(ko·en), key 는 보여 주기만 한다
 * (Ctrl+Shift+Y 는 ui/shellKeys.ts 가 code 로 듣는다). 명령은 그것이 동작하게 되는 작업에서 하나씩 등록한다:
 * 팔레트와 리본이 아직 없는 기능을 가리키지 않는다. editor/commands/appCommands.ts 의 allAppCommands() 가 이것을 넣는다.
 */
export const ASSISTANT_COMMAND_IDS = [
  'assistant.open',
  'assistant.toggleVisible',
  'assistant.resetPosition',
  'assistant.settings',
  'assistant.chat',
  'assistant.stop',
  'assistant.clearHistory',
  'assistant.howTo',
  'assistant.createSection',
  'assistant.createUnitOperation',
  'assistant.createWorkflow',
] as const;

/** 말풍선을 열고(숨겨 두었으면 보이고) 지금 초점 자리를 기억한다: Esc 로 닫으면 거기로 돌아간다. 보관함 설정이 없어도 된다. */
export function openAssistant(): void {
  const restore = captureFocus();
  if (petStore.get().hidden) petStore.setHidden(false);
  petStore.setOpen(true, restore);
}

/**
 * 말풍선을 칩 `chip` 으로 연다(Task 11B). 이미 열려 있으면 칩만 바꾼다(말풍선이 그 칩 칸으로 초점을 옮긴다).
 * 제공자나 실험 노트가 없으면 말풍선이 왜 못 하는지와 고칠 단추를 보인다.
 */
export function openAssistantOn(chip: ChipId): void {
  assistantSession.setChip(chip);
  const s = petStore.get();
  if (s.open && !s.hidden) return;
  openAssistant();
}

/** 보이기·숨기기. 숨기면 다시 켜는 곳을 알린다. 보관함 설정이 없어도 된다(App 이 명령 맥락 없이도 부른다). */
export function toggleAssistant(notify: (kind: 'info', message: string) => void): void {
  const hiding = !petStore.get().hidden;
  petStore.toggleVisible();
  if (hiding) notify('info', t('pet.hidden'));
}

const open: AppCommand = {
  id: 'assistant.open',
  nameKey: 'cmd.assistant.open',
  key: 'Mod-Shift-y',
  icon: 'bot',
  run: () => openAssistant(),
};

/** 리본의 어시스턴트 단추와 같다. */
const toggleVisible: AppCommand = {
  id: 'assistant.toggleVisible',
  nameKey: 'cmd.assistant.toggleVisible',
  icon: 'eye-off',
  run: (ctx) => toggleAssistant((kind, message) => ctx.host.notify(kind, message)),
};

/** 처음 자리(오른쪽 아래)로 되돌린다. */
const resetPosition: AppCommand = {
  id: 'assistant.resetPosition',
  nameKey: 'cmd.assistant.resetPosition',
  icon: 'locate-fixed',
  run: () => petStore.reset(),
};

/** 설정 창의 어시스턴트 쪽. */
const settings: AppCommand = {
  id: 'assistant.settings',
  nameKey: 'cmd.assistant.settings',
  icon: 'settings',
  run: () => openSettings('assistant'),
};

/** 대화를 연다: 대화 칩으로 말풍선을 열고 입력 칸에 초점을 둔다(이미 열려 있으면 입력 칸으로만). */
const chat: AppCommand = {
  id: 'assistant.chat',
  nameKey: 'cmd.assistant.chat',
  icon: 'bot',
  run: () => {
    assistantSession.setChip('chat');
    if (petStore.get().open && !petStore.get().hidden) {
      document.querySelector<HTMLTextAreaElement>('.pet-composer-input')?.focus();
      return;
    }
    openAssistant();
  },
};

/** 흘러 들어오는 답을 멈춘다. 진행 중일 때만 팔레트에 보이고, 다른 데서 불리면 왜 아무것도 안 했는지 말한다. */
const stop: AppCommand = {
  id: 'assistant.stop',
  nameKey: 'cmd.assistant.stop',
  icon: 'circle-stop',
  available: () => assistantSession.get().streaming,
  run: (ctx) => {
    if (!assistantSession.get().streaming) {
      ctx.host.notify('info', t('pet.notRunning'));
      return;
    }
    assistantSession.stop();
  },
};

/** 열린 실험의 대화 기록을 (확인 후) 지운다. 실험 밖이면 왜 못 하는지 말한다. */
const clearHistory: AppCommand = {
  id: 'assistant.clearHistory',
  nameKey: 'cmd.assistant.clearHistory',
  icon: 'eraser',
  run: async (ctx) => {
    if (assistantSession.get().folder === null) {
      ctx.host.notify('info', t('history.noFolder'));
      return;
    }
    await assistantSession.clear();
  },
};

/** 칩 명령(Task 11B): 말풍선을 그 칩으로 연다. */
const chipCommand = (id: string, nameKey: string, icon: AppCommand['icon'], chip: ChipId): AppCommand => ({
  id,
  nameKey,
  icon,
  run: () => openAssistantOn(chip),
});
const howTo = chipCommand('assistant.howTo', 'cmd.assistant.howTo', 'info', 'howTo');
const createSection = chipCommand('assistant.createSection', 'cmd.assistant.createSection', 'file-plus', 'section');
const createUnitOperation = chipCommand('assistant.createUnitOperation', 'cmd.assistant.createUnitOperation', 'test-tube', 'unitOp');
const createWorkflow = chipCommand('assistant.createWorkflow', 'cmd.assistant.createWorkflow', 'workflow', 'workflow');

export function assistantCommands(): AppCommand[] {
  return [open, toggleVisible, resetPosition, settings, chat, stop, clearHistory, howTo, createSection, createUnitOperation, createWorkflow];
}
