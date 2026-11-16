// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN_SKIN } from '../../assistant/skins/builtin';
import type { PetSnapshot } from '../../assistant/petStore';
import type { ChatItem, SessionSnapshot } from '../../assistant/useAssistantSession';
import { sectionLabel, sectionOptions } from '../../assistant/SectionPicker';
import { createMainBridge, type BridgeIpc, type MainBridgeDeps } from '../mainBridge';
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
  const chipRuns: unknown[] = [];
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
    runChip: vi.fn((run: unknown) => {
      chipRuns.push(run);
      return new Promise<void>((r) => (release = r));
    }),
    clear: vi.fn(async (_opts?: { confirmed?: boolean }) => true),
  };
  const set = (patch: Partial<SessionSnapshot>) => {
    snap = { ...snap, ...patch };
    subs.forEach((fn) => fn());
  };
  const item = (id: string, role: 'user' | 'assistant', text: string, extra: Partial<ChatItem> = {}): ChatItem => ({ id, role, text, sources: [], tainted: false, ...extra });
  return { session, set, sends, chipRuns, finish: () => release?.(), subs, item };
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

function setup(opts: { avail?: Avail; start?: unknown; store?: Partial<PetSnapshot>; ready?: Promise<void>; context?: MainBridgeDeps['context'] } = {}) {
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
    ...(opts.context ? { context: opts.context, contextMs: 1000 } : {}),
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
  it('emits one pet:state per trailing 120 ms with an increasing seq, all valid; the only conversation text in them is the recent slice', async () => {
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
    // The recent conversation leaves as the only message text: the folder stays a name, the status stays empty.
    expect(states[1]!.recent).toEqual([{ role: 'user', text: SECRET }, { role: 'assistant', text: SECRET }]);
    expect(states[1]!.folder).toBe('001_A');
    expect(states[1]!.status).toBe('');
    expect(t.emitted.every((e) => e.target === 'pet')).toBe(true);
  });

  it('the recent slice is bounded: at most the newest six turns, each text clamped, empty turns skipped', async () => {
    const t = setup();
    await t.bridge.start();
    await flushMicro();
    const messages = Array.from({ length: 20 }, (_, i) => t.s.item(`m${i}`, (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', 'y'.repeat(5000)));
    t.s.set({ messages: [...messages, t.s.item('p1', 'assistant', '', { pending: true, status: 'Working' })], streaming: true });
    vi.advanceTimersByTime(120);
    await flushMicro();
    const st = parseState(t.of('pet:state').at(-1))!;
    expect(st.recent).toHaveLength(6);
    expect(st.recent.every((x) => [...x.text].length <= 1200)).toBe(true);
    expect(st.recent[0].text).toBe('y'.repeat(1199) + '\u2026'); // the oldest kept turn is m14, the pending empty turn is out
    expect(st.status).toBe('Working');
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

describe('a run while there is no desktop pet', () => {
  it('is forgotten: the pet that starts later is not sent an old answer', async () => {
    const t = setup({ start: { ok: false } });
    await t.bridge.start();
    await flushMicro();
    t.s.set({ messages: [t.s.item('u1', 'user', 'q'), t.s.item('a1', 'assistant', 'OLD ANSWER', { pending: true })], streaming: true });
    t.s.set({ messages: [t.s.item('u1', 'user', 'q'), t.s.item('a1', 'assistant', 'OLD ANSWER')], streaming: false });
    vi.advanceTimersByTime(500);
    await flushMicro();
    t.p.set({ desktop: true });
    vi.advanceTimersByTime(500);
    await flushMicro();
    expect(t.of('pet:answer')).toHaveLength(0);
  });

  it('a run that was going when the pet closed is dropped too', async () => {
    const t = setup();
    await t.bridge.start();
    await flushMicro();
    t.s.set({ messages: [t.s.item('u1', 'user', 'q'), t.s.item('a1', 'assistant', 'half', { pending: true })], streaming: true });
    vi.advanceTimersByTime(120);
    await flushMicro();
    t.fire('pet:closed', { v: 1 });
    t.s.set({ messages: [t.s.item('u1', 'user', 'q'), t.s.item('a1', 'assistant', 'half done')], streaming: false });
    vi.advanceTimersByTime(500);
    t.p.set({ desktop: true });
    vi.advanceTimersByTime(500);
    await flushMicro();
    expect(t.of('pet:answer').filter((a) => (a as { done: boolean }).done)).toHaveLength(0);
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
    expect(new Set(t.unlistened)).toEqual(new Set(['pet:ready', 'pet:ask', 'pet:clear', 'pet:closed']));
    expect(t.s.subs.size).toBe(0);
    expect(t.p.subs.size).toBe(0);
    vi.advanceTimersByTime(1000);
    t.s.set({ streaming: false });
    t.fire('pet:ready', { v: 1 });
    await flushMicro();
    expect(t.emitted).toHaveLength(0);
  });
});

const NOTE = 'labnote/001_A/001_wf.md';
const MD = '# Title\n\n## Methods\n\ntext\n\n## Notes\n\nmore\n';
const OPTIONS = sectionOptions(MD, undefined);
const ctx = (over: Partial<NonNullable<MainBridgeDeps['context']>> = {}): NonNullable<MainBridgeDeps['context']> => ({
  activePath: () => NOTE,
  activeNote: async () => ({ path: NOTE, text: MD }),
  workflowNotes: async () => ['labnote/001_A/001_first.md', 'labnote/001_A/002_second.md'],
  ...over,
});
const ask = (o: Record<string, unknown>) => ({ v: 1, askId: 'ask-12345678', text: 'do it', ...o });
const pick = (i: number) => ({ kind: 'pick', index: i, label: sectionLabel(OPTIONS[i]!) });

describe('questions in, by mode', () => {
  it('sets up the section list the test relies on', () => {
    expect(OPTIONS.map((o) => o.heading)).toEqual(['Methods', 'Notes']);
  });

  it('section: runs the section chip with the parameters the panel would send', async () => {
    const t = setup({ context: ctx() });
    await t.bridge.start();
    await flushMicro();
    t.fire('pet:ask', ask({ mode: 'section', text: ' more detail ', section: pick(1) }));
    await flushMicro();
    expect(t.s.chipRuns).toEqual([
      { chip: 'section', params: { documentPath: NOTE, heading: 'Notes', parentHeading: 'Title', existing: 'yes' }, line: 'Notes — more detail', text: 'more detail' },
    ]);
    expect(t.s.session.setChip).toHaveBeenCalledWith('section');
    expect(t.s.sends).toEqual([]);
  });

  it('section: a new title becomes a new section', async () => {
    const t = setup({ context: ctx() });
    await t.bridge.start();
    await flushMicro();
    t.fire('pet:ask', ask({ mode: 'section', text: '', section: { kind: 'new', title: 'Safety' } }));
    await flushMicro();
    expect(t.s.chipRuns).toEqual([{ chip: 'section', params: { documentPath: NOTE, heading: 'Safety', existing: 'no' }, line: 'Safety', text: '' }]);
  });

  it('section: a list that changed since the pet drew it is refused', async () => {
    const t = setup({ context: ctx() });
    await t.bridge.start();
    await flushMicro();
    t.fire('pet:ask', ask({ mode: 'section', section: { kind: 'pick', index: 1, label: 'Something else' } }));
    await flushMicro();
    expect(t.of('pet:reject').map((r) => parseReject(r)?.reason)).toEqual(['invalid']);
    t.fire('pet:ask', ask({ askId: 'ask-87654321', mode: 'section', section: { kind: 'pick', index: 9, label: 'Methods' } }));
    await flushMicro();
    expect(t.of('pet:reject').map((r) => parseReject(r)?.reason)).toEqual(['invalid', 'invalid']);
    expect(t.s.chipRuns).toEqual([]);
  });

  it('section: no open note says so (no-note)', async () => {
    const t = setup({ context: ctx({ activeNote: async () => undefined }) });
    await t.bridge.start();
    await flushMicro();
    t.fire('pet:ask', ask({ mode: 'section', section: pick(0) }));
    await flushMicro();
    expect(parseReject(t.of('pet:reject')[0])?.reason).toBe('no-note');
  });

  it.each(['section', 'unitOp', 'workflow'] as const)('%s outside an experiment says no-note and runs nothing', async (mode) => {
    const t = setup({ context: ctx() });
    t.s.set({ folder: null });
    await t.bridge.start();
    await flushMicro();
    t.fire('pet:ask', ask({ mode, section: pick(0) }));
    await flushMicro();
    expect(parseReject(t.of('pet:reject')[0])?.reason).toBe('no-note');
    expect(t.s.chipRuns).toEqual([]);
  });

  it('unit operation: the open workflow note is the target', async () => {
    const t = setup({ context: ctx() });
    await t.bridge.start();
    await flushMicro();
    t.fire('pet:ask', ask({ mode: 'unitOp', text: 'add PCR cleanup' }));
    await flushMicro();
    expect(t.s.chipRuns).toEqual([{ chip: 'unitOp', params: { documentPath: NOTE }, line: 'add PCR cleanup', text: 'add PCR cleanup' }]);
    expect(t.s.session.setChip).toHaveBeenCalledWith('unitOp');
  });

  it('unit operation: with another note open the first workflow note of the experiment is the target; none says no-workflow', async () => {
    const t = setup({ context: ctx({ activePath: () => 'labnote/001_A/README.md' }) });
    await t.bridge.start();
    await flushMicro();
    t.fire('pet:ask', ask({ mode: 'unitOp', text: 'x' }));
    await flushMicro();
    expect((t.s.chipRuns[0] as { params: unknown }).params).toEqual({ documentPath: 'labnote/001_A/001_first.md' });

    const none = setup({ context: ctx({ activePath: () => 'labnote/001_A/README.md', workflowNotes: async () => [] }) });
    await none.bridge.start();
    await flushMicro();
    none.fire('pet:ask', ask({ mode: 'unitOp', text: 'x' }));
    await flushMicro();
    expect(parseReject(none.of('pet:reject')[0])?.reason).toBe('no-workflow');
    expect(none.s.chipRuns).toEqual([]);
  });

  it('workflow: points at the open note, else the experiment folder', async () => {
    const t = setup({ context: ctx() });
    await t.bridge.start();
    await flushMicro();
    t.fire('pet:ask', ask({ mode: 'workflow', text: 'plasmid cloning' }));
    await flushMicro();
    expect(t.s.chipRuns).toEqual([{ chip: 'workflow', params: { documentPath: NOTE }, line: 'plasmid cloning', text: 'plasmid cloning' }]);
    const bare = setup({ context: ctx({ activePath: () => undefined }) });
    await bare.bridge.start();
    await flushMicro();
    bare.fire('pet:ask', ask({ mode: 'workflow', text: 'x' }));
    await flushMicro();
    expect((bare.s.chipRuns[0] as { params: unknown }).params).toEqual({ documentPath: 'labnote/001_A' });
  });

  it('how to use does not call the model: it is refused as not sendable', async () => {
    const t = setup({ context: ctx() });
    await t.bridge.start();
    await flushMicro();
    t.fire('pet:ask', ask({ mode: 'howTo' }));
    await flushMicro();
    expect(parseReject(t.of('pet:reject')[0])?.reason).toBe('invalid');
    expect(t.s.sends).toEqual([]);
    expect(t.s.chipRuns).toEqual([]);
  });

  it.each(['no-vault', 'not-configured', 'busy'] as const)('every mode is refused with %s when the assistant cannot answer', async (reason) => {
    const t = setup({ avail: reason, context: ctx() });
    await t.bridge.start();
    await flushMicro();
    t.fire('pet:ask', ask({ mode: 'workflow', text: 'x' }));
    await flushMicro();
    expect(parseReject(t.of('pet:reject')[0])?.reason).toBe(reason);
    expect(t.s.chipRuns).toEqual([]);
  });

  it('an unknown mode is dropped like any invalid event', async () => {
    const t = setup({ context: ctx() });
    await t.bridge.start();
    await flushMicro();
    t.fire('pet:ask', ask({ mode: 'shell' }));
    await flushMicro();
    expect(t.s.session.availability).not.toHaveBeenCalled();
  });
});

describe('experiment context out', () => {
  it('the state carries the folder name, the section labels and the target note name only', async () => {
    const t = setup({ context: ctx({ activePath: () => 'labnote/001_A/README.md' }) });
    await t.bridge.start();
    await flushMicro();
    t.fire('pet:ready', { v: 1 });
    await flushMicro();
    vi.advanceTimersByTime(1000);
    await flushMicro();
    vi.advanceTimersByTime(120);
    await flushMicro();
    const last = parseState(t.of('pet:state').at(-1))!;
    expect(last.folder).toBe('001_A');
    expect(last.sections).toEqual(OPTIONS.map(sectionLabel));
    expect(last.unitTarget).toBe('001_first.md');
    expect(JSON.stringify(t.emitted)).not.toContain('labnote/');
  });

  it('a change of the open note reaches the pet within one poll, no change sends nothing more', async () => {
    let md = MD;
    const t = setup({ context: ctx({ activeNote: async () => ({ path: NOTE, text: md }) }) });
    await t.bridge.start();
    await flushMicro();
    vi.advanceTimersByTime(1000);
    await flushMicro();
    vi.advanceTimersByTime(120);
    await flushMicro();
    const n = t.of('pet:state').length;
    vi.advanceTimersByTime(3000);
    await flushMicro();
    expect(t.of('pet:state')).toHaveLength(n);
    md = MD + '\n## Safety\n\nx\n';
    vi.advanceTimersByTime(1000);
    await flushMicro();
    vi.advanceTimersByTime(120);
    await flushMicro();
    expect(parseState(t.of('pet:state').at(-1))!.sections).toContain('Safety');
  });
});

describe('clear in', () => {
  it('pet:clear clears the conversation without a dialog in the main window and never raises it', async () => {
    const t = setup();
    await t.bridge.start();
    await flushMicro();
    t.fire('pet:clear', { v: 1 });
    t.fire('pet:clear', { v: 3 });
    await flushMicro();
    expect(t.s.session.clear).toHaveBeenCalledTimes(1);
    expect(t.s.session.clear).toHaveBeenCalledWith({ confirmed: true });
    expect(t.invoked.map((c) => c.cmd)).not.toContain('pet_open_main');
  });
});
