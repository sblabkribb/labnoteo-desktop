import { useSyncExternalStore } from 'react';
import type { IconName } from '../../ui/Icon';
import type { PickItem, PromptOpts } from '@labnoteo/core';
import type { AliasOpts } from './AliasDialog';
import type { SampleDefinitionModel, SampleDefinitionResult, UsageGroup } from '../port/sampleDefinitionModel';
import { deepActiveElement } from '../../ui/returnFocus';
import type { SettingsDeps, SettingsPage } from '../../ui/SettingsModal';
import type { PartbankSearchOpts } from '../../partbank/PartbankSearchDialog';
import type { WorksheetUnitOp } from '@labnoteo/core/lib/worksheet';
import type { WorksheetPaperSize } from '../../../vendor/labnoteo/src/settings';
import type { WorksheetChoice } from '../port/worksheetPrint';
import type { BarcodePrintActions } from '../port/barcodeDialog';
import type { ResultActions } from '../port/scanFeatureRuns';
import type { ScanPipeline, ScanResult } from '../port/scanPipeline';
import type { UnmatchedIo } from '../scan/UnmatchedDialog';
import type { BuiltContext } from '../context/contextBuilder';

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
  | {
      kind: 'pick';
      items: readonly PickItem<unknown>[];
      title?: string;
      placeholder?: string;
      selected?: unknown;
      /** 사용자가 부르지 않은 질문(A9): 처음 UNSOLICITED_ARM_MS 동안 Enter 와 Space 를 무시한다. */
      unsolicited?: boolean;
    } & PickExtras
  | { kind: 'pickMany'; items: readonly PickItem<unknown>[]; title?: string; placeholder?: string }
  | { kind: 'prompt'; opts: PromptOpts }
  | { kind: 'alias'; opts: AliasOpts }
  | {
      kind: 'confirm';
      message: string;
      confirmLabel?: string;
      signal?: AbortSignal;
      destructive?: boolean;
      /** 사용자가 부르지 않은 질문(A9): 취소 단추에 초점, 처음 UNSOLICITED_ARM_MS 동안 Enter 와 Space 를 무시한다. */
      unsolicited?: boolean;
    }
  | { kind: 'choice'; message: string; title?: string; choices: readonly ChoiceItem<unknown>[]; unsolicited?: boolean }
  | { kind: 'sampleDefinition'; model: SampleDefinitionModel; usages: Promise<UsageGroup[]> }
  | { kind: 'progress'; id: number }
  // 설정 창(UI 재설계 Task 8): 일반·편집기·실험·샘플·연동·단축키·정보. 닫힌 뒤 할 일(설정 창 뒤에 줄 서면 안 되는 질문)이 있으면 그 함수
  | { kind: 'settings'; page: SettingsPage; deps: SettingsDeps; focus?: 'githubToken' }
  | { kind: 'partbankSearch'; opts: PartbankSearchOpts }
  | { kind: 'aiAnswer'; content: string; onInsert?: () => Promise<boolean> }
  | { kind: 'worksheet'; unitOps: readonly WorksheetUnitOp[]; paper: WorksheetPaperSize }
  | { kind: 'barcode'; title: string; id: string; actions: BarcodePrintActions }
  // SP7 Part B: 스캔 가져오기(끝나면 읽은 파일들, 닫으면 undefined)와 스캔 결과(같은 결과 배열이라 되돌리기 상태가 이어진다)
  | { kind: 'scanImport'; processFolder?: () => void }
  | { kind: 'scanResults'; results: ScanResult[]; pipeline: ScanPipeline; actions: ResultActions }
  // 미분류 스캔 대기열(Task 26): 끝나면 손으로 넣을 페이지, 닫으면 undefined
  | { kind: 'scanUnmatched'; io: UnmatchedIo }
  // 새 노트(UI 재설계 Task 5): 리본·Ctrl+N·팔레트. 끝나면 만든 노트의 경로, 닫으면 undefined
  | { kind: 'newNote'; flush: () => Promise<boolean>; invoke?: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> }
  // 새 실험(UI 재설계 Task 19): 제목과 실험자. 끝나면 NewExperimentResult, 닫으면 undefined
  | { kind: 'newExperiment'; opts: NewExperimentOpts }
  // feat/ai-context: context sources before AI drafting. Send resolves { sources, window }, closing resolves null
  | { kind: 'aiContextSources'; built: BuiltContext; window: number; providerLabel: string; model: string };


/**
 * 새 실험 대화상자의 물음(AppHost.newExperiment). 제목 칸은 PromptOpts 의 value·validate·hint 와 같은 규칙이고,
 * 실험자 칸은 `experimenter`(설정의 defaultExperimenter, 다시 하기면 원래 실험의 author)로 미리 채운다.
 */
export interface NewExperimentOpts {
  /** 대화상자 제목(새 실험 / 실험 다시 하기). */
  title: string;
  /** 미리 채울 실험 제목. */
  value?: string;
  /** 미리 채울 실험자. */
  experimenter: string;
  validate?: PromptOpts['validate'];
  hint?: PromptOpts['hint'];
}

/** 새 실험 대화상자의 답: 다듬지 않은 제목과 실험자. */
export interface NewExperimentResult {
  title: string;
  experimenter: string;
}

/**
 * 고르기의 덧붙임(UI 재설계 Task 11). 카탈로그 고르기가 쓴다.
 * - `catalog`: 한 줄 행(고정폭 코드, 영어 이름, 흐린 설명). 상세 줄은 고른 행에만 보인다.
 * - `groupOf`: 검색어가 없을 때의 묶음 머리(Design / Build …, HW / SW). 묶음은 처음 나온 차례다.
 * - `recentKey`: 최근에 고른 것을 그 이름으로 기억해(localStorage, 이 사람의 편의) 검색어가 없을 때 "최근" 묶음으로 맨 위에 둔다.
 * - `query`, `onQuery`: 처음 검색어와 바뀔 때마다 알림. 별칭 단계에서 뒤로 오면 앞 검색어로 다시 연다(pickThen).
 */
export interface PickExtras {
  catalog?: boolean;
  /**
   * 팔레트 꼴(UI 재설계 Task 12, 명세 §5.5): 제목 줄 없는 640px 창, 테두리 없는 검색 칸, 32px 줄(아이콘, 맞은 글자를 칠한 이름,
   * 오른쪽 끝 kbd 칩), 아래에 키 안내. 명령 팔레트와 빠른 이동이 쓴다.
   */
  palette?: {
    iconOf?: (item: PickItem<unknown>) => IconName | undefined;
    kbdOf?: (item: PickItem<unknown>) => string | undefined;
    /** 목록 아래의 키 안내(예: "↑↓ 이동 · Enter 실행 · Esc 닫기"). */
    hint?: string;
  };
  /** 최근 목록에 적을 열쇠(기본: 카탈로그 코드, 없으면 이름). 명령은 id 로 적는다: 이름은 언어를 따라 바뀐다. */
  recentId?: (item: PickItem<unknown>) => string;
  groupOf?: (item: PickItem<unknown>) => string | undefined;
  /** 머리 있는 묶음(최근 등) 뒤에 오는 이름 없는 묶음의 머리. 없으면 "그 밖"(picker.rest). 팔레트는 "모든 명령". */
  restHead?: string;
  /**
   * 뒤에서 읽는 전체 목록(빠른 이동의 UO): 고르기는 `items` 로 바로 열리고, 이것이 끝나면 그 목록으로 바뀐다. 실패하면 `items` 그대로.
   * 읽는 동안 목록 아래에 `pendingNote` 를 보인다.
   */
  pending?: Promise<readonly PickItem<unknown>[]>;
  pendingNote?: string;
  recentKey?: string;
  query?: string;
  onQuery?: (query: string) => void;
}

/** 별칭 대화상자의 "다시 고르기"(뒤로 단추, 또는 back 을 단 별칭 단계의 Esc). */
export const ALIAS_BACK: unique symbol = Symbol('alias-back');
export type AliasBack = typeof ALIAS_BACK;

/** 여러 단추 확인의 단추 하나. 첫 단추가 주 단추다. */
export interface ChoiceItem<T> {
  label: string;
  value: T;
}

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
  return openDialogEntry(spec, cancelValue).result;
}

/**
 * `openDialog` 와 같지만 대화상자 id 도 돌려준다. 부른 쪽이 나중에 `settleDialog(id, …)` 로 직접 닫을 때 쓴다(진행 창).
 * 이미 끊긴 signal 이면 줄에 넣지 않고 id 는 -1 이다.
 */
export function openDialogEntry<R>(spec: DialogSpec, cancelValue: R): { id: number; result: Promise<R> } {
  const signal = spec.kind === 'confirm' ? spec.signal : undefined;
  if (signal?.aborted) return { id: -1, result: Promise.resolve(cancelValue) };
  const id = nextId++;
  const result = new Promise<R>((resolve) => {
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
  return { id, result };
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
  opts: { title?: string; placeholder?: string; selected?: T; unsolicited?: boolean } & PickExtras = {},
): Promise<T | undefined> {
  return openDialog<T | undefined>({ kind: 'pick', items, ...opts }, undefined);
}

/**
 * 두 단계 고르기(고르기 → 별칭)의 단계 쌓기. `pick` 이 고른 값으로 `next` 를 부르고, `next` 가 ALIAS_BACK 을 돌려주면
 * (뒤로 단추, 별칭 단계의 Esc) 앞 검색어로 고르기를 다시 연다. 고르기를 닫으면 undefined, 끝나면 고른 값과 `next` 의 결과.
 */
export async function pickThen<T, R>(
  pick: (step: { query: string; onQuery: (query: string) => void }) => Promise<T | undefined>,
  next: (value: T) => Promise<R | AliasBack>,
): Promise<{ value: T; result: R } | undefined> {
  let query = '';
  for (;;) {
    const value = await pick({ query, onQuery: (q) => (query = q) });
    if (value === undefined) return undefined;
    const result = await next(value);
    if (result !== ALIAS_BACK) return { value, result: result as R };
  }
}

export function pickManyDialog<T>(items: readonly PickItem<T>[], opts: { title?: string; placeholder?: string } = {}): Promise<T[]> {
  return openDialog<T[]>({ kind: 'pickMany', items, ...opts }, []);
}

/** 새 실험 대화상자(AppHost.newExperiment). 닫으면 undefined. */
export function newExperimentDialog(opts: NewExperimentOpts): Promise<NewExperimentResult | undefined> {
  return openDialog<NewExperimentResult | undefined>({ kind: 'newExperiment', opts }, undefined);
}

export function promptDialog(opts: PromptOpts): Promise<string | undefined> {
  return openDialog<string | undefined>({ kind: 'prompt', opts }, undefined);
}

/** 별칭 입력(AppHost.alias). '' = 빈 채로 냈다, undefined = 닫았다, ALIAS_BACK = 다시 고르기(opts.back 일 때만). */
export function aliasDialog(opts: AliasOpts & { back: true }): Promise<string | undefined | AliasBack>;
export function aliasDialog(opts: AliasOpts): Promise<string | undefined>;
export function aliasDialog(opts: AliasOpts): Promise<string | undefined | AliasBack> {
  return openDialog<string | undefined | AliasBack>({ kind: 'alias', opts }, undefined);
}

export function confirmDialog(
  message: string,
  opts: { confirmLabel?: string; signal?: AbortSignal; destructive?: boolean; unsolicited?: boolean } = {},
): Promise<boolean> {
  return openDialog<boolean>({ kind: 'confirm', message, ...opts }, false);
}

/** 셋 이상의 답이 있는 확인(AppHost.choose). 고른 단추의 값, 닫으면(Escape, 닫기 단추) undefined. */
export function choiceDialog<T>(
  message: string,
  choices: readonly ChoiceItem<T>[],
  opts: { title?: string; unsolicited?: boolean } = {},
): Promise<T | undefined> {
  return openDialog<T | undefined>({ kind: 'choice', message, choices, ...opts }, undefined);
}

/**
 * 샘플 정의 창(plan SP5 Task 23, D16). 고른 동작이나 열 사용처만 돌려주고 흐름은 부른 쪽이 돌린다. 닫으면 undefined.
 * `usages` 는 창이 열린 뒤에 채워진다(범위의 모든 노트를 읽으므로).
 */
export function openSampleDefinitionDialog(model: SampleDefinitionModel, usages: Promise<UsageGroup[]>): Promise<SampleDefinitionResult> {
  return openDialog<SampleDefinitionResult>({ kind: 'sampleDefinition', model, usages }, undefined);
}

/** 실험 워크시트 창(SP7 Task 8): 찍을 유닛 오퍼레이션, 용지, 출력 또는 브라우저. 닫으면 undefined. */
export function worksheetDialog(unitOps: readonly WorksheetUnitOp[], paper: WorksheetPaperSize): Promise<WorksheetChoice | undefined> {
  return openDialog<WorksheetChoice | undefined>({ kind: 'worksheet', unitOps, paper }, undefined);
}
