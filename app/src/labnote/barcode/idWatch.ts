/**
 * 노트 ID 감시(플러그인 barcodeFeature.ts:153-184 의 배선): 복사로 생긴 중복 ID, 바뀐 ID, 서식이 든 ID 를 묻고 알린다.
 * - 색인이 다 찬 뒤 서비스가 각 노트의 ID 를 기억하고(rememberIds) 중복을 한 번 묻는다(offerDuplicateFixes).
 * - 색인이 어떤 경로의 ID 가 바뀌었거나 새로 생겼다고 알리면(onChange), 그 경로가 랩 노트이고 ID 가 있을 때
 *   바뀐 ID 면 옛 ID 를 되돌릴지(checkIdChange), 아니면 그 ID 를 다른 노트도 가졌을 때 중복을 묻는다.
 * - 앱에서 한 이름 바꾸기는 색인의 항목과 서비스가 아는 ID 를 옮기고(다시 묻지 않는다), 지우기는 둘 다에서 뺀다.
 * - 보관함 감시자(`vault://changed`, '' 이면 전부 다시)와 앱의 노트 쓰기(noteWrites)는 그 경로를 색인에서 다시 읽는다.
 * - 명령이 준 ID(noteIdWrites)는 서비스가 아는 ID 에서 먼저 지운다: 바뀐 ID 로 여기지 않는다.
 * 묻는 대화상자는 서비스를 만들 때 준 호스트(App.tsx 는 unsolicitedHost)로 열린다. 플러그인의
 * isRenewingCopiedNoteId 는 없다: 앱에는 실험 복사 흐름이 아직 없다(E2).
 */
import { coreT } from '../i18n';
import { entryEvents } from '../commands/entryEvents';
import type { AppHost } from '../host/createAppHost';
import { noteWrites } from '../openNotes';
import { isBarcodeNote, type NoteIdService } from '../port/noteIdService';
import { subscribeVaultChanges, type ListenFn } from '../../vault/useVaultEvents';
import { currentNoteIdIndex, type NoteIdIndex } from './noteIdIndex';
import { noteIdWrites, noteRef } from './noteIdSource';

export interface IdWatchDeps {
  index: NoteIdIndex;
  service: NoteIdService;
  listen: ListenFn;
  /** 감시가 시작한 일을 돌린다. 실패는 알림으로 바꾼다(notifyingRun). */
  run(fn: () => Promise<unknown>): void;
}

/** 편집기에서 친 뒤 그 노트를 색인에서 다시 읽기까지 기다리는 시간. */
export const NOTE_ID_TOUCH_MS = 2000;

/** IdWatchDeps.run 의 앱판: 실패는 콘솔에 남기고 플러그인 문구 'Command failed: {0}' 로 알린다. */
export function notifyingRun(host: Pick<AppHost, 'notify'>): (fn: () => Promise<unknown>) => void {
  return (fn) => {
    fn().catch((err: unknown) => {
      console.error('[labnoteo] note-ID watch failed:', err);
      host.notify('error', coreT('Command failed: {0}', err instanceof Error ? err.message : String(err)));
    });
  };
}

/** 감시를 시작한다. 돌려준 함수가 모든 구독과 기다리던 다시 읽기를 끊는다. */
export function startIdWatch(deps: IdWatchDeps): () => void {
  const { index, service, run } = deps;
  let live = true;

  run(async () => {
    await index.ready();
    if (!live) return;
    service.rememberIds();
    await service.offerDuplicateFixes();
  });

  const offChange = index.onChange((path) => {
    if (!live || !isBarcodeNote(path)) return;
    const file = noteRef(index, path);
    if (!file || !service.idOf(file)) return;
    run(async () => {
      // 합치기는 합쳐진 노트의 ID 를 잠깐 함께 가진다: 그때는 바뀐 ID 가 질문이다(#443).
      if (await service.checkIdChange(file)) return;
      if (live && service.sharesId(file)) await service.offerDuplicateFixes();
    });
  });

  const offEntries = entryEvents.subscribe((e) => {
    if (!live) return;
    if (e.kind === 'renamed') {
      for (const { from, to } of e.files) {
        index.rename(from, to);
        service.moveKnown(from, to);
      }
    } else {
      for (const path of new Set([e.path, ...e.files])) {
        index.drop(path);
        service.forget(path);
      }
    }
  });

  const offVault = subscribeVaultChanges(deps.listen, (change) => {
    if (!live) return;
    if (change.kind === 'removed' && change.path !== '') service.forget(change.path);
    run(() => index.refresh(change.path));
  });

  const offWrites = noteWrites.subscribe((path) => {
    if (live) run(() => index.refresh(path));
  });

  const offIdWrites = noteIdWrites.subscribe((path) => {
    if (live) service.forget(path);
  });

  return () => {
    live = false;
    offChange();
    offEntries();
    offVault();
    offWrites();
    offIdWrites();
    cancelNoteIdTouches();
  };
}

const touchTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * 편집기에서 랩 노트를 고쳤다(docChanged). 마지막 고침 뒤 2 초 조용하면 그 경로를 노트 ID 색인에서 다시 읽는다.
 * 조합 중에는 다시 읽지 않는다: 2 초가 지났을 때 조합 중이면 다시 2 초를 기다린다(조합 중의 고침도 기다림을 다시 시작하므로
 * 조합의 마지막 글자도 조합이 끝난 뒤 읽힌다). 색인이 없으면 아무것도 하지 않는다.
 */
export function noteIdTouch(path: string, view: { composing: boolean }): void {
  if (!isBarcodeNote(path)) return;
  const pending = touchTimers.get(path);
  if (pending !== undefined) clearTimeout(pending);
  const fire = () => {
    if (view.composing) {
      touchTimers.set(path, setTimeout(fire, NOTE_ID_TOUCH_MS));
      return;
    }
    touchTimers.delete(path);
    const index = currentNoteIdIndex();
    if (!index) return;
    index.refresh(path).catch((e: unknown) => console.error('[labnoteo] note-ID refresh failed:', e));
  };
  touchTimers.set(path, setTimeout(fire, NOTE_ID_TOUCH_MS));
}

/** 기다리던 다시 읽기를 모두 버린다(보관함을 바꿀 때). */
export function cancelNoteIdTouches(): void {
  for (const timer of touchTimers.values()) clearTimeout(timer);
  touchTimers.clear();
}
