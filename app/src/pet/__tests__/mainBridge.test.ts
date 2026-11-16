// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BubbleActions } from '../../assistant/MessageView';
import type { PetSnapshot } from '../../assistant/petStore';
import { BUILTIN_SKIN } from '../../assistant/skins/builtin';
import type { ChatItem, SessionSnapshot } from '../../assistant/useAssistantSession';
import { t } from '../../i18n/t';
import { createMainBridge, type BridgeIpc } from '../mainBridge';
import { parseChat, parseResult, parseState } from '../protocol';

function fakeIpc(startResult: unknown = { ok: true }) {
  const invoked: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
  const emitted: Array<{ target: string; event: string; payload: unknown }> = [];
  const listeners = new Map<string, Set<(p: unknown) => void>>();
  const unlistened: string[] = [];
  const ipc: BridgeIpc = {
    async invoke(cmd, args) {
      invoked.push({ cmd, args });
      if (cmd === 'pet_start') return startResult;
      if (cmd === 'pet_quiet_get') return false;
      return null;
    },
    async listen(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(fn);
      return () => {
        listeners.get(event)!.delete(fn);
        unlistened.push(event);
      };
    },
    async emitTo(target, event, payload) {
      emitted.push({ target, event, payload });
    },
  };
  const fire = (event: string, payload: unknown) => [...(listeners.get(event) ?? [])].forEach((fn) => fn(payload));
  const of = (event: string) => emitted.filter((e) => e.event === event).map((e) => e.payload);
  return { ipc, invoked, emitted, fire, of, unlistened, listeners };
}

function fakeSession() {
  let snap: SessionSnapshot = { folder: 'labnote/001_A', loading: false, messages: [], summarised: false, streaming: false, notice: null, chip: 'chat' };
  const subs = new Set<() => void>();
  const session = {
    get: () => snap,
    subscribe: (fn: () => void) => {
      subs.add(fn);
      return () => void subs.delete(fn);
    },
    send: vi.fn(() => new Promise<void>(() => {})),
    runChip: vi.fn(() => new Promise<void>(() => {})),
    stop: vi.fn(),
    clear: vi.fn(async (_opts?: { confirmed?: boolean }) => true),
    setChip: vi.fn((chip: SessionSnapshot['chip']) => {
      snap = { ...snap, chip };
    }),
    ready: vi.fn(async () => true),
  };
  const set = (patch: Partial<SessionSnapshot>) => {
    snap = { ...snap, ...patch };
    subs.forEach((fn) => fn());
  };
  const item = (id: string, role: 'user' | 'assistant', text: string, extra: Partial<ChatItem> = {}): ChatItem => ({ id, role, text, sources: [], tainted: false, ...extra });
  return { session, set, item };
}

function fakeStore(over: Partial<PetSnapshot> = {}) {
  let snap: PetSnapshot = { state: 'idle', open: false, pos: { x: 0, y: 0 }, bubble: null, hidden: false, scale: 2, skin: 'flasko', desktop: false, ...over };
  const subs = new Set<() => void>();
  const set = (patch: Partial<PetSnapshot>) => {
    snap = { ...snap, ...patch };
    subs.forEach((fn) => fn());
  };
  const store = {
    get: () => snap,
    subscribe: (fn: () => void) => {
      subs.add(fn);
      return () => void subs.delete(fn);
    },
    setDesktop: vi.fn((on: boolean) => set({ desktop: on })),
    setOpen: vi.fn((open: boolean) => set({ open })),
    setHidden: vi.fn((hidden: boolean) => set({ hidden })),
  };
  return { store, set };
}

const flushMicro = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

function setup(opts: { start?: unknown; store?: Partial<PetSnapshot>; ready?: Promise<void>; actions?: BubbleActions; activePath?: string } = {}) {
  const i = fakeIpc(opts.start);
  const s = fakeSession();
  const p = fakeStore(opts.store);
  const notify = vi.fn();
  const bridge = createMainBridge({
    ipc: i.ipc,
    session: s.session,
    store: p.store as never,
    ready: opts.ready ?? Promise.resolve(),
    actions: opts.actions,
    activePath: () => opts.activePath,
    notify,
    lang: () => 'en',
    manifest: async () => BUILTIN_SKIN,
    dpr: () => 1,
  });
  return { ...i, s, p, bridge, notify };
}

let callN = 0;
const call = (method: string, args: unknown[] = []) => ({ v: 1, id: `call-${String(++callN).padStart(8, '0')}`, method, args });
const resultOf = (t: ReturnType<typeof setup>, id: string) => t.of('pet:result').map(parseResult).find((r) => r?.id === id);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('start and close', () => {
  it('waits for the layout store, then starts the window with the sprite size, only when not hidden', async () => {
    let go!: () => void;
    const ready = new Promise<void>((r) => (go = r));
    const t = setup({ ready });
    void t.bridge.start();
    await flushMicro();
    expect(t.invoked.filter((c) => c.cmd === 'pet_start')).toHaveLength(0);
    go();
    await flushMicro();
    const start = t.invoked.find((c) => c.cmd === 'pet_start')!;
    expect(start.args).toEqual({ spriteW: Math.ceil(BUILTIN_SKIN.frame.width * 2), spriteH: Math.ceil(BUILTIN_SKIN.frame.height * 2) });

    const hidden = setup({ store: { hidden: true } });
    await hidden.bridge.start();
    await flushMicro();
    expect(hidden.invoked.some((c) => c.cmd === 'pet_start')).toBe(false);
  });

  it('a window that does not start turns the assistant off and says so (there is no in-window assistant to fall back to)', async () => {
    const good = setup();
    await good.bridge.start();
    await flushMicro();
    expect(good.p.store.get().desktop).toBe(true);
    expect(good.notify).not.toHaveBeenCalled();

    const bad = setup({ start: { ok: false, reason: 'x' } });
    await bad.bridge.start();
    await flushMicro();
    expect(bad.p.store.get().desktop).toBe(false);
    expect(bad.p.store.get().hidden).toBe(true);
    expect(bad.notify).toHaveBeenCalledWith(t('pet.desktop.failed'));
  });

  it('pet:closed while it should show turns it off and says so; closing it on purpose (hide) says nothing', async () => {
    const t1 = setup();
    await t1.bridge.start();
    await flushMicro();
    t1.fire('pet:closed', { v: 1 });
    expect(t1.p.store.get().desktop).toBe(false);
    expect(t1.p.store.get().hidden).toBe(true);
    expect(t1.notify).toHaveBeenCalledTimes(1);

    const t2 = setup();
    await t2.bridge.start();
    await flushMicro();
    t2.p.set({ hidden: true });
    await flushMicro();
    t2.fire('pet:closed', { v: 1 });
    expect(t2.notify).not.toHaveBeenCalled();
  });

  it('hiding closes the window and showing starts it again', async () => {
    const t = setup();
    await t.bridge.start();
    await flushMicro();
    t.p.set({ hidden: true });
    await flushMicro();
    expect(t.invoked.some((c) => c.cmd === 'pet_close')).toBe(true);
    expect(t.p.store.get().desktop).toBe(false);
    t.p.set({ hidden: false });
    await flushMicro();
    expect(t.invoked.filter((c) => c.cmd === 'pet_start')).toHaveLength(2);
    expect(t.p.store.get().desktop).toBe(true);
  });

  it('stop removes every listener', async () => {
    const t = setup();
    await t.bridge.start();
    await flushMicro();
    t.bridge.stop();
    expect(t.unlistened.sort()).toEqual(['pet:call', 'pet:closed', 'pet:ready']);
  });
});

describe('mirror out', () => {
  it('sends pet:state and pet:chat per trailing 120 ms, with increasing seq, all valid; state carries open and the open note', async () => {
    const t = setup({ activePath: 'labnote/001_A/001_WD010_X.labnote.md' });
    await t.bridge.start();
    await flushMicro();
    t.p.set({ open: true, state: 'think' });
    t.s.set({ messages: [t.s.item('u1', 'user', 'hi'), t.s.item('a1', 'assistant', 'hello', { sources: [{ kind: 'note', label: 'R', target: 'labnote/001_A/README.md' }] })] });
    expect(t.of('pet:state')).toHaveLength(0);
    vi.advanceTimersByTime(120);
    await flushMicro();
    const st = parseState(t.of('pet:state').at(-1))!;
    expect(st).toMatchObject({ open: true, state: 'think', activePath: 'labnote/001_A/001_WD010_X.labnote.md', lang: 'en' });
    const chat = parseChat(t.of('pet:chat').at(-1))!;
    expect(chat.folder).toBe('labnote/001_A');
    expect(chat.messages.map((m) => m.text)).toEqual(['hi', 'hello']);
    expect(chat.messages[1].sources).toEqual([{ kind: 'note', label: 'R', target: 'labnote/001_A/README.md' }]);
    expect(t.emitted.every((e) => e.target === 'pet')).toBe(true);
  });

  it('the end notice goes as words, and an unchanged conversation is not sent again', async () => {
    const t = setup();
    await t.bridge.start();
    await flushMicro();
    t.s.set({ messages: [t.s.item('a1', 'assistant', '', { notice: () => 'Changed 1 note.' })] });
    vi.advanceTimersByTime(120);
    await flushMicro();
    expect(parseChat(t.of('pet:chat').at(-1))!.messages[0].notice).toBe('Changed 1 note.');
    const sent = t.of('pet:chat').length;
    t.p.set({ state: 'idle' });
    vi.advanceTimersByTime(120);
    await flushMicro();
    expect(t.of('pet:chat')).toHaveLength(sent);
  });

  it('pet:ready sends both at once', async () => {
    const t = setup();
    await t.bridge.start();
    await flushMicro();
    t.fire('pet:ready', { v: 1 });
    expect(t.of('pet:state')).toHaveLength(1);
    expect(t.of('pet:chat')).toHaveLength(1);
  });

  it('sends nothing while no window is up', async () => {
    const t = setup({ store: { hidden: true } });
    await t.bridge.start();
    await flushMicro();
    t.s.set({ messages: [t.s.item('u1', 'user', 'hi')] });
    vi.advanceTimersByTime(500);
    expect(t.emitted).toHaveLength(0);
  });
});

describe('calls from the window', () => {
  async function started(opts: Parameters<typeof setup>[0] = {}) {
    const t = setup(opts);
    await t.bridge.start();
    await flushMicro();
    return t;
  }

  it('send and runChip start the run and answer at once', async () => {
    const t = await started();
    const c1 = call('send', ['what next?']);
    t.fire('pet:call', c1);
    await flushMicro();
    expect(t.s.session.send).toHaveBeenCalledWith('what next?');
    expect(resultOf(t, c1.id)).toMatchObject({ ok: true, value: true });
    const run = { chip: 'unitOp', params: { documentPath: 'labnote/001_A/001_WD010_X.labnote.md' }, line: 'PCR', text: 'PCR' };
    const c2 = call('runChip', [run]);
    t.fire('pet:call', c2);
    await flushMicro();
    expect(t.s.session.runChip).toHaveBeenCalledWith(run);
    expect(resultOf(t, c2.id)?.ok).toBe(true);
  });

  it('clear never opens a dialog here; setOpen, hide, stop, setChip and ready reach the store and the session', async () => {
    const t = await started();
    for (const [m, a] of [['clear', []], ['setOpen', [true]], ['stop', []], ['setChip', ['section']], ['ready', []]] as const) t.fire('pet:call', call(m, [...a]));
    await flushMicro();
    expect(t.s.session.clear).toHaveBeenCalledWith({ confirmed: true });
    expect(t.p.store.setOpen).toHaveBeenCalledWith(true);
    expect(t.s.session.stop).toHaveBeenCalled();
    expect(t.s.session.setChip).toHaveBeenCalledWith('section');
    expect(t.s.session.ready).toHaveBeenCalled();
    t.fire('pet:call', call('hide'));
    await flushMicro();
    expect(t.p.store.get().hidden).toBe(true);
  });

  it('the panel actions run here; workflow notes only for the conversation folder', async () => {
    const actions: BubbleActions = {
      sectionChoices: vi.fn(async () => ({ path: 'labnote/001_A/README.md', options: [{ heading: 'Goal', existing: true, planning: false }] })),
      workflowNotes: vi.fn(async (f: string) => [`${f}/001_WD010_X.labnote.md`]),
      webSearchConfigured: vi.fn(async () => true),
      runCommand: vi.fn(),
      openSource: vi.fn(),
      insert: vi.fn(async () => {}),
    };
    const t = await started({ actions });
    const sc = call('sectionChoices');
    const wf = call('workflowNotes', ['labnote/001_A']);
    const other = call('workflowNotes', ['labnote/002_B']);
    const cmd = call('runCommand', ['app.integration-settings']);
    const src = call('openSource', [{ kind: 'web', label: 'x', target: 'https://example.org/' }]);
    const ins = call('insert', ['text', true]);
    for (const c of [sc, wf, other, cmd, src, ins]) t.fire('pet:call', c);
    await flushMicro();
    expect(resultOf(t, sc.id)?.value).toEqual({ path: 'labnote/001_A/README.md', options: [{ heading: 'Goal', existing: true, planning: false }] });
    expect(resultOf(t, wf.id)?.value).toEqual(['labnote/001_A/001_WD010_X.labnote.md']);
    expect(resultOf(t, other.id)?.value).toEqual([]);
    expect(actions.workflowNotes).toHaveBeenCalledTimes(1);
    expect(actions.runCommand).toHaveBeenCalledWith('app.integration-settings');
    expect(actions.openSource).toHaveBeenCalledWith({ kind: 'web', label: 'x', target: 'https://example.org/' });
    expect(actions.insert).toHaveBeenCalledWith('text', true);
  });

  it('a call that is not allowed, or badly shaped, runs nothing and gets no answer', async () => {
    const actions: BubbleActions = { runCommand: vi.fn() };
    const t = await started({ actions });
    for (const c of [
      call('runCommand', ['vault.delete']),
      call('nope'),
      call('send', ['']),
      call('runChip', [{ chip: 'chat', params: {}, line: '', text: '' }]),
      call('setOpen', ['yes']),
      { v: 1, id: 'x', method: 'stop', args: [] },
      { v: 2, id: 'call-zzzzzzzz', method: 'stop', args: [] },
    ])
      t.fire('pet:call', c);
    await flushMicro();
    expect(actions.runCommand).not.toHaveBeenCalled();
    expect(t.s.session.send).not.toHaveBeenCalled();
    expect(t.s.session.runChip).not.toHaveBeenCalled();
    expect(t.s.session.stop).not.toHaveBeenCalled();
    expect(t.of('pet:result')).toHaveLength(0);
  });

  it('an action that fails answers ok:false', async () => {
    const t = await started({ actions: { sectionChoices: async () => Promise.reject(new Error('gone')) } });
    const c = call('sectionChoices');
    t.fire('pet:call', c);
    await flushMicro();
    expect(resultOf(t, c.id)?.ok).toBe(false);
  });
});
