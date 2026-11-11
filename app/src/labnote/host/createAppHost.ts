import type { EditTarget, LabnoteHost, NotifyKind, PickItem } from '@labnoteo/core';
import type { AppFs } from '../../fs/tauriLabnoteFs';
import { coreT } from '../i18n';
import type { AliasOpts } from './AliasDialog';
import {
  aliasDialog,
  choiceDialog,
  confirmDialog,
  newExperimentDialog,
  pickDialog,
  pickManyDialog,
  promptDialog,
  type AliasBack,
  type ChoiceItem,
  type NewExperimentOpts,
  type NewExperimentResult,
  type PickExtras,
} from './dialogStore';
import { notify, type NotifyOpts } from './toastStore';

export type { AliasOpts } from './AliasDialog';

/** 앱의 LabnoteHost: 코어 호스트에 이름 바꾸기·휴지통이 있는 fs 와 별칭 대화상자를 더한다. */
export interface AppHost extends LabnoteHost {
  readonly fs: AppFs;
  /** 코어의 알림에 `ms`(info 가 사라질 때까지의 시간), 제목·자세한 글·단추 하나를 더한다. warn·error 는 닫을 때까지 남는다. */
  notify(kind: NotifyKind, message: string, opts?: NotifyOpts): void;
  /** '' = 빈 채로 냈다, undefined = 닫았다, ALIAS_BACK = 다시 고르기(opts.back 일 때만). */
  alias(opts: AliasOpts): Promise<string | undefined | AliasBack>;
  /** confirm 과 같지만 단추가 셋 이상이다. 고른 단추의 값, 닫으면 undefined. */
  choose<T>(
    message: string,
    choices: readonly ChoiceItem<T>[],
    opts?: { title?: string; unsolicited?: boolean },
  ): Promise<T | undefined>;
  /** 코어의 고르기에 `unsolicited`(A9, whenNotComposing.ts 의 unsolicitedHost 가 단다)를 더한다. */
  pick<T>(
    items: PickItem<T>[],
    opts?: { title?: string; placeholder?: string; selected?: T; unsolicited?: boolean } & PickExtras,
  ): Promise<T | undefined>;
  /** 새 실험 대화상자(제목과 실험자, UI 재설계 Task 19). 닫으면 undefined. */
  newExperiment(opts: NewExperimentOpts): Promise<NewExperimentResult | undefined>;
  /** 코어의 확인에 `unsolicited`(A9)와 제목(`title`)을 더한다. */
  confirm(
    message: string,
    opts?: { title?: string; confirmLabel?: string; signal?: AbortSignal; destructive?: boolean; unsolicited?: boolean },
  ): Promise<boolean>;
}

/**
 * 앱 호스트를 만든다. 대화상자는 dialogStore(한 번에 하나, 연 순서대로), 알림은 toastStore 로 간다.
 * 번역은 coreT 라서 부를 때마다 지금 언어를 따른다.
 */
export function createAppHost(deps: {
  /** VaultView 는 Task 6 의 편집기를 아는 fs 를 넘긴다. */
  fs: AppFs;
  /** 열린 노트가 없거나 편집기가 바쁘면 undefined. */
  editTarget: () => EditTarget | undefined;
  openFile: (path: string, at?: { line: number; ch?: number }) => Promise<void>;
}): AppHost {
  return {
    fs: deps.fs,
    pick: (items, opts) => pickDialog(items, opts),
    pickMany: (items, opts) => pickManyDialog(items, opts),
    prompt: (opts) => promptDialog(opts),
    confirm: (message, opts) => confirmDialog(message, opts),
    alias: (opts) => aliasDialog(opts as AliasOpts & { back: true }),
    choose: (message, choices, opts) => choiceDialog(message, choices, opts),
    newExperiment: (opts) => newExperimentDialog(opts),
    notify: (kind, message, opts) => notify(kind, message, opts),
    editTarget: () => deps.editTarget(),
    openFile: (path, at) => deps.openFile(path, at),
    t: coreT,
  };
}
