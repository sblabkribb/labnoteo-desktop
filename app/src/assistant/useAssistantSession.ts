/**
 * 말풍선 대화 한 갈래(assistant spec §4.5, §6.1, plan Task 10).
 *
 * - 열린 노트의 실험 폴더(`folderOfNote`)가 대화의 범위다. 폴더가 바뀌면 진행 중인 실행을 멈추고, 그 폴더의 기록만
 *   새로 읽는다. 앞 폴더의 글은 화면에도, 다음 차례의 런타임에도 가지 않는다(세대 번호 `gen` 이 늦게 끝난 실행을 버린다).
 * - 실험 밖(폴더 없음)에서는 대화가 메모리에만 있고 저장되지 않는다(R3).
 * - 차례 전에 필요하면 기록을 압축하고(`prepare`), 실행이 끝나면 읽을 때 받은 토큰으로 기록을 쓴다. Rust 가
 *   `vaultChanged` 로 거절하면 쓰지 않고 `history.vaultChanged` 를 보인다. 말풍선은 계속 쓸 수 있다.
 * - 멈추기는 실행의 AbortController 를 끊고 도우미를 idle 로 둔다. 멈춘 차례와 오류 난 차례는 저장하지 않는다.
 *
 * - 칩(Task 11B): 고른 칩은 갈래의 상태다(명령이 말풍선을 그 칩으로 연다). 칩 실행(`runChip`)은 대화와 같은 길로 가고,
 *   기록에는 짧은 줄("[섹션 만들기] 결과 섹션")과 답이 칩 표시와 함께 남는다. 사용법은 런타임에 가지 않는다.
 *
 * 상태는 모듈 하나(`assistantSession`)가 갖는다: 말풍선을 닫아도 실행은 이어지고, 명령(assistant.stop,
 * assistant.clearHistory)이 같은 상태를 다룬다. `useAssistantSession` 은 그것을 React 에 잇는다.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { t } from '../i18n/t';
import { confirmDialog } from '../labnote/host/dialogStore';
import { resolveScope } from '../labnote/context/scope';
import { chipNeedsScope, chipRequest, chipUserLine } from './chips';
import type { PreparedHistory } from './compact';
import {
  clearHistory as ipcClear,
  emptyHistory,
  HISTORY_MAX_MESSAGES,
  readHistory as ipcRead,
  writeHistory as ipcWrite,
  type HistoryDoc,
  type HistoryRead,
} from './history';
import { petStore } from './petStore';
import type { AssistantRuntime, AssistantTurn, ChipId, ChipParams, PetState, StoredMessage } from './runtime';
import type { Source } from './sources';

/** 말풍선에 그리는 메시지 하나. 저장된 메시지와 지금 흘러 들어오는 답이 같은 모양이다. */
export interface ChatItem {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  sources: Source[];
  tainted: boolean;
  /** 답이 아직 흘러 들어오는 중. */
  pending?: boolean;
  /** 지금 도구 진행 한 줄(번역됨). */
  status?: string;
  /** 사람에게 보일 오류(번역됨). */
  error?: string;
  /** 오류 아래에 펼쳐 볼 글(생각 고리의 되풀이된 대목). */
  errorDetail?: { label: string; text: string };
  /** 도구 사용 요약 같은 끝 알림: 그릴 때 지금 언어로 만든다. */
  notice?: () => string;
  /** 멈췄다. */
  stopped?: boolean;
}

export interface SessionSnapshot {
  /** 실험 폴더(보관함 상대). null 이면 저장되지 않는 대화. */
  folder: string | null;
  /** 기록을 읽는 중. */
  loading: boolean;
  messages: ChatItem[];
  /** 앞의 대화가 요약으로 접혀 있다("대화 요약됨" 구분선). */
  summarised: boolean;
  streaming: boolean;
  /** 말풍선 머리의 알림(보관함 바뀜, 기록 읽기·쓰기 실패). 번역됨. */
  notice: string | null;
  /** 고른 칩(처음은 대화). */
  chip: ChipId;
}

/** 칩 실행 하나: 사람이 고른 대상(`params`), 기록에 남을 짧은 줄의 내용(`line`), 사람이 쓴 글(`text`). */
export interface ChipRun {
  chip: ChipId;
  params: ChipParams;
  line: string;
  text: string;
}

export interface HistoryIo {
  read(folder: string): Promise<HistoryRead>;
  write(folder: string, token: string, doc: HistoryDoc): Promise<void>;
  clear(folder: string): Promise<void>;
}

export interface SessionDeps {
  /** 지금 쓸 런타임(없으면 보낼 수 없다). */
  runtime?: () => AssistantRuntime | undefined;
  history?: HistoryIo;
  /** 차례 전의 압축(compact.ts `prepareHistory`). 없으면 압축하지 않는다. 취소는 던진다. */
  prepare?: (doc: HistoryDoc, signal: AbortSignal) => Promise<PreparedHistory>;
  setPetState?: (s: PetState) => void;
  /** 기록 지우기 확인. */
  confirm?: (message: string) => Promise<boolean>;
  now?: () => number;
}

export interface AssistantSession {
  get(): SessionSnapshot;
  subscribe(fn: () => void): () => void;
  /** 바꿀 수 있는 의존(런타임, 압축). App 이 명령 맥락을 얻은 뒤 잇는다. 되돌리는 함수를 준다. */
  configure(deps: Pick<SessionDeps, 'runtime' | 'prepare'>): () => void;
  /** 열린 노트가 바뀌었다. 실험 폴더가 달라지면 실행을 멈추고 그 폴더의 기록으로 바꾼다. */
  setActivePath(path: string | undefined): void;
  /** 보낸다. 실행이 끝나면 풀린다(빈 글, 실행 중이면 아무것도 하지 않는다). */
  send(text: string): Promise<void>;
  /** 칩을 고른다. */
  setChip(chip: ChipId): void;
  /** 칩 실행을 보낸다(사용법은 아무것도 하지 않는다). 만들기 칩은 실험 폴더가 없으면 런타임을 부르지 않는다. */
  runChip(run: ChipRun): Promise<void>;
  /** 지금 런타임이 쓸 수 있는지(AI 제공자가 있는지). */
  ready(): Promise<boolean>;
  stop(): void;
  /** 이 폴더의 기록을 확인한 뒤 지운다. 지웠으면 true. 실험 밖이면 화면만 비운다. */
  clear(): Promise<boolean>;
  /** 모든 기록을 지운 뒤(설정 창): 화면을 비운다(저장소는 이미 비었다). */
  forget(): void;
  resetForTest(deps?: SessionDeps): void;
}

/** 노트 경로의 실험 폴더(`labnote/NNN_X`). 실험 밖이면 null. */
export function folderOfNote(path: string | undefined): string | null {
  if (!path) return null;
  try {
    return resolveScope({ activePath: path }, []).folder.normalize('NFC');
  } catch {
    return null;
  }
}

const defaultIo: HistoryIo = {
  read: (folder) => ipcRead(folder),
  write: (folder, token, doc) => ipcWrite(folder, token, doc),
  clear: (folder) => ipcClear(folder),
};

const EMPTY: Omit<SessionSnapshot, 'chip'> = { folder: null, loading: false, messages: [], summarised: false, streaming: false, notice: null };

function toItem(m: StoredMessage): ChatItem {
  return { id: m.id, role: m.role, text: m.text, sources: m.sources ?? [], tainted: !!m.tainted };
}

let idSeq = 0;
function newId(now: number): string {
  idSeq = (idSeq + 1) % 1_000_000;
  return `${now.toString(36)}-${idSeq.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function errorKind(e: unknown): string | undefined {
  return e && typeof e === 'object' && typeof (e as { kind?: unknown }).kind === 'string' ? (e as { kind: string }).kind : undefined;
}

export function createAssistantSession(initial: SessionDeps = {}): AssistantSession {
  let deps: SessionDeps = { ...initial };
  const subs = new Set<() => void>();
  let snap: SessionSnapshot = { ...EMPTY, chip: 'chat' };
  /** 폴더가 바뀔 때마다 는다. 앞 세대의 늦은 결과는 버린다. */
  let gen = 0;
  let activeSet = false;
  let doc: HistoryDoc = emptyHistory('');
  let token: string | null = null;
  let loading: Promise<void> | null = null;
  let run: AbortController | null = null;

  const io = () => deps.history ?? defaultIo;
  const now = () => (deps.now ?? Date.now)();
  const pet = (s: PetState) => (deps.setPetState ?? ((x: PetState) => petStore.setState(x)))(s);
  const emit = (patch: Partial<SessionSnapshot>) => {
    snap = { ...snap, ...patch };
    for (const fn of [...subs]) fn();
  };
  const patchItem = (id: string, patch: Partial<ChatItem> | ((it: ChatItem) => Partial<ChatItem>)) => {
    emit({
      messages: snap.messages.map((it) => (it.id === id ? { ...it, ...(typeof patch === 'function' ? patch(it) : patch) } : it)),
    });
  };

  const abortRun = () => {
    if (!run) return;
    run.abort();
    run = null;
  };

  const load = (folder: string | null) => {
    gen += 1;
    const mine = gen;
    abortRun();
    doc = emptyHistory(folder ?? '');
    token = null;
    loading = null;
    emit({ folder, loading: folder !== null, messages: [], summarised: false, streaming: false, notice: null });
    pet('idle');
    if (folder === null) return;
    loading = io()
      .read(folder)
      .then(
        (r) => {
          if (gen !== mine) return;
          doc = r.doc;
          token = r.token;
          emit({ loading: false, messages: r.doc.messages.map(toItem), summarised: !!r.doc.summary });
        },
        (e: unknown) => {
          if (gen !== mine) return;
          console.warn('[labnoteo] assistant history read failed:', e);
          // Without a token nothing is written: this folder's chat runs unsaved until the next switch.
          emit({ loading: false, notice: t('history.readFailed') });
        }
      )
      .finally(() => {
        if (gen === mine) loading = null;
      });
  };

  /** 차례 하나(대화 또는 칩): `shown` 은 대화 칸과 기록에 남는 내 글, `userText` 는 모델에게 가는 글. */
  const turn = async (req: { shown: string; userText: string; mode: AssistantTurn['mode']; chip?: ChipId }): Promise<void> => {
    const { userText } = req;
    if (snap.streaming) return;
    const runtime = deps.runtime?.();
    const mine = gen;
    const folder = snap.folder;
    const ts = now();
    const userItem: ChatItem = { id: newId(ts), role: 'user', text: req.shown, sources: [], tainted: false };
    const reply: ChatItem = { id: newId(ts), role: 'assistant', text: '', sources: [], tainted: false, pending: true };
    if (!runtime) {
      emit({ messages: [...snap.messages, userItem, { ...reply, pending: false, error: t('ai.configureFirst') }] });
      return;
    }
    const ac = new AbortController();
    run = ac;
    emit({ messages: [...snap.messages, userItem, reply], streaming: true });
    pet('think');
    const live = () => gen === mine && run === ac && !ac.signal.aborted;
    try {
      if (loading) await loading;
      if (gen !== mine) return;
      let base = doc;
      if (deps.prepare) {
        const p = await deps.prepare(doc, ac.signal);
        if (gen !== mine) return;
        base = p.doc;
        if (p.compacted) emit({ summarised: true });
      }
      const turn: AssistantTurn = {
        folder,
        ...(base.summary ? { summary: base.summary.text, summaryTainted: base.summary.tainted } : {}),
        history: base.messages,
        userText,
        mode: req.mode,
      };
      const res = await runtime.run(
        turn,
        {
          state: (s) => {
            if (live()) pet(s);
          },
          delta: (d) => {
            if (live()) patchItem(reply.id, (it) => ({ text: it.text + d, status: undefined }));
          },
          status: (line) => {
            if (live()) patchItem(reply.id, { status: line });
          },
          source: (_n, s) => {
            if (live()) patchItem(reply.id, (it) => ({ sources: [...it.sources, s] }));
          },
          reset: () => {
            if (live()) patchItem(reply.id, { text: '', status: undefined });
          },
        },
        ac.signal
      );
      if (gen !== mine) return;
      if (res.cancelled || ac.signal.aborted) {
        patchItem(reply.id, { pending: false, status: undefined, stopped: true });
        pet('idle');
        return;
      }
      if (res.error) {
        patchItem(reply.id, { pending: false, status: undefined, error: res.error, ...(res.errorDetail ? { errorDetail: res.errorDetail } : {}) });
        pet('idle');
        return;
      }
      const content = res.content || res.notice?.() || '';
      patchItem(reply.id, {
        text: res.content,
        sources: res.sources,
        tainted: res.tainted,
        pending: false,
        status: undefined,
        ...(res.notice ? { notice: res.notice } : {}),
      });
      const doneTs = now();
      const tag = req.chip ? { chip: req.chip } : {};
      const userMsg: StoredMessage = { id: userItem.id, role: 'user', text: req.shown, ts, ...tag };
      const replyMsg: StoredMessage = {
        id: reply.id,
        role: 'assistant',
        text: content,
        ts: doneTs,
        tainted: res.tainted,
        ...(res.sources.length ? { sources: res.sources } : {}),
        ...tag,
        // A turn with no model text that changed nothing is not sent with the next chat turn (compact answeredTurns).
        answered: !!res.content.trim() || res.executed.some((e) => e.outcome === 'done' && e.mutates),
      };
      const messages = [...base.messages, userMsg, replyMsg].slice(-HISTORY_MAX_MESSAGES);
      const next: HistoryDoc = { ...base, folder: folder ?? '', updated: doneTs, messages };
      doc = next;
      if (folder === null || token === null) return;
      try {
        await io().write(folder, token, next);
      } catch (e) {
        if (gen !== mine) return;
        if (errorKind(e) === 'vaultChanged') {
          // The reply finished after a vault switch: it is not written anywhere, and nothing more is written with this token.
          token = null;
          emit({ notice: t('history.vaultChanged') });
        } else {
          console.warn('[labnoteo] assistant history write failed:', e);
          emit({ notice: t('history.writeFailed') });
        }
      }
    } catch (e) {
      if (gen !== mine) return;
      if (ac.signal.aborted) {
        patchItem(reply.id, { pending: false, status: undefined, stopped: true });
      } else {
        console.error('[labnoteo] assistant turn failed:', e);
        patchItem(reply.id, { pending: false, status: undefined, error: t('pet.failed') });
      }
      pet('idle');
    } finally {
      if (run === ac) run = null;
      if (gen === mine && snap.streaming) emit({ streaming: false });
    }
  };

const session: AssistantSession = {
  get: () => snap,
  subscribe(fn) {
    subs.add(fn);
    return () => void subs.delete(fn);
  },
  configure(next) {
    const keys = (['runtime', 'prepare'] as const).filter((k) => k in next);
    const before: Pick<SessionDeps, 'runtime' | 'prepare'> = {};
    for (const k of keys) Object.assign(before, { [k]: deps[k] });
    deps = { ...deps, ...next };
    return () => {
      for (const k of keys) if (deps[k] === next[k]) deps = { ...deps, [k]: before[k] };
    };
  },
  setActivePath(path) {
    const folder = folderOfNote(path);
    if (activeSet && folder === snap.folder) return;
    activeSet = true;
    load(folder);
  },
  send(text) {
    const userText = text.trim();
    if (!userText) return Promise.resolve();
    return turn({ shown: userText, userText, mode: { kind: 'chat' } });
  },
  setChip(chip) {
    if (snap.chip !== chip) emit({ chip });
  },
  runChip(r) {
    if (r.chip === 'howTo') return Promise.resolve();
    if (r.chip === 'chat') return session.send(r.text);
    const shown = chipUserLine(r.chip, r.line);
    if (chipNeedsScope(r.chip) && snap.folder === null) {
      if (snap.streaming) return Promise.resolve();
      const ts = now();
      emit({
        messages: [
          ...snap.messages,
          { id: newId(ts), role: 'user', text: shown, sources: [], tainted: false },
          { id: newId(ts), role: 'assistant', text: '', sources: [], tainted: false, error: t('pet.needExperiment') },
        ],
      });
      return Promise.resolve();
    }
    return turn({
      shown,
      userText: chipRequest(r.chip, r.params, r.text),
      mode: { kind: 'chip', chip: r.chip, params: { ...r.params } },
      chip: r.chip,
    });
  },
  async ready() {
    const runtime = deps.runtime?.();
    if (!runtime) return false;
    try {
      return (await runtime.available()).ok;
    } catch {
      return false;
    }
  },
  stop() {
    if (!run) return;
    abortRun();
    pet('idle');
  },
  async clear() {
    const folder = snap.folder;
    if (folder === null) {
      abortRun();
      doc = emptyHistory('');
      emit({ messages: [], summarised: false, streaming: false, notice: null });
      pet('idle');
      return true;
    }
    const ask =
      deps.confirm ??
      ((message: string) => confirmDialog(message, { confirmLabel: t('history.clearAction'), destructive: true }));
    if (!(await ask(t('history.clearConfirm')))) return false;
    if (snap.folder !== folder) return false;
    const mine = gen;
    abortRun();
    try {
      await io().clear(folder);
    } catch (e) {
      if (gen !== mine) return false;
      console.warn('[labnoteo] assistant history clear failed:', e);
      emit({ notice: t('history.clearFailed'), streaming: false });
      pet('idle');
      return false;
    }
    if (gen !== mine) return false;
    doc = emptyHistory(folder);
    emit({ messages: [], summarised: false, streaming: false, notice: null });
    pet('idle');
    return true;
  },
  forget() {
    abortRun();
    doc = emptyHistory(snap.folder ?? '');
    emit({ messages: [], summarised: false, streaming: false });
    pet('idle');
  },
  resetForTest(next = {}) {
    abortRun();
    deps = { ...next };
    gen += 1;
    activeSet = false;
    doc = emptyHistory('');
    token = null;
    loading = null;
    snap = { ...EMPTY, chip: 'chat' };
    for (const fn of [...subs]) fn();
  },
  };
  return session;
}

/** 앱의 하나뿐인 대화 갈래. */
export const assistantSession: AssistantSession = createAssistantSession();

export interface UseAssistantSession extends SessionSnapshot {
  send(text: string): Promise<void>;
  stop(): void;
  clear(): Promise<boolean>;
  setChip(chip: ChipId): void;
  runChip(run: ChipRun): Promise<void>;
  ready(): Promise<boolean>;
}

/**
 * 말풍선이 쓰는 갈래(plan Task 10): `activePath` 의 실험 폴더 기록을 읽고, 폴더가 바뀌면 멈추고 바꾼다.
 * `runtime` 을 주면 그것을 쓴다(테스트). 없으면 App 이 `configure` 로 이은 런타임.
 */
export function useAssistantSession(opts: {
  activePath: string | undefined;
  runtime?: AssistantRuntime;
  session?: AssistantSession;
}): UseAssistantSession {
  const session = opts.session ?? assistantSession;
  const snap = useSyncExternalStore(session.subscribe, session.get);
  const { runtime } = opts;
  useEffect(() => {
    if (!runtime) return;
    return session.configure({ runtime: () => runtime });
  }, [session, runtime]);
  useEffect(() => {
    session.setActivePath(opts.activePath);
  }, [session, opts.activePath]);
  return {
    ...snap,
    send: session.send,
    stop: session.stop,
    clear: session.clear,
    setChip: session.setChip,
    runChip: session.runChip,
    ready: session.ready,
  };
}
