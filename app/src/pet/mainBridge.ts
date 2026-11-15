import type { PetStore } from '../assistant/petStore';
import { petSize } from '../assistant/petStore';
import { BUILTIN_SKIN } from '../assistant/skins/builtin';
import { loadSkin } from '../assistant/skins/useSkin';
import type { SkinManifest } from '../assistant/skins/types';
import type { AssistantSession } from '../assistant/useAssistantSession';
import { buildChipRun } from '../assistant/chipRun';
import { isWorkflowNotePath, type ChipId } from '../assistant/chips';
import { sectionLabel, sectionOptions, type SectionOption } from '../assistant/SectionPicker';
import { getLang } from '../i18n/lang';
import { buildStateEvent } from './mirror';
import { ANSWER_MAX, clampText, EVT, LABEL_MAX, oneLine, parseAsk, parseClear, parseReady, type AnswerEvent, type AskEvent, type RejectEvent, type RejectReason } from './protocol';

/** The main window's whole window onto Tauri for the pet. Tests inject a fake; `tauriMainIpc` (mainIpc.ts) is the real one. */
export interface BridgeIpc {
  invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>;
  listen(event: string, fn: (payload: unknown) => void): Promise<() => void>;
  emitTo(target: string, event: string, payload: unknown): Promise<void>;
}

export interface MainBridgeDeps {
  ipc: BridgeIpc;
  session: Pick<AssistantSession, 'get' | 'subscribe' | 'availability' | 'setChip' | 'send' | 'runChip' | 'clear'>;
  store: Pick<PetStore, 'get' | 'subscribe' | 'setDesktop'>;
  /** Resolves when the layout store has loaded (the same signal the window show waits for). */
  ready: Promise<unknown>;
  lang?: () => 'ko' | 'en';
  manifest?: (skinId: string) => Promise<SkinManifest>;
  dpr?: () => number;
  newId?: () => string;
  throttleMs?: number;
  /** What the creating modes need from the open note, the same readers the in-window panel gets (BubbleActions). */
  context?: {
    activePath(): string | undefined;
    activeNote?(): Promise<{ path: string; text: string; cursorLine?: number } | undefined>;
    workflowNotes?(folder: string): Promise<string[]>;
  };
  /** How often the open note is looked at while a desktop pet is up (default 1500 ms). */
  contextMs?: number;
}

/** What the creating modes read from the open note, once. */
interface NoteContext {
  note: { path: string; text: string; cursorLine?: number } | undefined;
  options: SectionOption[];
  /** Path of the workflow note a unit operation would go to ('' when none). */
  unitTarget: string;
}

export interface MainBridge {
  start(): Promise<void>;
  stop(): void;
}

export const MIRROR_MS = 120;
export const CONTEXT_MS = 1500;

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
  const contextMs = deps.contextMs ?? CONTEXT_MS;

  let stopped = false;
  let started = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let quiet = false;
  let ctxTimer: ReturnType<typeof setInterval> | undefined;
  let ctxKey = '';
  let ctxSections: string[] = [];
  let ctxUnit = '';
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

  const readContext = async (): Promise<NoteContext> => {
    const c = deps.context;
    const folder = session.get().folder;
    if (!c || folder === null) return { note: undefined, options: [], unitTarget: '' };
    let note: NoteContext['note'];
    try {
      note = (await c.activeNote?.()) ?? undefined;
    } catch {
      note = undefined;
    }
    const options = note ? sectionOptions(note.text, note.cursorLine) : [];
    const open = c.activePath();
    let unitTarget = '';
    if (open && isWorkflowNotePath(open)) unitTarget = open;
    else {
      try {
        unitTarget = (await c.workflowNotes?.(folder))?.[0] ?? '';
      } catch {
        unitTarget = '';
      }
    }
    return { note, options, unitTarget };
  };

  /** Looks at the open note and sends a new state only when what the pet shows (sections, target) changed. */
  const refreshContext = async () => {
    if (stopped || !deps.context || !store.get().desktop || session.get().streaming) return;
    const c = await readContext();
    if (stopped) return;
    const sections = c.options.map(sectionLabel);
    const key = JSON.stringify([session.get().folder, sections, c.unitTarget]);
    if (key === ctxKey) return;
    ctxKey = key;
    ctxSections = sections;
    ctxUnit = c.unitTarget;
    schedule();
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
        folder: snap.folder,
        sections: ctxSections,
        unitTarget: ctxUnit,
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
    // Only mirror a run while a desktop pet exists: an old answer must never reach a pet that starts later.
    if (snap.streaming && !run && store.get().desktop) {
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
    if (!store.get().desktop) run = null;
    const hidden = store.get().hidden;
    if (hidden !== wasHidden) {
      wasHidden = hidden;
      void (hidden ? closePet() : startPet());
    }
    schedule();
  };

  /** The chat send or the chip run for this question, or the reason it cannot run. */
  const plan = async (ask: AskEvent): Promise<{ chip: ChipId; run?: () => Promise<void> } | RejectReason> => {
    if (ask.mode === 'howTo') return 'invalid'; // the how-to card never calls the model
    if (ask.mode === 'chat') return { chip: 'chat', run: () => session.send(ask.text) };
    const folder = session.get().folder;
    if (folder === null || !deps.context) return 'no-note';
    const c = await readContext();
    const activePath = deps.context.activePath();
    let run;
    if (ask.mode === 'section') {
      if (!c.note) return 'no-note';
      const pick = ask.section;
      if (!pick) return 'invalid';
      let section: SectionOption | { heading: string; existing: false } | undefined;
      if (pick.kind === 'new') section = { heading: pick.title, existing: false };
      else {
        const o = c.options[pick.index];
        // Both must still match: the list the pet drew may be older than the note.
        section = o && oneLine(sectionLabel(o), LABEL_MAX) === pick.label ? o : undefined;
      }
      if (!section) return 'invalid';
      run = buildChipRun('section', { text: ask.text, section, notePath: c.note.path, activePath, folder });
    } else if (ask.mode === 'unitOp') {
      if (!c.unitTarget) return 'no-workflow';
      run = buildChipRun('unitOp', { text: ask.text, unitOpTarget: c.unitTarget, activePath, folder });
    } else {
      run = buildChipRun('workflow', { text: ask.text, activePath, folder });
    }
    return run ? { chip: ask.mode, run: () => session.runChip(run) } : 'invalid';
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
      const how = await plan(ask);
      if (stopped) return;
      if (typeof how === 'string') return reject(ask.askId, how);
      if (session.get().chip !== how.chip) session.setChip(how.chip);
      await how.run?.();
      // A turn that never started (nothing streamed) would leave the pet waiting: tell it.
      if (!mine.started && !stopped) reject(ask.askId, 'invalid');
    } catch {
      if (!mine.started && !stopped) reject(ask.askId, 'invalid');
    } finally {
      if (pending === mine) pending = null;
    }
  };

  const onClear = (raw: unknown) => {
    if (!parseClear(raw) || stopped) return;
    // The pet asked the person itself; no dialog opens in this window (it may be minimised, and the pet never raises it).
    void Promise.resolve(session.clear({ confirmed: true })).then(
      () => {
        run = null;
        schedule();
      },
      () => undefined,
    );
  };

  const onReady = (raw: unknown) => {
    if (!parseReady(raw) || stopped || !store.get().desktop) return;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    emitState();
    emitAnswer();
    void refreshContext();
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
        listen(EVT.clear, onClear),
        listen(EVT.closed, () => store.setDesktop(false)),
      ]);
      if (deps.context && contextMs > 0 && !stopped) ctxTimer = setInterval(() => void refreshContext(), contextMs);
      if (stopped || store.get().hidden) return;
      await startPet();
    },
    stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      if (ctxTimer !== undefined) clearInterval(ctxTimer);
      ctxTimer = undefined;
      for (const off of offs.splice(0)) off();
    },
  };
}
