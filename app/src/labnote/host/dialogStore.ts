import { useSyncExternalStore } from 'react';
import type { PickItem, PromptOpts } from '@labnoteo/core';
import type { AliasOpts } from './AliasDialog';
import type { SampleDefinitionModel, SampleDefinitionResult, UsageGroup } from '../port/sampleDefinitionModel';
import { deepActiveElement } from '../../ui/returnFocus';
import type { SampleSettingsValue } from '../../samples/SampleSettingsDialog';

// 초점 찾기는 ui/returnFocus 의 것을 쓴다(편집기의 충돌 대화상자와 같은 규칙). 예전 경로로 부르는 쪽을 위해 다시 내보낸다.
export { deepActiveElement };

/**
 * 앱 LabnoteHost 의 대화상자(고르기, 여러 개 고르기, 입력, 별칭, 확인) 저장소.
 *
 * React 밖의 작은 저장소이고, DialogLayer 가 useSyncExternalStore 로 읽는다. 한 번에 하나만 보이고 나머지는 연 순서대로 기다린다
 * (명령이 확인을 묻는 사이 다른 명령이 고르기를 열어도 두 창이 겹치지 않는다). 각 대화상자는 정확히 한 번 끝난다.
 *
 * 처음 대화상자가 열릴 때(줄이 비어 있고 복귀 자리가 아직 꺼내지지 않았을 때) 초점이 있던 요소를 적어 둔다. 편집기의 그림자 루트 안까지 따라 들어간다.
 * 마지막 대화상자가 닫히면 DialogLayer 가 .shell 의 inert 를 푼 뒤 그 요소로 초점을 돌려준다.
 */
export type DialogSpec =
  | { kind: 'pick'; items: readonly PickItem<unknown>[]; title?: string; placeholder?: string; selected?: unknown }
  | { kind: 'pickMany'; items: readonly PickItem<unknown>[]; title?: string; placeholder?: string }
  | { kind: 'prompt'; opts: PromptOpts }
  | { kind: 'alias'; opts: AliasOpts }
  | { kind: 'confirm'; message: string; confirmLabel?: string; signal?: AbortSignal; destructive?: boolean }
  | { kind: 'sampleDefinition'; model: SampleDefinitionModel; usages: Promise<UsageGroup[]> }
  | { kind: 'sampleSettings'; value: SampleSettingsValue };

export interface DialogEntry {
  readonly id: number;
  readonly spec: DialogSpec;
  /** 저장소가 다른 이유(취소, signal)로 닫을 때 돌려줄 값. */
  readonly cancelValue: unknown;
}

interface Pending extends DialogEntry {
  settle(value: unknown): void;
}

let queue: Pending[] = [];
let nextId = 1;
let returnFocus: HTMLElement | null = null;
const listeners = new Set<() => void>();

const emit = () => listeners.forEach((l) => l());

/** `spec` 을 줄에 넣는다. 사용자가 답하면 그 값으로, 닫히면 `cancelValue` 로 끝난다. */
export function openDialog<R>(spec: DialogSpec, cancelValue: R): Promise<R> {
  const signal = spec.kind === 'confirm' ? spec.signal : undefined;
  if (signal?.aborted) return Promise.resolve(cancelValue);
  return new Promise<R>((resolve) => {
    const id = nextId++;
    const onAbort = () => settleDialog(id, cancelValue);
    // 이어 연 대화상자: 명령의 다음 줄은 앞 대화상자의 닫힘이 그려지기 전에 돈다. 그때 줄은 비었지만 초점은 아직 앞 대화상자
    // 안이다. 아직 꺼내지 않은(그리고 아직 문서에 있는) 복귀 자리는 덮어쓰지 않고, 대화상자 층 안의 요소는 복귀 자리로 적지 않는다.
    if (queue.length === 0 && !returnFocus?.isConnected) {
      const el = deepActiveElement();
      if (!el?.closest('.dialog-layer')) returnFocus = el;
    }
    queue = [
      ...queue,
      {
        id,
        spec,
        cancelValue,
        settle: (value) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(value as R);
        },
      },
    ];
    signal?.addEventListener('abort', onAbort);
    emit();
  });
}

/** 대화상자 `id` 를 `value` 로 끝낸다. 이미 끝난 id 는 무시한다. 보이는 것이든 기다리는 것이든 줄에서 뺀다. */
export function settleDialog(id: number, value: unknown): void {
  const entry = queue.find((e) => e.id === id);
  if (!entry) return;
  queue = queue.filter((e) => e !== entry);
  entry.settle(value);
  emit();
}

/** 줄의 모든 대화상자를 각자의 취소 값으로 끝낸다(보관함을 바꿀 때, 테스트 정리). */
export function closeAllDialogs(): void {
  const all = queue;
  if (all.length === 0) return;
  queue = [];
  all.forEach((e) => e.settle(e.cancelValue));
  emit();
}

/** 지금 보이는 대화상자. 없으면 null. */
export function currentDialog(): DialogEntry | null {
  return queue[0] ?? null;
}

export function subscribeDialogs(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** 첫 대화상자가 열릴 때 초점이 있던 요소를 꺼낸다(한 번만). */
export function takeReturnFocus(): HTMLElement | null {
  const el = returnFocus;
  returnFocus = null;
  return el;
}

export function useCurrentDialog(): DialogEntry | null {
  return useSyncExternalStore(subscribeDialogs, currentDialog, currentDialog);
}

/** 대화상자가 하나라도 보이는 동안 true. */
export function useDialogOpen(): boolean {
  return useCurrentDialog() !== null;
}

// LabnoteHost 의 네 메서드 모양 그대로 여는 도우미. createAppHost(Task 5)가 이것을 쓴다.

export function pickDialog<T>(
  items: readonly PickItem<T>[],
  opts: { title?: string; placeholder?: string; selected?: T } = {},
): Promise<T | undefined> {
  return openDialog<T | undefined>({ kind: 'pick', items, ...opts }, undefined);
}

export function pickManyDialog<T>(items: readonly PickItem<T>[], opts: { title?: string; placeholder?: string } = {}): Promise<T[]> {
  return openDialog<T[]>({ kind: 'pickMany', items, ...opts }, []);
}

export function promptDialog(opts: PromptOpts): Promise<string | undefined> {
  return openDialog<string | undefined>({ kind: 'prompt', opts }, undefined);
}

/** 별칭 입력(AppHost.alias). '' = 빈 채로 냈다, undefined = 닫았다. */
export function aliasDialog(opts: AliasOpts): Promise<string | undefined> {
  return openDialog<string | undefined>({ kind: 'alias', opts }, undefined);
}

export function confirmDialog(
  message: string,
  opts: { confirmLabel?: string; signal?: AbortSignal; destructive?: boolean } = {},
): Promise<boolean> {
  return openDialog<boolean>({ kind: 'confirm', message, ...opts }, false);
}

/**
 * 샘플 정의 창(plan SP5 Task 23, D16). 고른 동작이나 열 사용처만 돌려주고 흐름은 부른 쪽이 돌린다. 닫으면 undefined.
 * `usages` 는 창이 열린 뒤에 채워진다(범위의 모든 노트를 읽으므로).
 */
export function openSampleDefinitionDialog(model: SampleDefinitionModel, usages: Promise<UsageGroup[]>): Promise<SampleDefinitionResult> {
  return openDialog<SampleDefinitionResult>({ kind: 'sampleDefinition', model, usages }, undefined);
}
