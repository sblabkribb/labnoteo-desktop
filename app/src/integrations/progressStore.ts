import { useSyncExternalStore } from 'react';
import { openDialogEntry, settleDialog } from '../labnote/host/dialogStore';
import { vaultSignal } from './netIpc';

/**
 * 진행 창(SP6 Task 12)의 저장소. 창 자체는 dialogStore 의 줄에 `{ kind: 'progress', id }` 로 들어가고, 제목과 줄은 여기 있다.
 *
 * - 줄은 최근 200 개만 둔다.
 * - 취소(단추, Escape, 다른 이유로 창이 닫힘)는 신호를 끊는다. 보관함을 바꾸면(vaultSignal) 신호도 끊긴다(D11).
 * - `done()` 은 창을 닫는다. 두 번 불러도 괜찮다. `done()` 으로 닫으면 신호는 끊지 않는다.
 */
export interface ProgressHandle {
  readonly signal: AbortSignal;
  line(text: string): void;
  done(): void;
  /**
   * 취소할 수 있는지 바꾼다(GitHub 올리기, spec §5.5). false 면 취소 단추가 사라지고, 취소 단추·닫기 단추·Escape 가 더는
   * 신호를 끊지 않는다(보관함을 바꾸면 여전히 끊긴다). true 면 다시 취소 단추가 보인다.
   */
  setCancellable(cancellable: boolean): void;
}

export interface ProgressState {
  readonly title: string;
  readonly lines: readonly string[];
  readonly cancellable: boolean;
  /** `setCancellable(false)` 뒤: 닫기 단추와 Escape 도 아무것도 하지 않는다. */
  readonly locked?: boolean;
}

interface Entry {
  state: ProgressState;
  readonly controller: AbortController;
  dialogId: number;
  finished: boolean;
  readonly cleanup: () => void;
}

const MAX_LINES = 200;
const entries = new Map<number, Entry>();
const listeners = new Set<() => void>();
let nextId = 1;

const emit = () => listeners.forEach((l) => l());

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** 창을 닫고 정리한다. `abort` 면 신호를 끊는다(취소). 이미 끝났으면 아무것도 하지 않는다. */
function finish(id: number, abort: boolean): void {
  const entry = entries.get(id);
  if (!entry || entry.finished) return;
  entry.finished = true;
  entry.cleanup();
  entries.delete(id);
  if (abort) entry.controller.abort();
  settleDialog(entry.dialogId, undefined);
  emit();
}

/** 진행 창을 연다. 다른 대화상자가 떠 있으면 그 뒤에서 기다린다. */
export function openProgress(title: string, opts: { cancellable?: boolean } = {}): ProgressHandle {
  const id = nextId++;
  const controller = new AbortController();
  const vault = vaultSignal();
  const onVaultAbort = () => finish(id, true);
  const entry: Entry = {
    state: { title, lines: [], cancellable: opts.cancellable === true },
    controller,
    dialogId: -1,
    finished: false,
    cleanup: () => vault.removeEventListener('abort', onVaultAbort),
  };
  entries.set(id, entry);
  const opened = openDialogEntry<undefined>({ kind: 'progress', id }, undefined);
  entry.dialogId = opened.id;
  // 다른 이유로 창이 닫히면(closeAllDialogs 등) 취소로 본다. done() 으로 이미 끝났으면 finish 가 아무것도 하지 않는다.
  void opened.result.then(() => finish(id, true));
  if (vault.aborted) finish(id, true);
  else vault.addEventListener('abort', onVaultAbort);
  emit();
  return {
    signal: controller.signal,
    line(text: string) {
      const current = entries.get(id);
      if (!current) return;
      const lines = [...current.state.lines, text];
      current.state = { ...current.state, lines: lines.length > MAX_LINES ? lines.slice(lines.length - MAX_LINES) : lines };
      emit();
    },
    done() {
      finish(id, false);
    },
    setCancellable(cancellable: boolean) {
      const current = entries.get(id);
      if (!current) return;
      current.state = { ...current.state, cancellable, locked: !cancellable };
      emit();
    },
  };
}

/** 사용자가 진행 창을 취소했다(단추, Escape, 닫기): 신호를 끊고 창을 닫는다. */
export function cancelProgress(id: number): void {
  finish(id, true);
}

/** 진행 창 `id` 의 제목과 줄. 끝난 창이면 undefined. */
export function useProgress(id: number): ProgressState | undefined {
  const snapshot = () => entries.get(id)?.state;
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** 진행 창을 열고 `run` 을 돌린다. 끝나면(던져도) 언제나 닫는다. 신호는 보관함을 바꿀 때도 끊긴다(D11). */
export async function withProgress<T>(
  title: string,
  run: (p: ProgressHandle) => Promise<T>,
  opts?: { cancellable?: boolean },
): Promise<T> {
  const p = openProgress(title, opts);
  try {
    return await run(p);
  } finally {
    p.done();
  }
}
