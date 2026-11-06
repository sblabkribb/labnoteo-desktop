import type { EditorView } from '@codemirror/view';
import type { AppHost } from '../host/createAppHost';
import type { AppSettings } from '../settings';

/** 명령이 받는 것: 플러그인 명령이 Obsidian 의 App 에서 얻던 것의 앱판. */
export interface CommandContext {
  host: AppHost;
  /** 보관함의 절대 경로(fullPathLength 용). */
  vaultRoot: string;
  /** 부를 때의 설정(updateSettings 뒤에는 새 값). */
  readonly settings: AppSettings;
  updateSettings(p: Partial<AppSettings>): void;
  /** 편집기에 열린 노트(VaultView.selected). */
  activePath(): string | undefined;
  /** 편집기의 뷰. 열린 노트가 없거나 편집기가 바쁘면 undefined. */
  activeView(): EditorView | undefined;
  openFile(path: string, at?: { line: number; ch?: number }): Promise<void>;
  /** 열린 노트를 저장하고 닫는다. 저장하지 못하면 false(아무것도 닫지 않는다). */
  closeActive(): Promise<boolean>;
  /** 트리를 다시 읽고 vaultRefresh 를 알린다(Workflows 패널이 구독한다, Task 12). */
  refresh(): void;
  /** 사이드바 탭을 바꾼다. Task 12 가 탭을 더하기 전에는 아무 일도 하지 않는다. */
  showPanel(panel: 'files' | 'workflows'): void;
}

const listeners = new Set<() => void>();

/** 명령이 보관함을 바꿨다는 알림(트리 말고도 다시 읽을 화면이 듣는다). */
export const vaultRefresh = {
  emit(): void {
    [...listeners].forEach((l) => l());
  },
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => void listeners.delete(fn);
  },
};
