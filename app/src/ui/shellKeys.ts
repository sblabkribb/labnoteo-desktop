/**
 * 셸 단축키 → 명령 id(UI 재설계 Task 12: 단축키도 등록된 명령을 부른다). App 의 window keydown 이 이것으로 고르고 findCommand 로 돌린다.
 * - Ctrl+\ 왼쪽 독, Ctrl+Shift+\ 오른쪽 사이드바: code 로 맞춘다(한국어 자판의 ₩ 키도 Backslash 다).
 * - Ctrl+N 새 노트, Ctrl+O 빠른 이동, Ctrl+, 설정: 한글 자판에서는 key 가 한글이므로 code 로 본다.
 * - 한글 조합 중이면 아무것도 고르지 않는다. CodeMirror 는 이 키들을 묶지 않는다(기본 keymap 의 Shift-Mod-\ 는 Editor.tsx 가 뺀다).
 * Ctrl+P(팔레트)는 CommandPalette 의 캡처 단계 처리기가 따로 듣는다(인쇄 대화상자를 늘 막아야 한다).
 */
function composing(e: KeyboardEvent): boolean {
  return e.isComposing || e.keyCode === 229;
}

/** Ctrl 만(Shift·Alt·Meta 없이), 한글 조합 중이 아닐 때. */
function plainCtrl(e: KeyboardEvent): boolean {
  return e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && !composing(e);
}

/** Ctrl+Shift 만(Alt·Meta 없이), 한글 조합 중이 아닐 때. */
function ctrlShift(e: KeyboardEvent): boolean {
  return e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && !composing(e);
}

const PLAIN: Readonly<Record<string, string>> = {
  Backslash: 'app.toggleLeft',
  KeyN: 'app.newNote',
  KeyO: 'app.quickSwitcher',
  Comma: 'app.settings',
};

export function shellShortcut(e: KeyboardEvent): string | undefined {
  if (ctrlShift(e)) return e.code === 'Backslash' ? 'app.toggleRight' : undefined;
  if (!plainCtrl(e)) return undefined;
  return Object.hasOwn(PLAIN, e.code) ? PLAIN[e.code] : undefined;
}
