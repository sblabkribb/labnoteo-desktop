import { t } from '../i18n/t';
import type { AppCommand } from '../editor/commands/appCommands';
import { openSettings } from '../ui/SettingsModal';
import { captureFocus } from '../ui/returnFocus';
import { petStore } from './petStore';

/**
 * 어시스턴트 명령(assistant 명세 §10.2): 앱 명령(AppCommand)이다. 이름은 앱 번역 키(ko·en), key 는 보여 주기만 한다
 * (Ctrl+Shift+Y 는 ui/shellKeys.ts 가 code 로 듣는다). 명령은 그것이 동작하게 되는 작업에서 하나씩 등록한다:
 * 팔레트와 리본이 아직 없는 기능을 가리키지 않는다. editor/commands/appCommands.ts 의 allAppCommands() 가 이것을 넣는다.
 */
export const ASSISTANT_COMMAND_IDS = ['assistant.open', 'assistant.toggleVisible', 'assistant.resetPosition', 'assistant.settings'] as const;

/** 말풍선을 열고(숨겨 두었으면 보이고) 지금 초점 자리를 기억한다: Esc 로 닫으면 거기로 돌아간다. 보관함 설정이 없어도 된다. */
export function openAssistant(): void {
  const restore = captureFocus();
  if (petStore.get().hidden) petStore.setHidden(false);
  petStore.setOpen(true, restore);
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

export function assistantCommands(): AppCommand[] {
  return [open, toggleVisible, resetPosition, settings];
}
