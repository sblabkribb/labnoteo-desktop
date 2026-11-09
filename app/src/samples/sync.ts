/**
 * 저장 때의 샘플 동기화(계획 D12, Task 17). 추적하는 `*.labnote.md` 의 `@type;ID;…` 정의와 참조를 마지막 변경
 * SAMPLE_SYNC_MS 뒤 `{Type}.json` 으로 옮긴다(플러그인 main.ts 의 scheduleSampleSync/syncSamples 포트, port/sampleSync.ts).
 *
 * 세 가지가 부른다. 모두 경로마다 따로 미룬다:
 * 1. 편집기의 본문 변경(`touch`): 글은 그 편집기의 버퍼다. 표 칸 편집기는 부르지 않는다(바깥 편집기가 그 변경을 본다);
 * 2. processNote 가 닫힌 노트에 쓴 것(`noteWrites` → `touchPath`). 열린 노트에 쓴 것은 1 로 온다;
 * 3. 감시자가 알린 `*.labnote.md` 변경(`touchPath`): 앱 밖에서 고친 노트.
 *
 * 때가 되면: 그 노트의 편집기가 조합 중이면 다시 미룬다(조합을 깨지 않는다). README 를 읽을 때까지 기다려(samples.ready)
 * 추적하지 않는 노트는 그만둔다. 글은 열린 편집기의 버퍼, 아니면 fs 에서 읽는다.
 * 알림(읽지 못한 대장, 별칭 겹침)은 세션마다 한 번이다: 세션은 호스트(보관함 화면) 하나다.
 */
import type { EditorView } from '@codemirror/view';
import { noteWrites, openNote } from '../labnote/openNotes';
import { createSampleSyncSession, scheduleSampleSync, syncSamples, type SampleSyncSession } from '../labnote/port/sampleSync';
import { SampleTracking } from './tracking';
import { samples } from './sampleStore';
import type { SampleEnv } from './env';

export const SAMPLE_SYNC_MS = 800;

type SyncView = Pick<EditorView, 'composing' | 'compositionStarted' | 'state'>;
type EnvGetter = () => SampleEnv | undefined;

let getEnv: EnvGetter = () => undefined;

/** 동기화가 쓸 SampleEnv. 때가 될 때마다 부른다(보관함 화면이 바뀌면 App 이 다시 묶는다). undefined 면 아무것도 쓰지 않는다. */
export function setSampleSyncEnv(get: EnvGetter): void {
  getEnv = get;
}

/** 세션(알림을 한 번만 내는 범위)은 보관함 화면의 호스트마다 하나. */
const sessions = new WeakMap<object, SampleSyncSession>();
function sessionFor(env: SampleEnv): SampleSyncSession {
  let s = sessions.get(env.host);
  if (!s) {
    s = createSampleSyncSession();
    sessions.set(env.host, s);
  }
  return s;
}

const composing = (v: SyncView | undefined) => v !== undefined && (v.composing || v.compositionStarted);

/** 쓰기 전의 추적 여부: 설정 && README 의 sample_tracking. README 를 읽을 때까지 기다린다(D11). */
async function trackedForWrite(env: SampleEnv, path: string): Promise<boolean> {
  if (!env.settings().sampleTracking) return false;
  if (samples.configured) return samples.ready(path);
  // 저장소가 아직 묶이지 않았다(설정을 읽기 전): README 를 한 번 읽어 답한다. 설정만으로 쓰지 않는다.
  return new SampleTracking(env.fs, () => undefined).ready(true, path);
}

export class SampleSync {
  /** 때를 기다리는 경로의 타이머(포트의 sampleSyncTimers). 알림 상태는 세션(sessionFor)에 따로 있다. */
  private readonly pending = createSampleSyncSession();
  /** 경로 → touch 가 넘긴 편집기(그 버퍼를 읽는다). */
  private readonly views = new Map<string, SyncView>();
  private readonly running = new Set<Promise<void>>();
  private readonly offWrites: () => void;
  private disposed = false;

  constructor(private readonly delayMs: number = SAMPLE_SYNC_MS) {
    this.offWrites = noteWrites.subscribe((path) => this.touchPath(path));
  }

  /** Editor fast path. */
  touch(path: string, view: SyncView): void {
    if (this.disposed || !path.endsWith('.labnote.md')) return;
    this.views.set(path, view);
    this.schedule(path);
  }

  /** processNote writes and watcher events: the text is read when the timer fires. */
  touchPath(path: string): void {
    if (this.disposed || !path.endsWith('.labnote.md')) return;
    this.views.delete(path);
    this.schedule(path);
  }

  /** 기다리는 동기화를 지금 돌리고(조합 중인 노트는 다시 미룬다), 돌고 있는 것이 모두 끝날 때까지 기다린다. Tests and vault switch. */
  async flush(): Promise<void> {
    for (const [path, handle] of [...this.pending.timers]) {
      clearTimeout(handle);
      this.pending.timers.delete(path);
      this.fire(path);
    }
    while (this.running.size > 0) await Promise.all([...this.running]);
  }

  dispose(): void {
    this.disposed = true;
    this.offWrites();
    for (const handle of this.pending.timers.values()) clearTimeout(handle);
    this.pending.timers.clear();
    this.views.clear();
  }

  private schedule(path: string): void {
    scheduleSampleSync(this.pending, path, () => this.fire(path), this.delayMs);
  }

  /** 편집기 버퍼를 읽을 편집기: 열린 노트의 편집기가 우선이다. 닫힌 편집기의 버퍼는 읽지 않는다(디스크가 기준). */
  private viewFor(path: string): SyncView | undefined {
    const open = openNote(path)?.view();
    if (open) return open;
    const given = this.views.get(path);
    // 진짜 EditorView 는 열린 노트 목록에 있어야 산 편집기다. 목록에 없는 것은 닫혔다.
    return given && !('dom' in given) ? given : undefined;
  }

  private fire(path: string): void {
    if (this.disposed) return;
    const view = this.viewFor(path);
    if (composing(view)) {
      this.schedule(path);
      return;
    }
    // 묶인 env 는 때가 된 순간에 잡는다(그 뒤 보관함이 바뀌어도 이 동기화는 그 보관함의 것이다)
    const env = getEnv();
    this.views.delete(path);
    if (!env) return;
    const run = this.run(env, path, view).finally(() => this.running.delete(run));
    this.running.add(run);
  }

  private async run(env: SampleEnv, path: string, view: SyncView | undefined): Promise<void> {
    try {
      if (!(await trackedForWrite(env, path))) return;
      const live = this.viewFor(path) ?? view;
      const text = live ? live.state.doc.toString() : await env.fs.read(path);
      await syncSamples(env, sessionFor(env), path, text);
    } catch (err) {
      // 읽지 못한 노트(지워졌다) 등: 다음 변경에서 다시 한다
      console.warn('[labnoteo] sample sync failed:', err);
    }
  }
}

/** 앱의 동기화 하나. 만들 때 noteWrites 를 구독한다. */
export const samplesSync = new SampleSync();
