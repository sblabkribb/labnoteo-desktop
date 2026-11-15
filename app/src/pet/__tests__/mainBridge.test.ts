// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN_SKIN } from '../../assistant/skins/builtin';
import type { PetSnapshot } from '../../assistant/petStore';
import type { ChatItem, SessionSnapshot } from '../../assistant/useAssistantSession';
import { createMainBridge, type BridgeIpc } from '../mainBridge';
import { parseAnswer, parseReject, parseState } from '../protocol';

const SECRET = 'sk-SECRET-1234567890-labnote/001_A/private.md';

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

type Avail = 'ok' | 'no-vault' | 'not-configured' | 'busy';

function fakeSession(availability: Avail = 'ok') {
  let snap: SessionSnapshot = { folder: 'labnote/001_A', loading: false, messages: [], summarised: false, streaming: false, notice: null, chip: 'chat' };
  const subs = new Set<() => void>();
  const sends: string[] = [];
  let release: (() => void) | null = null;
  const session = {
    get: () => snap,
    subscribe: (fn: () => void) => {
      subs.add(fn);
      return () => void subs.delete(fn);
    },
    availability: vi.fn(async () => availability),
    setChip: vi.fn((chip: SessionSnapshot['chip']) => {
      snap = { ...snap, chip };
    }),
    send: vi.fn((text: string) => {
      sends.push(text);
      return new Promise<void>((r) => (release = r));
    }),
  };
  const set = (patch: Partial<SessionSnapshot>) => {
    snap = { ...snap, ...patch };
    subs.forEach((fn) => fn());
  };
  const item = (id: string, role: 'user' | 'assistant', text: string, extra: Partial<ChatItem> = {}): ChatItem => ({ id, role, text, sources: [], tainted: false, ...extra });
  return { session, set, sends, finish: () => release?.(), subs, item };
}

function fakeStore(over: Partial<PetSnapshot> = {}) {
  let snap: PetSnapshot = {
    state: 'idle', open: false, pos: { x: 0, y: 0 }, bubble: null, hidden: false, scale: 2, skin: 'flasko', desktop: false, ...over,
  };
  const subs = new Set<() => void>();
  const store = {
    get: () => snap,
    subscribe: (fn: () => void) => {
      subs.add(fn);
      return () => void subs.delete(fn);
    },
    setDesktop: vi.fn((on: boolean) => {
      snap = { ...snap, desktop: on };
      subs.forEach((fn) => fn());
    }),
  };
  const set = (patch: Partial<PetSnapshot>) => {
    snap = { ...snap, ...patch };
    subs.forEach((fn) => fn());
  };
  return { store, set, subs };
}

const flushMicro = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

function setup(opts: { avail?: Avail; start?: unknown; store?: Partial<PetSnapshot>; ready?: Promise<void> } = {}) {
  const i = fakeIpc(opts.start);
  const s = fakeSession(opts.avail);
  const p = fakeStore(opts.store);
  let n = 0;
  const bridge = createMainBridge({
    ipc: i.ipc,
    session: s.session as never,
    store: p.store as never,
    ready: opts.ready ?? Promise.resolve(),
    lang: () => 'en',
    manifest: async () => BUILTIN_SKIN,
    dpr: () => 1,
    newId: () => `local-run-${++n}`,
  });
  return { ...i, s, p, bridge };
}

const ASK = { v: 1, askId: 'ask-12345678', text: 'what is next?' };

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('start and close', () => {
  it('waits for the layout store, then starts the pet with the sprite size, only when not hidden', async () => {
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

  it('{ok:true} sets desktop, {ok:false} does not, and pet:closed brings the in-window sprite back', async () => {
    const good = setup();
    await good.bridge.start();
    await flushMicro();
    expect(good.p.store.get().desktop).toBe(true);
    good.fire('pet:closed', { v: 1 });
    expect(good.p.store.get().desktop).toBe(false);

    const bad = setup({ start: { ok: false, reason: 'x' } });
    await bad.bridge.start();
    await flushMicro();
    expect(bad.p.store.get().desktop).toBe(false);
  });

  it('hiding closes the desktop pet and showing starts it again', async () => {
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
});

describe('mirror out', () => {
  it('emits one pet:state per trailing 120 ms with an increasing seq, all valid, with no vault text in them', async () => {
    const t = setup();
    await t.bridge.start();
    await flushMicro();
    t.s.set({ messages: [t.s.item('u1', 'user', SECRET), t.s.item('a1', 'assistant', SECRET)] });
    t.p.set({ state: 'think' });
    t.p.set({ state: 'talk' });
    expect(t.of('pet:state')).toHaveLength(0);
    vi.advanceTimersByTime(120);
    await flushMicro();
    expect(t.of('pet:state')).toHaveLength(1);
    t.p.set({ state: 'done' });
    vi.advanceTimersByTime(120);
    await flushMicro();
    const states = t.of('pet:state').map((p) => parseState(p));
    expect(states).toHaveLength(2);
    expect(states.every((s) => s !== null)).toBe(true);
    expect(states[1]!.seq).toBeGreaterThan(states[0]!.seq);
    expect(states[1]!.state).toBe('done');
    expect(JSON.stringify(t.emitted)).not.toContain('SECRET');
    expect(t.emitted.every((e) => e.target === 'pet')).toBe(true);
  });

  it('streams pet:answer snapshots of the current assistant item, bounded, done at the end, error flagged', async () => {
    const t = setup();
    await t.bridge.start();
    await flushMicro();
    t.s.set({ messages: [t.s.item('u1', 'user', 'q'), t.s.item('a1', 'assistant', '', { pending: true })], streaming: true });
    t.s.set({ messages: [t.s.item('u1', 'user', 'q'), t.s.item('a1', 'assistant', 'x'.repeat(3000), { pending: true })], streaming: true });
    vi.advanceTimersByTime(120);
    await flushMicro();
    const first = parseAnswer(t.of('pet:answer')[0])!;
    expect(first.done).toBe(false);
    expect([...first.text].length).toBeLessThanOrEqual(1200);
    t.s.set({ messages: [t.s.item('u1', 'user', 'q'), t.s.item('a1', 'assistant', 'final', { error: 'boom' })], streaming: false });
    vi.advanceTimersByTime(120);
    await flushMicro();
    const last = parseAnswer(t.of('pet:answer').at(-1))!;
    expect(last.done).toBe(true);
    expect(last.error).toBe(true);
    const n = t.of('pet:answer').length;
    vi.advanceTimersByTime(500);
    await flushMicro();
    expect(t.of('pet:answer')).toHaveLength(n);
  });

  it('pet:ready answers at once with a full state and, during a run, the answer', async () => {
    const t = setup();
    await t.bridge.start();
    await flushMicro();
    t.s.set({ messages: [t.s.item('a1', 'assistant', 'partial', { pending: true })], streaming: true });
    t.fire('pet:ready', { v: 1 });
    await flushMicro();
    expect(t.of('pet:state')).toHaveLength(1);
    expect(parseAnswer(t.of('pet:answer')[0])?.text).toBe('partial');
    t.fire('pet:ready', { nope: 1 });
    await flushMicro();
    expect(t.of('pet:state')).toHaveLength(1);
  });
});

describe('questions in', () => {
  it('drops invalid payloads silently', async () => {
    const t = setup();
    await t.bridge.start();
    await flushMicro();
    for (const bad of [null, 'x', { v: 2, askId: 'ask-12345678', text: 'q' }, { v: 1, askId: 'x', text: 'q' }, { v: 1, askId: 'ask-12345678', text: '   ' }]) t.fire('pet:ask', bad);
    await flushMicro();
    expect(t.s.session.availability).not.toHaveBeenCalled();
    expect(t.of('pet:reject')).toHaveLength(0);
    expect(t.s.sends).toHaveLength(0);
  });

  it.each(['no-vault', 'not-configured', 'busy'] as const)('rejects with %s and never sends', async (reason) => {
    const t = setup({ avail: reason });
    await t.bridge.start();
    await flushMicro();
    t.fire('pet:ask', ASK);
    await flushMicro();
    expect(parseReject(t.of('pet:reject')[0])).toEqual({ v: 1, askId: ASK.askId, reason });
    expect(t.s.session.send).not.toHaveBeenCalled();
  });

  it('on ok: chip chat once, send once, the reply mirrors with the same askId, a second ask while it runs is busy', async () => {
    const t = setup();
    t.s.session.setChip('howTo' as never);
    t.s.session.setChip.mockClear();
    await t.bridge.start();
    await flushMicro();
    t.fire('pet:ask', ASK);
    await flushMicro();
    expect(t.s.session.setChip).toHaveBeenCalledTimes(1);
    expect(t.s.session.setChip).toHaveBeenCalledWith('chat');
    expect(t.s.sends).toEqual(['what is next?']);

    t.s.set({ messages: [t.s.item('u1', 'user', 'what is next?'), t.s.item('a1', 'assistant', 'soon', { pending: true })], streaming: true });
    vi.advanceTimersByTime(120);
    await flushMicro();
    expect(parseAnswer(t.of('pet:answer').at(-1))?.askId).toBe(ASK.askId);

    t.fire('pet:ask', { ...ASK, askId: 'ask-87654321', text: 'again' });
    await flushMicro();
    expect(parseReject(t.of('pet:reject')[0])).toEqual({ v: 1, askId: 'ask-87654321', reason: 'busy' });
    expect(t.s.sends).toHaveLength(1);

    t.s.set({ messages: [t.s.item('u1', 'user', 'what is next?'), t.s.item('a1', 'assistant', 'soon')], streaming: false });
    t.s.finish();
    await flushMicro();
    vi.advanceTimersByTime(120);
    await flushMicro();
    const done = parseAnswer(t.of('pet:answer').at(-1))!;
    expect(done.done).toBe(true);
    expect(done.askId).toBe(ASK.askId);
  });

  it('does not touch the chip when it is already chat', async () => {
    const t = setup();
    await t.bridge.start();
    await flushMicro();
    t.fire('pet:ask', ASK);
    await flushMicro();
    expect(t.s.session.setChip).not.toHaveBeenCalled();
    expect(t.s.sends).toHaveLength(1);
  });
});

describe('guards', () => {
  it('never raises or focuses the main window, in any scenario', async () => {
    const t = setup();
    await t.bridge.start();
    await flushMicro();
    t.fire('pet:ask', ASK);
    t.fire('pet:ready', { v: 1 });
    t.p.set({ hidden: true });
    t.p.set({ hidden: false });
    t.fire('pet:closed', { v: 1 });
    await flushMicro();
    vi.advanceTimersByTime(1000);
    await flushMicro();
    const cmds = t.invoked.map((c) => c.cmd);
    expect(cmds).not.toContain('pet_open_main');
    expect(cmds.filter((c) => !['pet_start', 'pet_close', 'pet_quiet_get'].includes(c))).toEqual([]);
  });

  it('stop() unlistens and unsubscribes, and nothing is emitted afterwards', async () => {
    const t = setup();
    await t.bridge.start();
    await flushMicro();
    t.s.set({ messages: [t.s.item('a1', 'assistant', 'x', { pending: true })], streaming: true });
    t.bridge.stop();
    await flushMicro();
    expect(new Set(t.unlistened)).toEqual(new Set(['pet:ready', 'pet:ask', 'pet:closed']));
    expect(t.s.subs.size).toBe(0);
    expect(t.p.subs.size).toBe(0);
    vi.advanceTimersByTime(1000);
    t.s.set({ streaming: false });
    t.fire('pet:ready', { v: 1 });
    await flushMicro();
    expect(t.emitted).toHaveLength(0);
  });
});
