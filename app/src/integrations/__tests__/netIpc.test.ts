import { readFileSync } from 'node:fs';
import {
  NET_ERROR_KINDS,
  NetError,
  bfwGenerateNotes,
  cancelAllRequests,
  llmChat,
  setSecret,
  toNetError,
  vaultGuard,
  vaultSignal,
  type ListenFn,
  type NotesProgress,
} from '../netIpc';
import { fakeInvoke, netError, secretStatusOf } from './fakeNet';

describe('netIpc', () => {
  it('toNetError keeps kind, status and body', () => {
    const e = toNetError({ kind: 'status', message: 'HTTP 401', status: 401, body: 'no' });
    expect(e).toBeInstanceOf(NetError);
    expect([e.kind, e.status, e.body]).toEqual(['status', 401, 'no']);
    expect(toNetError(new Error('x')).kind).toBe('badInput');
  });

  it('toNetError passes a NetError through and maps an unknown kind to badInput', () => {
    const n = netError('redirect', { location: 'https://b.example' });
    expect(toNetError(n)).toBe(n);
    expect(n.location).toBe('https://b.example');
    expect(toNetError({ kind: 'mystery', message: 'm' }).kind).toBe('badInput');
    expect(toNetError('plain').kind).toBe('badInput');
  });

  it('NET_ERROR_KINDS lists the 17 kinds Rust serializes', () => {
    const pinned = JSON.parse(readFileSync('src-tauri/tests/ipc-net-errors.json', 'utf-8')) as Record<string, string>;
    expect(NET_ERROR_KINDS).toHaveLength(17);
    expect([...NET_ERROR_KINDS].sort()).toEqual(Object.values(pinned).sort());
  });

  it('abort signal calls net_cancel with the request id and rejects at once', async () => {
    const f = fakeInvoke({ llm_chat: () => new Promise(() => {}), net_cancel: () => true }); // Rust never answers
    const ac = new AbortController();
    const p = llmChat({ provider: 'ollama', body: {}, signal: ac.signal }, f.invoke);
    ac.abort();
    await expect(p).rejects.toMatchObject({ kind: 'cancelled' });
    const id = f.calls.find(([c]) => c === 'llm_chat')![1].requestId;
    expect(typeof id).toBe('string');
    expect(f.calls).toContainEqual(['net_cancel', { requestId: id }]);
  });

  it('an already aborted signal invokes nothing', async () => {
    const f = fakeInvoke({ llm_chat: () => ({ status: 200, text: '{}' }) });
    const ac = new AbortController();
    ac.abort();
    await expect(llmChat({ provider: 'ollama', body: {}, signal: ac.signal }, f.invoke)).rejects.toMatchObject({
      kind: 'cancelled',
    });
    expect(f.calls).toEqual([]);
  });

  it('a Rust rejection becomes a NetError', async () => {
    const f = fakeInvoke({
      llm_chat: () => {
        throw { kind: 'timeout', message: 'raw-rust-text' };
      },
    });
    const err = await llmChat({ provider: 'openai', body: {} }, f.invoke).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetError);
    expect((err as NetError).kind).toBe('timeout');
  });

  it('cancelAllRequests cancels every open request and none twice', async () => {
    const f = fakeInvoke({ llm_chat: () => new Promise(() => {}), net_cancel: () => true });
    const ac = new AbortController();
    const a = llmChat({ provider: 'ollama', body: {}, signal: ac.signal }, f.invoke);
    const b = llmChat({ provider: 'openai', body: {} }, f.invoke);
    await cancelAllRequests(f.invoke);
    await expect(a).rejects.toMatchObject({ kind: 'cancelled' });
    await expect(b).rejects.toMatchObject({ kind: 'cancelled' });
    ac.abort(); // 이미 취소한 요청을 다시 취소하지 않는다
    const ids = f.calls.filter(([c]) => c === 'llm_chat').map(([, args]) => String(args.requestId));
    const cancels = f.calls.filter(([c]) => c === 'net_cancel').map(([, args]) => String(args.requestId));
    expect(new Set(ids).size).toBe(2);
    expect(cancels.sort()).toEqual([...ids].sort());

    const g = fakeInvoke({ llm_chat: () => ({ status: 200, text: 'ok' }), net_cancel: () => true });
    await expect(llmChat({ provider: 'ollama', body: {} }, g.invoke)).resolves.toEqual({ status: 200, text: 'ok' });
    await cancelAllRequests(g.invoke);
    expect(g.calls.filter(([c]) => c === 'net_cancel')).toEqual([]);
  });

  it('cancelAllRequests aborts vaultSignal and a fresh signal follows', async () => {
    const before = vaultSignal();
    await cancelAllRequests(fakeInvoke({}).invoke);
    expect(before.aborted).toBe(true);
    expect(vaultSignal().aborted).toBe(false);
  });

  it('vaultGuard.check throws cancelled after the vault root changes', async () => {
    let root = 'C:/A';
    const f = fakeInvoke({ vault_current: () => ({ root, name: 'A' }) });
    const g = await vaultGuard(f.invoke);
    expect(g.root).toBe('C:/A');
    await g.check();
    root = 'C:/B';
    await expect(g.check()).rejects.toMatchObject({ kind: 'cancelled' });
  });

  it('vaultGuard.check throws cancelled after cancelAllRequests', async () => {
    const f = fakeInvoke({ vault_current: () => ({ root: 'C:/A', name: 'A' }) });
    const g = await vaultGuard(f.invoke);
    await cancelAllRequests(f.invoke);
    expect(g.signal.aborted).toBe(true);
    await expect(g.check()).rejects.toMatchObject({ kind: 'cancelled' });
  });

  it('setSecret never echoes the value in a rejection', async () => {
    const f = fakeInvoke({
      secret_set: () => {
        throw { kind: 'badInput', message: 'bad key' };
      },
    });
    await expect(setSecret('partbankWeb', 'pbk_zzz', f.invoke)).rejects.not.toHaveProperty(
      'message',
      expect.stringContaining('pbk_zzz'),
    );
  });

  it('bfwGenerateNotes forwards only its own progress events', async () => {
    let handler: ((e: { payload: NotesProgress }) => void) | undefined;
    let unlistened = 0;
    let event = '';
    const listen = (async (name: string, h: (e: { payload: NotesProgress }) => void) => {
      event = name;
      handler = h;
      return () => {
        unlistened += 1;
      };
    }) as unknown as ListenFn;
    const f = fakeInvoke({
      bfw_generate_notes: (args) => {
        handler!({ payload: { requestId: 'other', step: 'start', message: 'x' } });
        handler!({ payload: { requestId: String(args.requestId), step: 'draft', message: 'y' } });
        return { notes: [] };
      },
    });
    const seen: NotesProgress[] = [];
    const out = await bfwGenerateNotes(
      { design: { a: 1 }, language: 'ko', perWorkflow: true, onProgress: (p) => seen.push(p) },
      f.invoke,
      listen,
    );
    expect(out).toEqual({ notes: [] });
    expect(event).toBe('bfworkflow://notes');
    expect(seen.map((p) => p.step)).toEqual(['draft']);
    expect(unlistened).toBe(1);
  });

  it('secretStatusOf fills the missing slots', () => {
    expect(secretStatusOf({ partbankWeb: true }, { partbankWeb: 2 })).toEqual({
      set: { partbankDesktop: false, partbankWeb: true, llmOpenai: false, bfwServer: false, bfwDesktop: false },
      epoch: { partbankDesktop: 0, partbankWeb: 2, llmOpenai: 0, bfwServer: 0, bfwDesktop: 0 },
    });
  });
});
