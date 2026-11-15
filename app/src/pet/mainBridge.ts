import type { PetStore } from '../assistant/petStore';
import { petSize } from '../assistant/petStore';
import { BUILTIN_SKIN } from '../assistant/skins/builtin';
import { loadSkin } from '../assistant/skins/useSkin';
import type { SkinManifest } from '../assistant/skins/types';
import type { AssistantSession } from '../assistant/useAssistantSession';
import { getLang } from '../i18n/lang';
import { buildStateEvent } from './mirror';
import { ANSWER_MAX, clampText, EVT, parseAsk, parseReady, type AnswerEvent, type RejectEvent, type RejectReason } from './protocol';

/** The main window's whole window onto Tauri for the pet. Tests inject a fake; `tauriMainIpc` (petIpc.ts) is the real one. */
export interface BridgeIpc {
  invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>;
  listen(event: string, fn: (payload: unknown) => void): Promise<() => void>;
  emitTo(target: string, event: string, payload: unknown): Promise<void>;
}

export interface MainBridgeDeps {
  ipc: BridgeIpc;
  session: Pick<AssistantSession, 'get' | 'subscribe' | 'availability' | 'setChip' | 'send'>;
  store: Pick<PetStore, 'get' | 'subscribe' | 'setDesktop'>;
  /** Resolves when the layout store has loaded (the same signal the window show waits for). */
  ready: Promise<unknown>;
  lang?: () => 'ko' | 'en';
  manifest?: (skinId: string) => Promise<SkinManifest>;
  dpr?: () => number;
  newId?: () => string;
  throttleMs?: number;
}

export interface MainBridge {
  start(): Promise<void>;
  stop(): void;
}

export const MIRROR_MS = 120;

/** Increasing across reloads of the main window, so the pet never ignores a fresh snapshot as stale. */
let seqCounter = Date.now();
const nextSeq = (): number => ++seqCounter;

let idCounter = 0;
const defaultNewId = (): string => `run-${Date.now().toString(36)}-${(++idCounter).toString(36)}`;

async function defaultManifest(id: string): Promise<SkinManifest> {
  try {
    const skin = await loadSkin(id);
    const manifest = skin.manifest;
    skin.dispose();
    return manifest;
  } catch {
    return BUILTIN_SKIN;
  }
}

/**
 * Mirrors the assistant that runs in this window to the desktop pet window and answers the pet's questions.
 * It sends only the sprite state, a status line while a run is going and the current answer text (all bounded);
 * it never raises or focuses this window and never calls `pet_open_main`.
 */
export function createMainBridge(deps: MainBridgeDeps): MainBridge {
  const { ipc, session, store } = deps;
  const lang = deps.lang ?? getLang;
  const manifest = deps.manifest ?? defaultManifest;
  const dpr = deps.dpr ?? (() => (typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1));
  const newId = deps.newId ?? defaultNewId;
  const throttle = deps.throttleMs ?? MIRROR_MS;

  let stopped = false;
  let started = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let quiet = false;
  let wasHidden = store.get().hidden;
  let epoch = 0;
  const offs: Array<() => void> = [];
  /** The run being mirrored: which chat item holds the answer and the id the pet knows it by. */
  let run: { itemId: string | null; askId: string } | null = null;
  /** The question accepted from the pet that has not finished yet (one at a time). */
  let pending: { askId: string; started: boolean } | null = null;

  const send = (event: string, payload: unknown) => {
    if (stopped) return;
    void Promise.resolve(ipc.emitTo('pet', event, payload)).catch(() => undefined);
  };
  const reject = (askId: string, reason: RejectReason) => {
    const payload: RejectEvent = { v: 1, askId, reason };
    send(EVT.reject, payload);
  };

  const emitState = () => {
    const snap = session.get();
    const pet = store.get();
    send(
      EVT.state,
      buildStateEvent({
        seq: nextSeq(),
        pet: { state: pet.state, skin: pet.skin, scale: pet.scale },
        // Only the status line of a run in progress; no message text leaves this window here.
        items: snap.messages.map((m) => ({ role: m.role, text: '', status: snap.streaming ? m.status : undefined })),
        streaming: snap.streaming,
        lang: lang(),
        quiet,
      }),
    );
  };

  const emitAnswer = () => {
    if (!run) return;
    const snap = session.get();
    const item = run.itemId === null ? undefined : snap.messages.find((m) => m.id === run!.itemId);
    if (!item) {
      run = null; // the folder changed under the run
      return;
    }
    const payload: AnswerEvent = {
      v: 1,
      seq: nextSeq(),
      askId: run.askId,
      text: clampText(item.text || item.error || '', ANSWER_MAX),
      done: !snap.streaming,
      error: !!item.error,
    };
    send(EVT.answer, payload);
    if (!snap.streaming) run = null;
  };

  const flush = () => {
    timer = undefined;
    if (stopped || !store.get().desktop) return;
    emitState();
    emitAnswer();
  };
  const schedule = () => {
    if (stopped || timer !== undefined) return;
    timer = setTimeout(flush, throttle);
  };

  const onSession = () => {
    const snap = session.get();
    if (snap.streaming && !run) {
      const last = [...snap.messages].reverse().find((m) => m.role === 'assistant');
      run = { itemId: last?.id ?? null, askId: pending?.askId ?? newId() };
      if (pending) pending.started = true;
    }
    schedule();
  };

  const startPet = async () => {
    const mine = ++epoch;
    const pet = store.get();
    const size = petSize(pet.scale, await manifest(pet.skin), dpr());
    if (stopped || mine !== epoch || store.get().hidden) return;
    let res: unknown;
    try {
      res = await ipc.invoke('pet_start', { spriteW: size.w, spriteH: size.h });
    } catch {
      return;
    }
    if (stopped || mine !== epoch) return;
    if ((res as { ok?: unknown } | null)?.ok === true) {
      store.setDesktop(true);
      try {
        quiet = (await ipc.invoke('pet_quiet_get')) === true;
      } catch {
        quiet = false;
      }
    }
  };

  const closePet = async () => {
    epoch += 1;
    try {
      await ipc.invoke('pet_close');
    } catch {
      /* the window may already be gone */
    }
    if (!stopped) store.setDesktop(false);
  };

  const onStore = () => {
    const hidden = store.get().hidden;
    if (hidden !== wasHidden) {
      wasHidden = hidden;
      void (hidden ? closePet() : startPet());
    }
    schedule();
  };

  const onAsk = async (raw: unknown) => {
    const ask = parseAsk(raw);
    if (!ask) return;
    if (pending) return reject(ask.askId, 'busy');
    const mine = { askId: ask.askId, started: false };
    pending = mine;
    try {
      const avail = await session.availability();
      if (stopped) return;
      if (avail !== 'ok') return reject(ask.askId, avail);
      if (session.get().chip !== 'chat') session.setChip('chat');
      await session.send(ask.text);
      // A turn that never started (nothing streamed) would leave the pet waiting: tell it.
      if (!mine.started && !stopped) reject(ask.askId, 'invalid');
    } catch {
      if (!mine.started && !stopped) reject(ask.askId, 'invalid');
    } finally {
      if (pending === mine) pending = null;
    }
  };

  const onReady = (raw: unknown) => {
    if (!parseReady(raw) || stopped || !store.get().desktop) return;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    emitState();
    emitAnswer();
  };

  const listen = async (event: string, fn: (p: unknown) => void) => {
    const off = await ipc.listen(event, fn);
    if (stopped) off();
    else offs.push(off);
  };

  return {
    async start() {
      if (started) return;
      started = true;
      await Promise.resolve(deps.ready).catch(() => undefined);
      if (stopped) return;
      offs.push(session.subscribe(onSession), store.subscribe(onStore));
      await Promise.all([
        listen(EVT.ready, onReady),
        listen(EVT.ask, (p) => void onAsk(p)),
        listen(EVT.closed, () => store.setDesktop(false)),
      ]);
      if (stopped || store.get().hidden) return;
      await startPet();
    },
    stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      for (const off of offs.splice(0)) off();
    },
  };
}
