import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { EditorHandle } from '../../editor/Editor';
import { listVaultImages } from '../../fs/vaultImage';
import { linkJournal } from '../../links/journal';
import { linkIndex } from '../../links/linkIndex';
import { searchNotes } from '../../search/indexApi';
import type { AppHost } from '../host/createAppHost';
import { openNote } from '../openNotes';
import type { AppSettings } from '../settings';
import { vaultRefresh, type CommandContext, type LinkDeps } from './context';

/** 앱의 링크 의존성: 링크 색인과 고침 기록의 단일 객체, 그리고 Tauri 위의 이미지 목록과 검색. */
const APP_LINKS: LinkDeps = {
  index: linkIndex,
  journal: linkJournal,
  images: () => listVaultImages(),
  search: (q, limit) => searchNotes(q, limit),
};

type At = { line: number; ch?: number };

/**
 * 편집기에 열린 노트를 고르고 바꾸는 손잡이(VaultView 가 쓴다).
 * - openFile(path, at?): 같은 노트면 커서만 옮긴다. 다른 노트면 지금 노트를 먼저 저장하고(못 하면 바꾸지 않는다),
 *   새 노트를 열어 처음 읽은 뒤 `at` 으로 커서를 옮긴다.
 * - closeActive(): 저장하고(못 하면 false) 노트를 닫은 뒤 편집기가 내려갈 때까지 기다린다. 내려가는 편집기는 깨끗해서
 *   아무것도 쓰지 않는다.
 * 돌려주는 함수들은 마운트 동안 같은 객체다.
 */
export function useNoteSwitcher(editor: RefObject<EditorHandle>) {
  const [selected, setSelectedState] = useState<string>();
  const [reveal, setReveal] = useState<At>();
  const selectedRef = useRef<string>();
  const waiters = useRef<Array<() => void>>([]);
  // 이 effect 는 내려가는 편집기의 정리(cleanup)가 끝난 뒤에 돈다.
  useEffect(() => {
    if (selected !== undefined) return;
    const ready = waiters.current;
    waiters.current = [];
    ready.forEach((resolve) => resolve());
  }, [selected]);

  const fns = useRef({
    activePath: (): string | undefined => selectedRef.current,
    openFile: async (path: string, at?: At): Promise<void> => {
      const current = editor.current;
      // 같은 노트: 대소문자만 다른 경로도 열린 노트 목록에서는 같은 손잡이다
      if (path === selectedRef.current || (current && openNote(path) === current)) {
        if (at) current?.reveal(at);
        return;
      }
      if (current && !(await current.flush())) return;
      selectedRef.current = path;
      setReveal(at);
      setSelectedState(path);
    },
    closeActive: async (): Promise<boolean> => {
      if (selectedRef.current === undefined) return true;
      const current = editor.current;
      if (current && !(await current.flush())) return false;
      return new Promise<boolean>((resolve) => {
        waiters.current.push(() => resolve(true));
        selectedRef.current = undefined;
        setReveal(undefined);
        setSelectedState(undefined);
      });
    },
  }).current;

  return { selected, reveal, ...fns };
}

export interface CommandContextDeps {
  host: AppHost;
  vaultRoot: string;
  settings: AppSettings | undefined;
  updateSettings(p: Partial<AppSettings>): void;
  selected: string | undefined;
  /** 렌더를 기다리지 않는 지금 노트(useNoteSwitcher.activePath). 없으면 `selected`. */
  activePath?: () => string | undefined;
  editor: RefObject<EditorHandle>;
  reloadTree(): void;
  openFile(path: string, at?: At): Promise<void>;
  closeActive(): Promise<boolean>;
  showPanel?: (p: 'files' | 'workflows' | 'samples' | 'outline' | 'links') => void;
  /** 뒤로·앞으로 가기(SP4 Task 28). */
  navigate?: (dir: 'back' | 'forward') => void;
}

/**
 * 명령 맥락. 설정을 읽기 전에는 undefined(그동안 팔레트와 단추는 쉰다).
 * 맥락 객체는 호스트와 보관함이 같은 동안 하나이고, 메서드와 settings 는 부를 때의 최신 값을 읽는다.
 */
export function useCommandContext(deps: CommandContextDeps): CommandContext | undefined {
  const latest = useRef(deps);
  latest.current = deps;
  const ctx = useMemo<CommandContext>(
    () => ({
      host: deps.host,
      vaultRoot: deps.vaultRoot,
      get settings() {
        return latest.current.settings as AppSettings;
      },
      updateSettings: (p) => latest.current.updateSettings(p),
      activePath: () => (latest.current.activePath ? latest.current.activePath() : latest.current.selected),
      activeView: () => {
        const handle = latest.current.editor.current;
        return handle && !handle.busy() ? handle.view() : undefined;
      },
      openFile: (path, at) => latest.current.openFile(path, at),
      closeActive: () => latest.current.closeActive(),
      refresh: () => {
        latest.current.reloadTree();
        vaultRefresh.emit();
      },
      showPanel: (p) => latest.current.showPanel?.(p),
      links: APP_LINKS,
      navigate: (dir) => latest.current.navigate?.(dir),
    }),
    [deps.host, deps.vaultRoot],
  );
  return deps.settings ? ctx : undefined;
}
