import type { BubbleActions } from '../assistant/MessageView';
import type { PetStore } from '../assistant/petStore';
import { petSize } from '../assistant/petStore';
import { BUILTIN_SKIN } from '../assistant/skins/builtin';
import { loadSkin } from '../assistant/skins/useSkin';
import type { SkinManifest } from '../assistant/skins/types';
import type { AssistantSession, ChatItem } from '../assistant/useAssistantSession';
import { getLang } from '../i18n/lang';
import { t } from '../i18n/t';
import {
  clampText,
  EVT,
  FIELD_MAX,
  LIST_MAX,
  MESSAGES_MAX,
  OPTIONS_MAX,
  parseCall,
  parseReady,
  PATH_MAX,
  SOURCES_MAX,
  STATUS_MAX,
  TEXT_MAX,
  type CallEvent,
  type ChatEvent,
  type ResultEvent,
  type StateEvent,
  type WireItem,
} from './protocol';

/** The main window's whole window onto Tauri for the desktop assistant. Tests inject a fake; `tauriMainIpc` is the real one. */
export interface BridgeIpc {
  invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>;
  listen(event: string, fn: (payload: unknown) => void): Promise<() => void>;
  emitTo(target: string, event: string, payload: unknown): Promise<void>;
}

export interface MainBridgeDeps {
  ipc: BridgeIpc;
  session: Pick<AssistantSession, 'get' | 'subscribe' | 'send' | 'runChip' | 'stop' | 'clear' | 'setChip' | 'ready'>;
  store: Pick<PetStore, 'get' | 'subscribe' | 'setDesktop' | 'setOpen' | 'setHidden'>;
  /** Resolves when the layout store has loaded (the same signal the window show waits for). */
  ready: Promise<unknown>;
  /** The panel's actions, run here for the desktop window (the same readers and commands the panel always used). */
  actions?: BubbleActions;
  /** The open note (vault-relative). */
  activePath?: () => string | undefined;
  /** Tells the person in the main window (a toast) that the desktop assistant could not be shown. */
  notify?: (message: string) => void;
  lang?: () => 'ko' | 'en';
  manifest?: (skinId: string) => Promise<SkinManifest>;
  dpr?: () => number;
  throttleMs?: number;
}

export interface MainBridge {
  start(): Promise<void>;
  stop(): void;
}

export const MIRROR_MS = 120;

/** Increasing across reloads of the main window, so the desktop window never ignores a fresh snapshot as stale. */
let seqCounter = Date.now();
const nextSeq = (): number => ++seqCounter;

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

/** One chat item as the desktop panel draws it (bounded; the end notice in words). Cached per item object. */
const wireCache = new WeakMap<ChatItem, WireItem>();
export function toWire(m: ChatItem): WireItem {
  const hit = wireCache.get(m);
  if (hit) return hit;
  const notice = m.notice?.();
  const w: WireItem = {
    id: m.id,
    role: m.role,
    text: clampText(m.text, TEXT_MAX),
    sources: m.sources.slice(0, SOURCES_MAX).map((s) => ({ kind: s.kind, label: clampText(s.label, FIELD_MAX), target: clampText(s.target, FIELD_MAX) })),
    tainted: m.tainted,
    ...(m.pending ? { pending: true } : {}),
    ...(m.status ? { status: clampText(m.status, STATUS_MAX) } : {}),
    ...(m.error ? { error: clampText(m.error, FIELD_MAX) } : {}),
    ...(m.errorDetail ? { errorDetail: { label: clampText(m.errorDetail.label, STATUS_MAX), text: clampText(m.errorDetail.text, TEXT_MAX) } } : {}),
    ...(notice ? { notice: clampText(notice, FIELD_MAX) } : {}),
    ...(m.stopped ? { stopped: true } : {}),
  };
  // A notice is drawn in the language of the moment: only cache items without one.
  if (!m.notice) wireCache.set(m, w);
  return w;
}

/**
 * The desktop assistant window draws the assistant panel; this window runs it. It sends the sprite state and the whole
 * conversation (bounded) to the desktop window and answers its calls with the session, the pet store and the panel actions.
 * It never raises or focuses this window: the desktop window raises it itself before a call that opens something here.
 */
export function createMainBridge(deps: MainBridgeDeps): MainBridge {
  const { ipc, session, store } = deps;
  const lang = deps.lang ?? getLang;
  const manifest = deps.manifest ?? defaultManifest;
  const dpr = deps.dpr ?? (() => (typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1));
  const throttle = deps.throttleMs ?? MIRROR_MS;

  let stopped = false;
  let started = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let quiet = false;
  let wasHidden = store.get().hidden;
  let epoch = 0;
  let lastChat: unknown = null;
  let lastPath: string | undefined;
  const offs: Array<() => void> = [];

  const send = (event: string, payload: unknown) => {
    if (stopped) return;
    void Promise.resolve(ipc.emitTo('pet', event, payload)).catch(() => undefined);
  };

  const emitState = () => {
    const pet = store.get();
    const payload: StateEvent = {
      v: 1,
      seq: nextSeq(),
      state: pet.state,
      skin: pet.skin,
      scale: pet.scale,
      busy: session.get().streaming,
      lang: lang(),
      quiet,
      open: pet.open,
      activePath: clampText(deps.activePath?.() ?? '', PATH_MAX),
    };
    send(EVT.state, payload);
  };

  const emitChat = (force = false) => {
    const snap = session.get();
    if (!force && snap === lastChat) return;
    lastChat = snap;
    const payload: ChatEvent = {
      v: 1,
      seq: nextSeq(),
      folder: snap.folder,
      loading: snap.loading,
      summarised: snap.summarised,
      streaming: snap.streaming,
      notice: snap.notice,
      chip: snap.chip,
      messages: snap.messages.slice(-MESSAGES_MAX).map(toWire),
    };
    send(EVT.chat, payload);
  };

  const flush = () => {
    timer = undefined;
    if (stopped || !store.get().desktop) return;
    emitState();
    emitChat();
  };
  const schedule = () => {
    if (stopped || timer !== undefined) return;
    timer = setTimeout(flush, throttle);
  };

  const failed = () => {
    // Nothing draws the assistant now: keep it off until the person turns it on again (ribbon, command), and say so.
    if (!store.get().hidden) store.setHidden(true);
    wasHidden = true;
    deps.notify?.(t('pet.desktop.failed'));
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
      res = null;
    }
    if (stopped || mine !== epoch) return;
    if ((res as { ok?: unknown } | null)?.ok !== true) {
      failed();
      return;
    }
    store.setDesktop(true);
    try {
      quiet = (await ipc.invoke('pet_quiet_get')) === true;
    } catch {
      quiet = false;
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

  const onSession = () => schedule();

  /** The answer to one call. Long runs (send, a chip run) are started, not waited for: the conversation shows their progress. */
  const answer = async (c: CallEvent): Promise<unknown> => {
    const a = deps.actions;
    switch (c.method) {
      case 'send':
        void session.send(c.args[0]);
        return true;
      case 'runChip':
        void session.runChip({ ...c.args[0] });
        return true;
      case 'stop':
        session.stop();
        return true;
      case 'clear':
        // The desktop window asked the person itself; no dialog opens here (this window may be minimised).
        return session.clear({ confirmed: true });
      case 'setChip':
        session.setChip(c.args[0]);
        return true;
      case 'setOpen':
        store.setOpen(c.args[0]);
        return true;
      case 'hide':
        store.setHidden(true);
        return true;
      case 'ready':
        return session.ready();
      case 'sectionChoices': {
        const r = await a?.sectionChoices?.();
        return r ? { path: r.path, options: r.options.slice(0, OPTIONS_MAX) } : null;
      }
      case 'workflowNotes': {
        // Only the experiment the conversation is in.
        const folder = session.get().folder;
        if (!folder || c.args[0] !== folder) return [];
        return ((await a?.workflowNotes?.(folder)) ?? []).slice(0, LIST_MAX);
      }
      case 'webSearchConfigured':
        return (await a?.webSearchConfigured?.()) ?? false;
      case 'runCommand':
        a?.runCommand?.(c.args[0]);
        return true;
      case 'openSource':
        a?.openSource?.(c.args[0]);
        return true;
      case 'insert':
        await a?.insert?.(c.args[0], c.args[1]);
        return true;
    }
  };

  const onCall = async (raw: unknown) => {
    const c = parseCall(raw);
    if (!c || stopped) return;
    let result: ResultEvent;
    try {
      result = { v: 1, id: c.id, ok: true, value: (await answer(c)) ?? null };
    } catch (err) {
      console.warn('[labnoteo] desktop assistant call failed:', c.method, err);
      result = { v: 1, id: c.id, ok: false };
    }
    send(EVT.result, result);
    schedule();
  };

  const onReady = (raw: unknown) => {
    if (!parseReady(raw) || stopped || !store.get().desktop) return;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    emitState();
    emitChat(true);
  };

  const onClosed = () => {
    const desktop = store.get().desktop;
    store.setDesktop(false);
    // Closed while it should be showing (it crashed, or could not draw its skin): nothing else draws the assistant.
    if (desktop && !store.get().hidden && !stopped) failed();
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
      await Promise.all([listen(EVT.ready, onReady), listen(EVT.call, (p) => void onCall(p)), listen(EVT.closed, onClosed)]);
      // The open note changes the panel's section list and unit operation target: send it when it changes.
      const pathTimer = setInterval(() => {
        const p = deps.activePath?.();
        if (p !== lastPath) {
          lastPath = p;
          schedule();
        }
      }, 300);
      offs.push(() => clearInterval(pathTimer));
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
