import type { EditorView } from '@codemirror/view';
import type { AppHost } from '../host/createAppHost';
import type { AppSettings } from '../settings';
import type { JournalStore } from '../../links/journal';
import type { LinkIndex } from '../../links/linkIndex';

/** 이름 바꾸기가 링크를 고칠 때 쓰는 것(SP4 D11-D15). 없으면 이름 바꾸기는 링크를 고치지 않는다. */
export interface LinkDeps {
  index: LinkIndex;
  journal: JournalStore;
  images(): Promise<string[]>;
  search(q: string, limit: number): Promise<{ hits: { path: string }[]; truncated: boolean }>;
}

/** 명령이 받는 것: 플러그인 명령이 Obsidian 의 App 에서 얻던 것의 앱판. */
export interface CommandContext {
  host: AppHost;
  /** 보관함의 절대 경로(fullPathLength 용). */
  vaultRoot: string;
  /** 부를 때의 설정(updateSettings 뒤에는 새 값). */
  readonly settings: AppSettings;
  /** 설정을 바꾸고 저장한다. 앱에서는 저장이 끝나면 풀리는 약속을 돌려준다(Rust 가 저장본을 읽는다). 저장하지 못하면 false 로 풀린다. */
  updateSettings(p: Partial<AppSettings>): void | Promise<void | boolean>;
  /** 편집기에 열린 노트(VaultView.selected). */
  activePath(): string | undefined;
  /** 편집기의 뷰. 열린 노트가 없거나 편집기가 바쁘면 undefined. */
  activeView(): EditorView | undefined;
  openFile(path: string, at?: { line: number; ch?: number }): Promise<void>;
  /** 열린 노트를 저장하고 닫는다. 저장하지 못하면 false(아무것도 닫지 않는다). */
  closeActive(): Promise<boolean>;
  /** 트리를 다시 읽고 vaultRefresh 를 알린다(Workflows 패널이 구독한다, Task 12). */
  refresh(): void;
  /** 사이드바 탭을 바꾼다. */
  showPanel(panel: 'files' | 'workflows' | 'samples' | 'outline' | 'links'): void;
  /** 파일 탭으로 가서 그 폴더(또는 파일)를 펼치고 그 줄에 초점을 둔다(실험 탭의 images/·resources/ 줄). 앱은 늘 준다. */
  revealInFiles?(path: string): void;
  /** 링크 색인과 고침 기록. 앱은 늘 준다. */
  links?: LinkDeps;
  /** 뒤로·앞으로 가기(SP4 Task 28). 앱은 늘 준다. */
  navigate?(dir: 'back' | 'forward'): void;
  /** 새 노트 대화상자(리본, Ctrl+N). 앱은 늘 준다. */
  newNote?(): void;
  /** 보관함 바꾸기(저장하지 못하면 바꾸지 않는다). 앱은 늘 준다. */
  switchVault?(): void;
  /** 파일 탭에 보이는 파일(폴더 빼고, 보관함 기준 경로). 빠른 이동이 첨부까지 찾는다. 없으면 링크 색인의 파일. */
  treeFiles?(): readonly string[];
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
