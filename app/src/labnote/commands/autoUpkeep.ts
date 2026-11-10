/**
 * 쓰는 동안의 손질(UI 재설계 Task 20, 명세 §7.4)의 앱 배선. 규칙은 플러그인에서 옮겨 온 port/lastUpdatedStamp.ts 에 있다.
 * - last_updated_date: 랩 노트를 고친 뒤 2 초 조용하면 오늘(서울)로 찍는다. 워크플로 노트면 실험 README 도 찍는다.
 *   오늘 손으로 정한 날짜는 그대로 둔다. 설정 autoUpdateLastUpdated 가 꺼져 있으면 아무것도 쓰지 않는다.
 * - "Related Unit Operations" 목록: 워크플로 노트를 저장할 때 `### [..]` 제목들에서 다시 만든다(autoSyncUnitOpToc).
 *   지우거나 이름을 바꾼 UO 블록의 낡은 항목이 남지 않는다. 꺼져 있으면 차례는 두고 이름·링크만 맞추고 사라진 항목만 뺀다.
 * 열린 노트는 버퍼에 최소 교체로(자동 저장이 쓴다), 닫힌 노트는 processNote(비교 후 쓰기)로 쓴다.
 * 이 손질이 한 편집은 userEvent `labnote.upkeep` 이다: 사용자 편집으로 세지 않아 다시 찍기를 부르지 않는다.
 * 날짜 찍기는 되돌리기 기록에 넣지 않는다(Ctrl+Z 가 곧바로 사용자의 입력으로 간다). 목록 다시 만들기는 넣는다:
 * UO 블록 지우기를 되돌리면 목록도 함께 돌아온다.
 */
import { isolateHistory } from '@codemirror/commands';
import { Transaction } from '@codemirror/state';
import type { EditorView, ViewUpdate } from '@codemirror/view';
import { minimalReplacement } from '@labnoteo/core';
import type { AppFs } from '../../fs/tauriLabnoteFs';
import { toDocBreaks } from '../editTarget';
import { openNote, processNote } from '../openNotes';
import { classifyChange, LastUpdatedScheduler, LastUpdatedTracker, syncTocOnSave, type UpkeepSettings } from '../port/lastUpdatedStamp';

/** 손질이 한 편집의 userEvent. 'input' 으로 시작하지 않는다: 사용자 편집이 아니다. */
export const UPKEEP_EVENT = 'labnote.upkeep';

export interface UpkeepDeps {
  fs: AppFs;
  /** 부를 때마다 지금 값을 읽는다. 보관함 설정을 읽기 전이면 둘 다 꺼진 값을 준다. */
  settings(): UpkeepSettings;
  notify(message: string): void;
  /** 오늘(서울) `YYYY-MM-DD`. 테스트가 꽂는다. */
  today?: () => string;
  /** 마지막 편집 뒤 찍기까지(기본 2000 ms). */
  delayMs?: number;
}

export interface Upkeep {
  /** 편집기의 갱신 하나: 바뀐 트랜잭션마다 무엇이 바뀌었는지 적는다(편집기의 updateListener 가 부른다). */
  observe(path: string, update: ViewUpdate): void;
  /** 저장 직전(편집기의 doSave): 워크플로 노트의 UO 목록을 버퍼에서 맞춘다. 바꿨으면 true. */
  beforeSave(path: string, view: EditorView): boolean;
  /** 코드가 대신한 사용자 편집(스캔 넣기 등): 친 것처럼 찍기를 예약한다. */
  markUserEdit(path: string): void;
  /** 그 노트의 날짜를 오늘 손으로 정했는가. */
  keepsHandSet(path: string): boolean;
  /** 날짜 찍기 변환. `path` 를 주면 손으로 정한 날짜를 둔다. 설정이 꺼져 있으면 그대로. */
  stamp(content: string, path?: string): string;
  /** 손으로 정한 날짜와 기다리는 편집을 잊는다(설정을 다시 켰을 때). */
  reset(): void;
  dispose(): void;
}

export function createUpkeep(deps: UpkeepDeps): Upkeep {
  const tracker = new LastUpdatedTracker(deps.today);
  /** 노트마다 마지막 변경이 되돌리기·다시 하기였는가: 그 직후 저장은 목록을 고치지 않는다(다시 하기 기록이 남게). */
  const lastFromHistory = new Map<string, boolean>();
  const scheduler = new LastUpdatedScheduler({
    settings: deps.settings,
    tracker,
    notify: deps.notify,
    today: deps.today,
    delayMs: deps.delayMs,
    async stampNote(path, stamp) {
      const handle = openNote(path);
      if (handle) {
        const view = handle.view();
        if (!view || handle.busy()) return; // 읽는 중이거나 바깥 변경이 풀리지 않았다: 다음 편집이 다시 찍는다
        if (view.composing) {
          scheduler.markUserEdit(path); // 한글 조합을 깨지 않는다: 조금 뒤 다시
          return;
        }
        replaceInView(view, stamp, false);
        return;
      }
      if (!(await deps.fs.exists(path))) return;
      await processNote(deps.fs, path, stamp);
    },
  });
  return {
    observe(path, update) {
      for (const tr of update.transactions) {
        if (!tr.docChanged) continue;
        const change = classifyChange(tr);
        lastFromHistory.set(path, change.fromHistory);
        scheduler.record(path, change);
      }
    },
    beforeSave(path, view) {
      if (view.composing || view.state.readOnly) return false;
      const text = view.state.doc.toString();
      const next = syncTocOnSave(path, text, deps.settings(), {
        caret: view.state.selection.main.head,
        fromHistory: lastFromHistory.get(path) ?? false,
      });
      if (next === null) return false;
      return replaceInView(view, () => next, true);
    },
    markUserEdit: (path) => scheduler.markUserEdit(path),
    keepsHandSet: (path) => tracker.keepsHandSet(path),
    stamp: (content, path) => scheduler.stamp(content, path),
    reset() {
      tracker.clear();
      lastFromHistory.clear();
    },
    dispose() {
      scheduler.dispose();
      tracker.clear();
      lastFromHistory.clear();
    },
  };
}

/** 버퍼에 변환을 최소 교체 하나로 넣는다. 바꿨으면 true. */
function replaceInView(view: EditorView, transform: (text: string) => string, history: boolean): boolean {
  const state = view.state;
  const before = state.doc.toString();
  const m = minimalReplacement(before, transform(before));
  if (!m) return false;
  view.dispatch({
    changes: { from: m.start, to: m.end, insert: toDocBreaks(m.text, state) },
    annotations: [
      Transaction.userEvent.of(UPKEEP_EVENT),
      history ? isolateHistory.of('full') : Transaction.addToHistory.of(false),
    ],
  });
  return true;
}

/** 앱의 손질(보관함마다 App 이 만든다). 명령의 README 찍기(stamp.ts)가 손으로 정한 날짜를 물을 때 읽는다. */
let current: Upkeep | undefined;

export function setAppUpkeep(upkeep: Upkeep | undefined): void {
  current = upkeep;
}

export function appUpkeep(): Upkeep | undefined {
  return current;
}
