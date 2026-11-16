import type { ChipId } from '../assistant/chipMeta';
import type { BubbleActions } from '../assistant/MessageView';
import type { ChatItem, ChipRun, SessionSnapshot, UseAssistantSession } from '../assistant/useAssistantSession';
import type { PetIpc } from './petIpc';
import {
  EVT,
  PANEL_COMMANDS,
  parseChat,
  parsePathList,
  parseResult,
  parseSectionChoices,
  type Call,
  type ChatEvent,
  type WireItem,
} from './protocol';

/** How long a call waits for the main window before it fails (a run is started, not waited for). */
export const CALL_TIMEOUT_MS = 30_000;

const EMPTY: SessionSnapshot = { folder: null, loading: false, messages: [], summarised: false, streaming: false, notice: null, chip: 'chat' };

export interface RemoteDeps {
  ipc: PetIpc;
  newId: () => string;
  /** Asks the person before the conversation is cleared (the desktop window asks inside its own panel). */
  confirmClear: () => Promise<boolean>;
  timeoutMs?: number;
}

export interface Remote {
  /** The conversation the main window mirrors, shaped like the in-window session (the panel draws it unchanged). */
  get(): UseAssistantSession;
  subscribe(fn: () => void): () => void;
  /** The panel's actions, run by the main window. */
  actions: BubbleActions;
  call(method: Call['method'], args?: unknown[]): Promise<unknown>;
  /** Feeds one `pet:chat` / `pet:result` payload in (the page wires the listeners). */
  onChat(raw: unknown): void;
  onResult(raw: unknown): void;
  dispose(): void;
}

function fromWire(w: WireItem): ChatItem {
  const notice = w.notice;
  return {
    id: w.id,
    role: w.role,
    text: w.text,
    sources: w.sources,
    tainted: w.tainted,
    ...(w.pending ? { pending: true } : {}),
    ...(w.status ? { status: w.status } : {}),
    ...(w.error ? { error: w.error } : {}),
    ...(w.errorDetail ? { errorDetail: w.errorDetail } : {}),
    ...(notice ? { notice: () => notice } : {}),
    ...(w.stopped ? { stopped: true } : {}),
  };
}

/**
 * The desktop window's side of the assistant: the panel (Bubble) gets a session and actions with the same shape as in the
 * main window, but every one of them is a call to the main window, which runs the session, the AI and the vault.
 */
export function createRemote(deps: RemoteDeps): Remote {
  const { ipc } = deps;
  const timeout = deps.timeoutMs ?? CALL_TIMEOUT_MS;
  const subs = new Set<() => void>();
  const pending = new Map<string, { resolve(v: unknown): void; reject(e: unknown): void; timer: ReturnType<typeof setTimeout> }>();
  let seq = -1;
  let snap: SessionSnapshot = EMPTY;
  let view: UseAssistantSession | undefined;

  const call = (method: Call['method'], args: unknown[] = []): Promise<unknown> => {
    const id = deps.newId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`pet call ${method} timed out`));
      }, timeout);
      pending.set(id, { resolve, reject, timer });
      void Promise.resolve(ipc.emit(EVT.call, { v: 1, id, method, args })).catch((e: unknown) => {
        clearTimeout(timer);
        pending.delete(id);
        reject(e);
      });
    });
  };

  const emit = () => {
    for (const fn of [...subs]) fn();
  };

  const raiseMain = () => Promise.resolve(ipc.invoke('pet_open_main')).catch(() => undefined);

  // Stable functions: the panel keys its effects on them.
  const session = {
    send: async (text: string) => void (await call('send', [text])),
    stop: () => void call('stop').catch(() => undefined),
    clear: async () => {
      if (!(await deps.confirmClear())) return false;
      return (await call('clear')) === true;
    },
    setChip: (chip: ChipId) => {
      if (snap.chip !== chip) {
        snap = { ...snap, chip };
        view = undefined;
        emit();
      }
      void call('setChip', [chip]).catch(() => undefined);
    },
    runChip: async (run: ChipRun) => {
      const params: Record<string, string> = {};
      for (const [k, v] of Object.entries(run.params)) if (typeof v === 'string') params[k] = v;
      await call('runChip', [{ chip: run.chip, params, line: run.line, text: run.text }]);
    },
    ready: async () => {
      try {
        return (await call('ready')) === true;
      } catch {
        return false;
      }
    },
  };

  const actions: BubbleActions = {
    runCommand: (id: string) => {
      if (!(PANEL_COMMANDS as readonly string[]).includes(id)) return;
      void raiseMain().then(() => call('runCommand', [id])).catch(() => undefined);
    },
    openSource: (src) => {
      void raiseMain().then(() => call('openSource', [src])).catch(() => undefined);
    },
    insert: async (text, tainted) => {
      await raiseMain();
      await call('insert', [text, tainted]);
    },
    sectionChoices: async () => parseSectionChoices(await call('sectionChoices')),
    workflowNotes: async (folder) => parsePathList(await call('workflowNotes', [folder])),
    webSearchConfigured: async () => (await call('webSearchConfigured')) === true,
  };

  return {
    get() {
      return (view ??= { ...snap, ...session });
    },
    subscribe(fn) {
      subs.add(fn);
      return () => void subs.delete(fn);
    },
    actions,
    call,
    onChat(raw) {
      const ev: ChatEvent | null = parseChat(raw);
      if (!ev || ev.seq <= seq) return;
      seq = ev.seq;
      snap = {
        folder: ev.folder,
        loading: ev.loading,
        summarised: ev.summarised,
        streaming: ev.streaming,
        notice: ev.notice,
        chip: ev.chip,
        messages: ev.messages.map(fromWire),
      };
      view = undefined;
      emit();
    },
    onResult(raw) {
      const r = parseResult(raw);
      const p = r && pending.get(r.id);
      if (!r || !p) return;
      clearTimeout(p.timer);
      pending.delete(r.id);
      if (r.ok) p.resolve(r.value);
      else p.reject(new Error('pet call failed'));
    },
    dispose() {
      // Only what is waiting ends here: React may run the page's effects twice (StrictMode) and keep using this object,
      // so a disposed remote must still answer the next call. Subscriptions remove themselves.
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error('disposed'));
      }
      pending.clear();
    },
  };
}
